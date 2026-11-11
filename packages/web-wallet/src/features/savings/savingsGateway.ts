/**
 * Savings for the browser: the pinned deployment's Sky savings composed over the rails a withdrawal
 * uses. A move burns into a Sky escrow through `runBurn`; Main's relayer releases and runs the
 * escrow; the settle pass claims its deposit on the destination token. Nothing here calls a
 * contract itself.
 */
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  nextOperationId,
  registerBroadcaster,
  type ObsidionAccount,
  type ObsidionWallet,
  type RegisteredTeeSigner,
  type TokenService,
} from "@obsidion/sdk"
import {
  assertSkyFactoryPortals,
  balanceScope,
  buildSavingsMove,
  quoteSavingsMove,
  readSavingsApy,
  resolveSkySavings,
  savingsSourceExecutor,
  savingsValue,
  settleSavingsMoves,
  skyBridgesOfFactory,
  SKY_PROJECT,
  tupleField,
  type QueryEntry,
  type QueryFactory,
  type QueryState,
  type SavingsDirection,
  type SavingsExecutorReads,
  type SavingsMoveRecord,
  type SavingsMoves,
  type SavingsMoveStage,
  type SavingsPrice,
  type SavingsQuote,
  type SavingsSource,
  type SkySavings,
  type WithdrawalRecord,
  type Withdrawals,
  useStore,
  memoryStore,
} from "@obsidion/front-core"
import { formatUnits, type Address, type Hex } from "viem"
import { usdAtomicFloor } from "../../ui/format"
import { ASSET_TUPLE_TIMEOUT_MS, l1PublicClient } from "../../config/oxideTuple"
import { withTimeout } from "../../lib/withTimeout"
import {
  assertWithinWithdrawalLimit,
  sharesBurnLimitProblem,
  withdrawalLimitRefusal,
} from "../limits/withdrawalLimit"
import { claimSponsorContext, type ClaimSponsorDeps } from "../registration/claimSponsorship"
import { RAIL_REGISTERED } from "../registration/rails"
import { runOperation, type OperationHandle } from "../operations/operations"
import {
  noteSponsoredMine,
  sessionSwapRecoverer,
  runBurn,
  withdrawalOptions,
  type BurnSession,
  type RescanToken,
} from "../withdraw/withdrawGateway"
import { SavingsQuoteChangedError } from "./quoteChanged"
import { exitSharePrice } from "./savingsTasks"
import { l2TokenService } from "../token/l2TokenService"
import { accountKitOf, useSession, type AccountKit, type Session } from "../../session/session"
import type { PageFacts, PageChain } from "../../session/pageChain"

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Sky savings on the pinned deployment, its Main the pinned bridge itself; undefined where the
 * deployment names none, or pairs Savings with another bridge than the one Main holds.
 */
export function readSkySavings({ config, chain }: PageFacts): Promise<SkySavings | undefined> {
  const read = async () => {
    const [{ deployment }, pinned] = await Promise.all([
      chain.oxideDeployment.read(),
      chain.oxideTuple.read(),
    ])
    const found = await resolveSkySavings(l1PublicClient(config), deployment, () =>
      chain.manifestDeployments.read(),
    )
    if (!found) return undefined
    if (!sameAddress(found.deployments.main.portal, pinned.portal)) {
      console.warn(
        `[savingsGateway] Sky savings pairs ${found.deployments.main.portal}, not the pinned portal ${pinned.portal}`,
      )
      return undefined
    }
    return { ...found, deployments: { ...found.deployments, main: pinned } }
  }
  return withTimeout(read(), ASSET_TUPLE_TIMEOUT_MS)
}

/** The Savings bridge; undefined where the pinned deployment has none, and nothing then shows. */
export async function savingsTuple(
  reads: Pick<PageChain, "skySavings">,
): Promise<OxideEnvTuple | null> {
  return (await reads.skySavings.read())?.deployments.savings ?? null
}

export async function readLiveSavingsApy({
  config,
  chain,
}: PageFacts): Promise<number | undefined> {
  const tuple = await chain.savingsTuple.read()
  if (!tuple) return undefined
  const vault = await chain.savingsVault(tupleField(tuple, "portal")).read()
  return readSavingsApy(l1PublicClient(config), vault, { l1ChainId: config.l1ChainId })
}

/** How long the landing waits on the live rate before it shows without one. */
const LIVE_APY_WAIT_MS = 2_000

export type LiveApy = { apy: number | undefined }
export type LandingRate = QueryEntry<LiveApy>

/**
 * Sky's live savings rate, with no account: what the landing advertises. Read once per page,
 * started by the boot as soon as the config is up, so the landing usually has it by the time the
 * PXE is. A failed or slow read settles without a rate.
 */
export const liveSavingsApy = (query: QueryFactory, page: PageFacts): LandingRate =>
  query<[], LiveApy>("landingRate", {
    load: () =>
      withTimeout(readLiveSavingsApy(page), LIVE_APY_WAIT_MS).then(
        (apy) => ({ apy }),
        () => ({ apy: undefined }),
      ),
  })()

/**
 * The Savings token for the withdrawal rescan and the wallet's sync, with its deployment: a fresh
 * device rebuilds its moves back to Main from this token's burns, and the sync reads its shares.
 * A burn through a Sky executor the manifest knows is a move out; any other is a plain withdrawal.
 * Undefined where the pinned deployment has no Savings.
 */
export const savingsRescanToken =
  (page: Pick<Session["page"], "chain" | "tokenServices">) =>
  async (
    _wallet: ObsidionWallet,
    account: ObsidionAccount,
  ): Promise<(RescanToken & { tokenService: TokenService }) | undefined> => {
    const tuple = await page.chain.savingsTuple.read()
    if (!tuple) return undefined
    const [tokenService, skyExecutors] = await Promise.all([
      l2TokenService(page, account, tuple.l2Token),
      knownSkyExecutors(page.chain),
    ])
    return {
      tokenService,
      tuple,
      executorKind: (executor) =>
        skyExecutors.executors.has(executor.toLowerCase()) ? "sky" : "plain",
      ...(skyExecutors.complete ? {} : { partial: true }),
    }
  }

/**
 * The Sky executors a Savings burn may name: today's, and each one a Sky feature of the manifest lists. A failed read of
 * the manifest leaves today's alone, and the list incomplete.
 */
async function knownSkyExecutors(
  chain: PageChain,
): Promise<{ executors: Set<string>; complete: boolean }> {
  let complete = true
  const [sky, deployments] = await Promise.all([
    chain.skySavings.read(),
    chain.manifestDeployments.read().catch((err: unknown) => {
      console.warn(
        "[savingsGateway] manifest read failed; the rescan knows today's Sky executor only",
        err,
      )
      complete = false
      return []
    }),
  ])
  const listed = deployments.flatMap((deployment) =>
    (deployment.features ?? []).flatMap((feature) =>
      feature.project === SKY_PROJECT && feature.contracts.skyWithdrawalExecutor
        ? [feature.contracts.skyWithdrawalExecutor]
        : [],
    ),
  )
  const executors = new Set(
    [sky?.deployments.skyExecutor, ...listed].flatMap((a) => (a ? [a.toLowerCase()] : [])),
  )
  return { executors, complete }
}

const savingsAsset = (s: QueryState<OxideEnvTuple | null>) =>
  s.status === "ready" ? (s.value ? s.value.underlying ?? s.value.token : null) : undefined
const NO_TUPLE = memoryStore<QueryState<never>>({ status: "pending" }).readonly

/** The session's Savings asset once the deployment is read; null where it has none. */
export function useSavingsAsset(): string | null | undefined {
  const { savings, page } = useSession()
  return useStore(savings ? page.chain.savingsTuple : NO_TUPLE, savingsAsset)
}

/** Whether Sky savings has been found for this profile: what shows the Savings surfaces. */
export const useSavingsAvailable = (): boolean =>
  useStore(useSession().page.chain.savingsTuple, (s) => s.status === "ready" && !!s.value)

/** The session's token service is Main's: the source of a move in, and what claims a move out. */
export interface SavingsDeps {
  /** The network the wallet's balance store scopes its balances to. */
  network: string
  /** Reads the balances again: a claim moves them with no `Transfer` event. */
  refreshBalance(): Promise<void>
  /** The vault's share price the tray values a move out at. */
  price: Pick<QueryEntry<SavingsPrice | null>, "read">
  /** The session the moves run in. */
  session: BurnSession &
    ClaimSponsorDeps["session"] &
    Pick<Session, "auth" | "savingsMoves" | "contractService" | "account" | "token" | "page">
}

export async function openSavings(deps: SavingsDeps): Promise<SavingsSource | null> {
  const sky = await deps.session.page.chain.skySavings.read()
  return sky ? createSavingsSource({ ...deps, ...(await accountKitOf(deps.session)) }, sky) : null
}

/**
 * `runBurn` drops a seed that never went out (a cancel, a burn a node refused for a pending one);
 * the move goes with it. A seed kept as failed keeps its move, whose row reads Failed.
 */
export async function dropMoveWithSeed(
  moves: Pick<SavingsMoves, "remove">,
  burns: Pick<Withdrawals, "get">,
  localId: string | undefined,
): Promise<void> {
  if (!localId || (await burns.get(localId))) return
  await moves.remove(localId).catch(() => {})
}

/**
 * What the tray and the bell call a move while it sends: its dollar value and where it goes, the
 * shares of a move out priced at the vault's share price. Without a price the line names only the
 * route.
 */
export function moveSummary(
  direction: SavingsDirection,
  amount: bigint,
  sharePrice?: bigint,
): string {
  const to = direction === "in" ? "Savings" : "Main Account"
  const value =
    direction === "in"
      ? amount
      : sharePrice === undefined
      ? undefined
      : savingsValue(amount, sharePrice)
  return value === undefined ? `Savings to ${to}` : `${usdAtomicFloor(value)} to ${to}`
}

/** The Savings deployment's co-signer, which a burn out of Savings and its release need. */
export async function connectSavingsSigner(
  chain: PageChain,
  savings: OxideEnvTuple,
): Promise<RegisteredTeeSigner> {
  try {
    return await chain.teeSignerOfToken(savings.l2Token)
  } catch (cause) {
    throw new Error("The Savings co-signer isn't reachable. Try again in a moment.", { cause })
  }
}

/** What finalizing a move out's burn by hand runs on: the Savings deployment and its co-signer. */
export async function savingsFinalizeDeployment(
  { page: { chain } }: Pick<Session, "page">,
  burn: Pick<WithdrawalRecord, "deployment">,
): Promise<{ tuple: OxideEnvTuple; signer: RegisteredTeeSigner }> {
  const current = await chain.savingsTuple.read()
  // The burn's own deployment, which an older move keeps after Savings moves to a new portal.
  const portal = burn.deployment?.portal
  const tuple =
    portal && portal.toLowerCase() !== current?.portal.toLowerCase()
      ? await chain.portalTuple(portal).read()
      : current
  if (!tuple) throw new Error("Savings isn't available on this network.")
  return { tuple, signer: await connectSavingsSigner(chain, tuple) }
}

export function createSavingsSource(
  deps: SavingsDeps & AccountKit,
  { deployments, factory }: SkySavings,
): SavingsSource {
  const { savingsMoves: moves } = deps.session
  const { config, chain } = deps.session.page
  const { main, savings } = deployments
  const client = l1PublicClient(config)
  // The page's token services keep each one.
  const tokenOf = (l2Token: string) => l2TokenService(deps.session.page, deps.account, l2Token)
  const savingsToken = () => tokenOf(savings.l2Token)
  const vault = () => chain.savingsVault(tupleField(savings, "portal")).read()
  const balance = {
    scope: balanceScope(deps.network, deps.account.getCompleteAddress().toString()),
    tokenAddress: AztecAddress.fromStringUnsafe(savings.l2Token).toString(),
  }

  // The last quote given for each move: what its review showed.
  const reviewed = new Map<string, SavingsQuote>()
  const quoteDeps = () => ({
    client,
    deployments,
    factory,
    executorReads: {
      executor: (address, kind) => chain.withdrawalExecutorAt(address, kind).read(),
      subsidy: (address) => chain.executorSubsidyAt(address).read(),
    } satisfies SavingsExecutorReads,
  })
  const quote = async (direction: SavingsDirection, amount: bigint) => {
    const result = await quoteSavingsMove(quoteDeps(), direction, amount)
    reviewed.set(`${direction}:${amount}`, result)
    return result
  }

  const moveFlow = async (
    op: OperationHandle,
    direction: SavingsDirection,
    amount: bigint,
    onStage: (stage: SavingsMoveStage) => void,
  ): Promise<SavingsMoveRecord> => {
    onStage("building")
    // Before anything is signed: the escrow must deposit into the bridges the manifest pairs.
    assertSkyFactoryPortals(
      await chain.skyFactoryPortalsAt(factory.address).read(),
      deployments,
      factory.address,
    )
    const source = direction === "in" ? main : savings
    const sourceToken = direction === "in" ? deps.tokenService : await savingsToken()
    // Only a burn out of Savings needs the co-signer; a failed connect fails this move alone.
    if (direction === "out") sourceToken.setTeeSigner(await connectSavingsSigner(chain, savings))
    const cap = await chain.txAmountCap(source.portal as Address).read()
    if (direction === "in") assertWithinWithdrawalLimit(amount, cap)
    else if (sharesBurnLimitProblem(amount, cap))
      throw new Error(withdrawalLimitRefusal("protocol"))
    if ((await sourceToken.getBalance()) < amount) throw new Error("Balance not enough")
    const confirmed = reviewed.get(`${direction}:${amount}`)
    const priced = await quote(direction, amount)
    // Fees that rose since the review stop the move; the sheet shows the new figures to confirm.
    if (confirmed && priced.net < confirmed.net) throw new SavingsQuoteChangedError(priced)
    const recoverer = await sessionSwapRecoverer(deps.session, main)
    const broadcaster = await registerBroadcaster(
      deps.wallet,
      deps.contractService,
      tupleField(main, "l2Broadcaster"),
    )
    const build = await buildSavingsMove(
      {
        broadcaster,
        deployments,
        factory,
        masterSecret: recoverer.secret,
        recipient: deps.account.getAddress(),
        recoveryAccount: recoverer.account,
      },
      priced,
    )
    const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)
    const options = withdrawalOptions(config, source)
    const token = await sourceToken.fetchTokenInformation()
    // The escrow's deposit lands after the burn, so its search starts here. A move rebuilt from the
    // burn searches from the burn's time instead.
    const depositScanFrom = (await client.getBlockNumber()).toString()
    const moveOf = (record: WithdrawalRecord): SavingsMoveRecord => ({
      direction,
      withdrawalLocalId: record.localId,
      escrow: build.escrow,
      nonce: build.nonce,
      recipientCommitment: build.recipientCommitment,
      amount: amount.toString(),
      factory: build.skyMove.factory,
      depositScanFrom,
      depositScanFloor: depositScanFrom,
      startTime: record.startTime,
      value: priced.value.toString(),
      net: priced.net.toString(),
    })
    let seeded: WithdrawalRecord | undefined
    const { record, result } = await runBurn({
      op,
      session: deps.session,
      record: {
        recipient: build.escrow,
        recipientProvenance: "saved-recipient",
        recipientAlias: direction === "in" ? "Savings" : "Main Account",
        amount: formatUnits(amount, token.decimals),
        rawAmount: amount.toString(),
        relayerTip: priced.releaseTip.toString(),
        ...(priced.withdrawalFee ? { withdrawalFee: priced.withdrawalFee.toString() } : {}),
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        phase: "submitting",
        startTime: Date.now(),
        deployment: {
          portal: source.portal as Hex,
          l2Token: source.l2Token,
          executor: savingsSourceExecutor(deployments, direction),
        },
        skyMove: { ...build.skyMove, depositScanFrom, value: priced.value.toString() },
      },
      // The move is on both feeds from the seed, while the burn is still proving.
      onSeeded: async (record) => {
        seeded = record
        await moves.put(moveOf(record))
      },
      burn: (_record, onTxHash) => {
        onStage("proving")
        return sourceToken.exitToL1PrivateSponsored(
          build.escrowOptions.escrow,
          amount.toString(),
          sponsor,
          {
            operationId: op.operationId,
            userAccount: deps.account,
            useRawAmount: true,
            withdrawal: { ...options, escrow: build.escrowOptions },
            onTxHash,
          },
        )
      },
    }).catch(async (err: unknown) => {
      await dropMoveWithSeed(moves, deps.session.withdrawals, seeded?.localId)
      throw err
    })
    const move = (await moves.get(record.localId)) ?? (await moves.put(moveOf(record)))
    if (!result) return move
    onStage("submitting")
    noteSponsoredMine(deps, sponsor, "move")
    return move
  }

  const move: SavingsSource["move"] = async (direction, amount, onStage) => {
    // A move out burns shares; the tray names their dollar value at the vault's share price.
    const sharePrice = direction === "out" ? await exitSharePrice(deps.price) : undefined
    return runOperation(
      deps.session,
      {
        operationId: nextOperationId("withdraw"),
        flow: "savings",
        summary: moveSummary(direction, amount, sharePrice),
      },
      (op) => moveFlow(op, direction, amount, onStage),
    )
  }

  let waitingForKey = false
  const settle = async (signal: AbortSignal) => {
    const masterSecret = await deps.session.auth.getSecretKey()
    if (!masterSecret) {
      // Locked: the pass runs again on the next tick once the key is back.
      if (!waitingForKey) console.info("[savingsGateway] settle pass waits for the unlocked key")
      waitingForKey = true
      return
    }
    waitingForKey = false
    const destination = (tuple: OxideEnvTuple, claimer: () => Promise<TokenService>) => ({
      portal: tupleField(tuple, "portal"),
      token: tupleField(tuple, "token"),
      fromBlock: BigInt(tuple.deployedAtBlock ?? 0),
      claimer,
    })
    const withdrawals = deps.session.withdrawals
    await withdrawals.ready
    await settleSavingsMoves(
      moves,
      {
        publicClient: client,
        vault: await vault(),
        onVaultUnknown: (move, txHash, reason) =>
          console.warn(
            `[savingsGateway] move ${move.withdrawalLocalId} (${move.direction}) has no exact figures: ${reason}`,
            txHash,
          ),
        masterSecret,
        recipient: deps.account.getAddress(),
        refreshBalance: deps.refreshBalance,
        signal,
        main: destination(main, async () => deps.tokenService),
        savings: destination(savings, savingsToken),
        destinationFor: async (move) => {
          const current =
            move.direction === "in"
              ? destination(savings, savingsToken)
              : destination(main, async () => deps.tokenService)
          if (sameAddress(move.factory, factory.address)) return current
          // An older move's escrow deposits into the bridges its factory's Sky feature binds, which
          // the manifest still lists. A read that fails or stalls fails this move's search; the pass
          // settles the others.
          const bridges = await skyBridgesOfFactory(
            client,
            await chain.manifestDeployments.read(),
            move.factory,
          )
          if (!bridges)
            throw new Error(`No deployment lists the Sky escrow factory ${move.factory}`)
          const tuple = move.direction === "in" ? bridges.savings : bridges.main
          if (sameAddress(tuple.portal, current.portal)) return current
          return destination(tuple, () => tokenOf(tuple.l2Token))
        },
      },
      [...(await withdrawals.all())],
      (move, err) => console.warn(`[savingsGateway] claim for move ${move.escrow} refused:`, err),
    )
  }

  return {
    assetAddress: savings.underlying ?? savings.token,
    moves,
    balance,
    quote,
    move,
    settle,
  }
}
