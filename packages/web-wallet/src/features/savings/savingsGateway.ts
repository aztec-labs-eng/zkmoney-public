/**
 * Savings for the browser: the profile's sUSDS asset composed over the rails a withdrawal uses. A
 * move burns into a Sky escrow through `runBurn`; Main's relayer releases and runs the escrow; the
 * settle pass claims its deposit on the destination token. Nothing here calls a contract itself.
 */
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  TokenService,
  nextOperationId,
  registerBroadcaster,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
  type TeeSigner,
} from "@obsidion/sdk"
import {
  buildSavingsMove,
  createOxideTeeSignerSource,
  expectedSavingsNet,
  quoteSavingsMove,
  readSkyFactoryPortals,
  readSavingsApy,
  readSavingsPosition,
  readSavingsVault,
  resolveSkyFactory,
  savingsValue,
  settleSavingsMoves,
  tupleField,
  type SavingsDeployments,
  type SavingsDirection,
  type SavingsMoveRecord,
  type SavingsMoveStorage,
  type SavingsMoveStage,
  type SavingsPosition,
  type SavingsQuote,
  type SavingsSource,
  type SkyFactory,
  type WithdrawalRecord,
  type WithdrawalStorage,
} from "@obsidion/front-core"
import { useSyncExternalStore } from "react"
import { formatUnits, type Address, type Hex } from "viem"
import { usdAtomicFloor } from "../../ui/format"
import { getConfig, type WebWalletConfig } from "../../config/env"
import {
  ASSET_TUPLE_TIMEOUT_MS,
  getAssetTuple,
  getOxideTuple,
  getPortalTuple,
  l1PublicClient,
} from "../../config/oxideTuple"
import { createExternalState } from "../../lib/externalState"
import { withTimeout } from "../../lib/withTimeout"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { fpcFundingCut } from "../fees/fpcFundingCut"
import {
  assertWithinWithdrawalLimit,
  sharesBurnLimitProblem,
  withdrawalLimitRefusal,
} from "../limits/withdrawalLimit"
import { claimSponsorContext } from "../onboarding/claimSponsorship"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { runOperation, type OperationHandle } from "../operations/operations"
import {
  getWithdrawalStore,
  noteSponsoredMine,
  ownSwapRecoverer,
  runBurn,
  withdrawalOptions,
  type RescanToken,
} from "../withdraw/withdrawGateway"
import { getSavingsMoveStore } from "./savingsMoveStore"
import { SavingsQuoteChangedError } from "./quoteChanged"

const SAVINGS_ASSET = "sUSDS"

const savingsAvailable = createExternalState(false)

/** The sUSDS deployment the profile lists; undefined where it lists none, and nothing then shows. */
export function getSavingsTuple(config: WebWalletConfig): Promise<OxideEnvTuple | undefined> {
  const tuple = getAssetTuple(config, SAVINGS_ASSET) ?? Promise.resolve(undefined)
  tuple.then(
    (found) => savingsAvailable.set(!!found),
    () => {},
  )
  return tuple
}

async function readLiveSavingsApy(): Promise<number | undefined> {
  const config = getConfig()
  const tuple = await getSavingsTuple(config)
  if (!tuple) return undefined
  const client = l1PublicClient(config)
  const vault = await readSavingsVault(client, tupleField(tuple, "portal"))
  return readSavingsApy(client, vault, { l1ChainId: config.l1ChainId })
}

/** How long the landing waits on the live rate before it shows without one. */
const LIVE_APY_WAIT_MS = 2_000

type LiveApy = { settled: false } | { settled: true; apy: number | undefined }
const liveApy = createExternalState<LiveApy>({ settled: false })
let liveApyStarted = false

/**
 * Sky's live savings rate, with no account: what the landing advertises. Read once per page, as
 * soon as the config is up, so the landing it holds usually has it by the time the PXE is.
 */
export function prefetchLiveSavingsApy(): void {
  if (liveApyStarted) return
  liveApyStarted = true
  withTimeout(readLiveSavingsApy(), LIVE_APY_WAIT_MS).then(
    (apy) => liveApy.set({ settled: true, apy }),
    () => liveApy.set({ settled: true, apy: undefined }),
  )
}

export function useLiveSavingsApy(): LiveApy {
  prefetchLiveSavingsApy()
  return useSyncExternalStore(liveApy.subscribe, liveApy.get)
}

/**
 * The Savings token for the withdrawal rescan, with its deployment: a fresh device rebuilds its
 * moves back to Main from this token's burns. Undefined where the profile has no sUSDS deployment.
 */
export async function savingsRescanToken(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
): Promise<RescanToken | undefined> {
  const tuple = await getSavingsTuple(getConfig())
  if (!tuple) return undefined
  const tokenService = await TokenService.create(
    wallet,
    account,
    AztecAddress.fromStringUnsafe(tuple.l2Token),
  )
  return { tokenService, tuple, label: SAVINGS_ASSET }
}

/** Whether a sUSDS deployment has been found for this profile: what shows the Savings surfaces. */
export const useSavingsAvailable = (): boolean =>
  useSyncExternalStore(savingsAvailable.subscribe, savingsAvailable.get)

export interface SavingsDeps {
  wallet: ObsidionWallet
  account: ObsidionAccount
  contractService: ContractService
  /** Main's token service: the source of a move in, and what claims a move out. */
  tokenService: TokenService
}

/** How long one position read answers for; Home and the Savings page read together. */
const READ_TTL_MS = 5_000

/** A promise kept until it fails, so one read serves every caller and a failure is retried. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    if (!pending) {
      const made = make()
      pending = made
      made.catch(() => {
        if (pending === made) pending = undefined
      })
    }
    return pending
  }
}

/**
 * `runBurn` drops a seed that never went out (a cancel, a burn a node refused for a pending one);
 * the move goes with it. A seed kept as failed keeps its move, whose row reads Failed.
 */
export async function dropMoveWithSeed(
  moves: Pick<SavingsMoveStorage, "remove">,
  burns: Pick<WithdrawalStorage, "get">,
  localId: string | undefined,
): Promise<void> {
  if (!localId || burns.get(localId)) return
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
  wallet: ObsidionWallet,
  savings: OxideEnvTuple,
): Promise<TeeSigner> {
  const config = getConfig()
  const signer = await createOxideTeeSignerSource({
    l1RpcUrl: config.l1RpcUrl,
    l1Chain: config.l1Chain,
    // Savings' own TEE: Main's enclave cannot sign for the Savings portal.
    transformEnclaveUrl: (url) =>
      config.savingsEnclaveUrl ? `${config.savingsEnclaveUrl}/rpc` : url,
    getNode: () => wallet.node,
    getTokenAddress: async () => AztecAddress.fromStringUnsafe(savings.l2Token),
    getTuple: () => savings,
  }).load()
  if (!signer) throw new Error("The Savings co-signer isn't reachable. Try again in a moment.")
  return signer
}

/** What finalizing a move out's burn by hand runs on: the Savings deployment and its co-signer. */
export async function savingsFinalizeDeployment(
  wallet: ObsidionWallet,
  burn: Pick<WithdrawalRecord, "deployment">,
): Promise<{ tuple: OxideEnvTuple; signer: TeeSigner }> {
  const config = getConfig()
  const current = await getSavingsTuple(config)
  // The burn's own deployment, which an older move keeps after Savings moves to a new portal.
  const portal = burn.deployment?.portal
  const tuple =
    portal && portal.toLowerCase() !== current?.portal.toLowerCase()
      ? await getPortalTuple(config, portal)
      : current
  if (!tuple) throw new Error("Savings isn't available on this network.")
  return { tuple, signer: await connectSavingsSigner(wallet, tuple) }
}

export function createSavingsSource(deps: SavingsDeps, savings: OxideEnvTuple): SavingsSource {
  const config = getConfig()
  const client = l1PublicClient(config)
  const moves = getSavingsMoveStore()
  const deployments = once<SavingsDeployments>(async () => ({
    main: await getOxideTuple(config),
    savings,
  }))
  const factory = once<SkyFactory>(async () => resolveSkyFactory(client, await deployments()))
  const savingsToken = once<TokenService>(async () => {
    const { savings } = await deployments()
    return TokenService.create(
      deps.wallet,
      deps.account,
      AztecAddress.fromStringUnsafe(savings.l2Token),
    )
  })
  // Reads and claims need no co-signer; only a burn out of Savings does, so it connects then, and
  // a failed connect is tried again on the next move out.
  const savingsSigner = once(async () =>
    connectSavingsSigner(deps.wallet, (await deployments()).savings),
  )
  const vault = once<Address>(async () =>
    readSavingsVault(client, tupleField((await deployments()).savings, "portal")),
  )
  let lastRead: { at: number; value: Promise<SavingsPosition> } | undefined

  const read = () => {
    const now = Date.now()
    if (lastRead && now - lastRead.at < READ_TTL_MS) return lastRead.value
    const value = (async () => {
      const [token, address] = await Promise.all([savingsToken(), vault()])
      return readSavingsPosition(client, address, await token.getBalance(), {
        l1ChainId: config.l1ChainId,
      })
    })()
    lastRead = { at: now, value }
    value.catch(() => {
      if (lastRead?.value === value) lastRead = undefined
    })
    return value
  }

  // The last quote given for each move: what its review showed.
  const reviewed = new Map<string, SavingsQuote>()
  const quoteDeps = async () => ({
    client,
    deployments: await deployments(),
    factory: await factory(),
    cutOf: (portal: Address) => fpcFundingCut(client, portal),
  })
  const quote = async (direction: SavingsDirection, amount: bigint) => {
    const result = await quoteSavingsMove(await quoteDeps(), direction, amount)
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
    const { main, savings } = await deployments()
    const source = direction === "in" ? main : savings
    const sourceToken = direction === "in" ? deps.tokenService : await savingsToken()
    if (direction === "out") sourceToken.setTeeSigner(await savingsSigner())
    if (direction === "in") assertWithinWithdrawalLimit(amount)
    else if (sharesBurnLimitProblem(amount)) throw new Error(withdrawalLimitRefusal("protocol"))
    if ((await sourceToken.getBalance()) < amount) throw new Error("Balance not enough")
    const confirmed = reviewed.get(`${direction}:${amount}`)
    const priced = await quote(direction, amount)
    // Fees that rose since the review stop the move; the sheet shows the new figures to confirm.
    if (confirmed && priced.net < confirmed.net) throw new SavingsQuoteChangedError(priced)
    const recoverer = await ownSwapRecoverer(main)
    const broadcaster = await registerBroadcaster(
      deps.wallet,
      deps.contractService,
      tupleField(main, "l2Broadcaster"),
    )
    const build = await buildSavingsMove(
      {
        broadcaster,
        deployments: { main, savings },
        factory: await factory(),
        masterSecret: recoverer.secret,
        recipient: deps.account.getAddress(),
        recoveryAccount: recoverer.account,
      },
      priced,
    )
    const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)
    const options = await withdrawalOptions(source)
    const token = await sourceToken.fetchTokenInformation()
    // The escrow's deposit lands after the burn, so its search starts here; the burn's meta carries
    // it too, so a move rebuilt from the burn keeps it.
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
      wallet: deps.wallet,
      record: {
        recipient: build.escrow,
        recipientProvenance: "saved-recipient",
        recipientAlias: direction === "in" ? "Savings" : "Main Account",
        amount: formatUnits(amount, DEFAULT_DECIMALS),
        rawAmount: amount.toString(),
        relayerTip: priced.releaseTip.toString(),
        fpcFundingCut: priced.sourceCut.toString(),
        tokenSymbol: token.symbol,
        phase: "submitting",
        startTime: Date.now(),
        deployment: { portal: source.portal as Hex, l2Token: source.l2Token },
        skyMove: { ...build.skyMove, depositScanFrom, value: priced.value.toString() },
      },
      // The move is on both feeds from the seed, while the burn is still proving.
      onSeeded: async (record) => {
        seeded = record
        await moves.put(moveOf(record))
      },
      burn: () => {
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
          },
        )
      },
    }).catch(async (err: unknown) => {
      await dropMoveWithSeed(moves, getWithdrawalStore(), seeded?.localId)
      throw err
    })
    const move = moves.get(record.localId) ?? (await moves.put(moveOf(record)))
    if (!result) return move
    onStage("submitting")
    noteSponsoredMine(deps, sponsor, "move")
    return move
  }

  const move: SavingsSource["move"] = async (direction, amount, onStage) => {
    // A move out burns shares; the tray names their dollar value at the vault's share price.
    const sharePrice =
      direction === "out"
        ? await read().then(
            (position) => position.sharePrice,
            () => undefined,
          )
        : undefined
    return runOperation(
      {
        operationId: nextOperationId("withdraw"),
        flow: "savings",
        summary: moveSummary(direction, amount, sharePrice),
      },
      (op) => moveFlow(op, direction, amount, onStage),
    )
  }

  // An older move's escrow deposits into the portals its factory was built with: those are read
  // once per factory, and an older portal's token service is made once per token.
  const factoryPortals = new Map<string, ReturnType<typeof readSkyFactoryPortals>>()
  const olderTokens = new Map<string, Promise<TokenService>>()
  const cachedOnce = <T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>) => {
    let value = cache.get(key)
    if (!value) {
      const made = make()
      cache.set(key, made)
      made.catch(() => cache.delete(key))
      value = made
    }
    return value
  }

  let waitingForKey = false
  const settle = async () => {
    const masterSecret = await getAuthService().getSecretKey()
    if (!masterSecret) {
      // Locked: the pass runs again on the next tick once the key is back.
      if (!waitingForKey) console.info("[savingsGateway] settle pass waits for the unlocked key")
      waitingForKey = true
      return
    }
    waitingForKey = false
    const { main, savings } = await deployments()
    const destination = (tuple: OxideEnvTuple, claimer: () => Promise<TokenService>) => ({
      portal: tupleField(tuple, "portal"),
      token: tupleField(tuple, "token"),
      fromBlock: BigInt(tuple.deployedAtBlock ?? 0),
      claimer,
    })
    const withdrawals = getWithdrawalStore()
    await withdrawals.load()
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
        expectedNet: async (move, burn) =>
          expectedSavingsNet(await quoteDeps(), move.direction, BigInt(move.amount), {
            escrowTip: BigInt(burn.skyMove!.relayerTip),
            ...(burn.fpcFundingCut !== undefined ? { sourceCut: BigInt(burn.fpcFundingCut) } : {}),
            ...(burn.relayerTip !== undefined ? { releaseTip: BigInt(burn.relayerTip) } : {}),
          }),
        recipient: deps.account.getAddress(),
        main: destination(main, async () => deps.tokenService),
        savings: destination(savings, savingsToken),
        destinationFor: async (move) => {
          const current =
            move.direction === "in"
              ? destination(savings, savingsToken)
              : destination(main, async () => deps.tokenService)
          // A read that stalls fails this move's search; the pass settles the others.
          const portals = await cachedOnce(factoryPortals, move.factory.toLowerCase(), () =>
            withTimeout(readSkyFactoryPortals(client, move.factory), ASSET_TUPLE_TIMEOUT_MS),
          )
          const portal = move.direction === "in" ? portals.sUsdsPortal : portals.daiPortal
          if (portal.toLowerCase() === current.portal.toLowerCase()) return current
          const tuple = await getPortalTuple(config, portal)
          return destination(tuple, () =>
            cachedOnce(olderTokens, tuple.l2Token.toLowerCase(), () =>
              TokenService.create(
                deps.wallet,
                deps.account,
                AztecAddress.fromStringUnsafe(tuple.l2Token),
              ),
            ),
          )
        },
      },
      withdrawals.list(),
      (move, err) => console.warn(`[savingsGateway] claim for move ${move.escrow} refused:`, err),
    )
  }

  return { moves, read, quote, move, settle }
}
