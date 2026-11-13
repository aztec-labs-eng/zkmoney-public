/**
 * The session's moves ports: the Sky escrow rail and, when the profile lists a vault on it or the
 * account holds one, the executor rail, over the pinned deployment's holdings, and this browser's
 * account. Each burn runs as one user operation through the withdrawal burn sequence.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { isL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import {
  holdingCatalog,
  type ExecutorHolding,
  type Holding,
  type OxideBridge,
  type SkyEscrowHolding,
} from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  balanceScope,
  bindRail,
  derived,
  deriveSkyEscrowSalts,
  deriveVaultMoveSalts,
  executorMoveBurns,
  executorRoutes,
  heldShares,
  isMoveSettled,
  service,
  skyEscrowExecutors,
  skyEscrowMoveBurns,
  skyEscrowRoutes,
  TxInFlightError,
  WalletError,
  bestEffort,
  savingsHolding,
  type BalanceEntry,
  type BurnRequest,
  type BoundRail,
  type BurnResult,
  type L1Call,
  type MovePorts,
  type MoveRecord,
  type MovesAccount,
  type ReadonlyStore,
  type RecordSet,
  type Service,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import {
  buildBurnReleaseArgs,
  createWithdrawEventSource,
  nextOperationId,
  recoverVaultMoveBurns,
  registerBroadcaster,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
  type RegisteredTeeSigner,
  type TokenService,
  WithdrawFinalizationError,
} from "@obsidion/sdk"
import { formatUnits, isAddressEqual, type Address, type Hex } from "viem"
import { l1PublicClient } from "../../config/oxideTuple"
import { runOperation } from "../operations/operations"
import { claimSponsorContext, type ClaimSponsorDeps } from "../registration/claimSponsorship"
import { RAIL_REGISTERED } from "../registration/rails"
import { assertWithinWithdrawalLimit, sharesBurnLimitProblem } from "../limits/withdrawalLimit"
import { l2TokenService } from "../token/l2TokenService"
import { portalContract } from "../token/oxideToken"
import { l1ExitChannel, walletRecoverer, type MoveSendWatch } from "../withdraw/swapRecovery"
import {
  noteSponsoredMine,
  runBurn,
  withdrawalOptions,
  type BurnSession,
  type RescanToken,
} from "../withdraw/withdrawGateway"
import type { Session } from "../../session/session"
import { moveSummary } from "./moveSummary"

const RETRY = { baseMs: 30_000, maxMs: 30_000 }

export type MovesSession = BurnSession &
  ClaimSponsorDeps["session"] &
  Pick<Session, "auth" | "account" | "token" | "contractService" | "page" | "moves">

/** The account's moves ports, once its wallet is up. A locked key fails the build, which retries. */
export function movesPorts(
  session: MovesSession & {
    account: Service<ObsidionAccount>
    token: Service<TokenService>
    /** The balance store's reads, share tokens among them. */
    balances: ReadonlyStore<RecordSet<BalanceEntry>>
    /** Whether the account's withdrawal rescan sighted a burn the moves engine may own. */
    sighted: ReadonlyStore<boolean>
  },
): Service<MovePorts<MoveSendWatch>> {
  const { wallet, account, token, contractService, page } = session
  return service(
    "movePorts",
    { from: [wallet, account, token, contractService], retry: RETRY },
    async ([wallet, account, main, contractService], signal) => {
      const [deployment, pinned, secret] = await Promise.all([
        page.chain.holdings.read(signal),
        page.chain.oxideTuple.read(signal),
        session.auth.getSecretKey(),
      ])
      if (!secret) throw new WalletError("account.locked", "moves need the unlocked key")
      const sky = deployment.holdings.filter(isSky)
      const vaults = deployment.holdings.filter(isVault)
      const { holdings: listed } = holdingCatalog(deployment, page.config.holdings)
      const l1 = l1PublicClient(page.config)
      const routes = {
        sky: () =>
          skyEscrowRoutes({
            l1,
            broadcaster: (address) => registerBroadcaster(wallet, contractService, address),
          }),
        executor: () => executorRoutes({ l1, eth: { chainId: BigInt(page.config.l1ChainId) } }),
      }
      const rails = liveMoveRails(deployment.holdings, listed, routes, {
        moves: session.moves.view,
        balances: session.balances,
        sighted: session.sighted,
        scope: balanceScope(page.config.network, account.getCompleteAddress().toString()),
      })
      const { account: recoveryAccount } = await walletRecoverer(session, l1)
      return {
        rails,
        account: browserAccount(
          { session, wallet, account, main, contractService, sky, vaults, recoveryAccount },
          secret,
          pinned.portal,
        ),
      }
    },
  )
}

const isSky = (holding: { rail: string }): holding is SkyEscrowHolding =>
  holding.rail === "skyEscrow"

const isVault = (holding: { rail: string }): holding is ExecutorHolding =>
  holding.rail === "executor"

type RailRoutes = {
  sky: () => ReturnType<typeof skyEscrowRoutes>
  executor: () => ReturnType<typeof executorRoutes>
}

/**
 * The rails the session binds: Sky's, and the executor's only when `listed` has a vault on it or
 * the account `holdsVault`, so a session with neither builds no executor port and makes no executor
 * read. Only a listed holding takes a move in: an unlisted vault's funds can only leave.
 */
export function moveRails(
  holdings: readonly Holding[],
  listed: readonly Holding[],
  routes: RailRoutes,
  holdsVault: boolean,
): BoundRail[] {
  const ids = new Set(listed.map((h) => h.id))
  const rails = [bindRail({ routes: routes.sky(), holdings: holdings.filter(isSky), listed: ids })]
  if (listed.some(isVault) || holdsVault)
    rails.push(
      bindRail({ routes: routes.executor(), holdings: holdings.filter(isVault), listed: ids }),
    )
  return rails
}

/** Whether the account has an unfinished move on, or shares of, one of `vaults`. */
const holdsVault = (
  vaults: readonly ExecutorHolding[],
  moves: readonly MoveRecord[],
  balances: RecordSet<BalanceEntry>,
  scope: string,
) =>
  vaults.some(
    (vault) =>
      moves.some((move) => move.holdingId === vault.id && !isMoveSettled(move)) ||
      (heldShares(balances, scope, vault.l2Token) ?? 0n) > 0n,
  )

/** Builds a port once, on first use. */
const once = <T>(build: () => T): (() => T) => {
  let built: T | undefined
  return () => (built ??= build())
}

/**
 * `moveRails`, rebound when whether the account holds a vault changes: a vault the profile stops
 * listing keeps its rail while a move on it is unfinished or its shares are held. `sighted` binds it
 * too when the deployment has a vault, so a fresh device's replay rebuilds the move.
 */
export function liveMoveRails(
  holdings: readonly Holding[],
  listed: readonly Holding[],
  routes: RailRoutes,
  account: {
    moves: ReadonlyStore<RecordSet<MoveRecord>>
    balances: ReadonlyStore<RecordSet<BalanceEntry>>
    sighted: ReadonlyStore<boolean>
    scope: string
  },
): ReadonlyStore<readonly BoundRail[]> {
  const vaults = holdings.filter(isVault)
  const held = derived(
    [account.moves, account.balances, account.sighted],
    (moves, balances, sighted) =>
      (sighted && vaults.length > 0) || holdsVault(vaults, moves.records, balances, account.scope),
  )
  const ports = { sky: once(routes.sky), executor: once(routes.executor) }
  return derived([held], (holds) => moveRails(holdings, listed, ports, holds))
}

/** The terms of an executor a Sky portal's burn names, each read by the portal it serves. */
const skyExecutorReads = (
  chain: Pick<Session["page"]["chain"], "executorPortalAt" | "withdrawalExecutorAt">,
  sky: readonly SkyEscrowHolding[],
) =>
  skyEscrowExecutors(
    {
      portalOf: (executor) => chain.executorPortalAt(executor).read(),
      executor: (address, kind) => chain.withdrawalExecutorAt(address, kind).read(),
    },
    sky,
  )

/**
 * Each Sky holding's share token, for the withdrawal rescan: a fresh device rebuilds a move out's
 * burn from it, stamped with the deployment its finalize by hand runs on.
 */
export async function shareRescanTokens(
  page: Pick<Session["page"], "chain" | "tokenServices">,
  account: ObsidionAccount,
): Promise<RescanToken[]> {
  const sky = (await page.chain.holdings.read()).holdings.filter(isSky)
  const readExecutor = skyExecutorReads(page.chain, sky)
  const held = new Map(sky.map((h) => [h.held.l2Token.toLowerCase(), h.held]))
  return Promise.all(
    [...held.values()].map(async (bridge) => ({
      tokenService: await l2TokenService(page, account, bridge.l2Token),
      tuple: bridge.tuple,
      readExecutor,
    })),
  )
}

interface AccountParts {
  session: MovesSession
  wallet: ObsidionWallet
  account: ObsidionAccount
  /** The session's Main token, wired with its co-signer. */
  main: TokenService
  contractService: ContractService
  sky: readonly SkyEscrowHolding[]
  vaults: readonly ExecutorHolding[]
  recoveryAccount: Address
}

function browserAccount(
  parts: AccountParts,
  secret: Parameters<typeof deriveSkyEscrowSalts>[0],
  mainPortal: string,
): MovesAccount<MoveSendWatch> {
  const { session, wallet, account, main, sky, vaults } = parts
  const { page } = session
  const l1 = l1PublicClient(page.config)
  const onMain = (bridge: OxideBridge) =>
    isAddressEqual(bridge.portal as Address, mainPortal as Address)
  const tokenOf = async (bridge: OxideBridge) =>
    onMain(bridge) ? main : l2TokenService(page, account, bridge.l2Token)
  const readExecutor = skyExecutorReads(page.chain, sky)

  const burn = async (request: BurnRequest, signal?: AbortSignal): Promise<BurnResult> => {
    const { source, amount, direction } = request
    const holding = [...sky, ...vaults].find((h) => h.id === request.holdingId)
    const price =
      direction === "out" && holding
        ? await bestEffort("unknown", page.chain.holdingPrice(holding).read())
        : undefined
    const summary = moveSummary(direction, amount, price)
    const input = { operationId: request.operationId, flow: "savings" as const, summary }
    return runOperation(session, input, async (op) => {
      const sourceToken = await tokenOf(source)
      // Only a burn out of Savings needs the co-signer.
      if (!onMain(source)) sourceToken.setTeeSigner(await connectSigner(session, source.l2Token))
      const cap = await page.chain.txAmountCap(source.portal as Address).read()
      if (direction === "in") assertWithinWithdrawalLimit(amount, cap)
      else if (sharesBurnLimitProblem(amount, cap))
        throw new WalletError("move.overNetworkLimit", `${amount} over ${cap}`)
      if ((await sourceToken.getBalance()) < amount) throw new WalletError("move.overspent")
      const kit = { ...parts, tokenService: main }
      const sponsor = await claimSponsorContext(kit, RAIL_REGISTERED)
      const tokenInfo = await sourceToken.fetchTokenInformation()
      const options = withdrawalOptions(page.config, source.tuple)
      const { escrow, multiStep } = request.withdrawal
      const skyArgs = escrow && "sky" in escrow.memo ? escrow.memo.sky : undefined
      if (!skyArgs && !multiStep)
        throw new WalletError("invariant", "a move's burn pays no Sky escrow or executor route")
      const executor = escrow?.executor ?? multiStep?.executor.address
      const { record, result } = await runBurn({
        op,
        session,
        localId: request.withdrawalLocalId,
        record: {
          recipient: request.target,
          recipientProvenance: "saved-recipient",
          recipientAlias: direction === "in" ? "Savings" : "Main Account",
          amount: formatUnits(amount, tokenInfo.decimals),
          rawAmount: amount.toString(),
          relayerTip: request.releaseTip.toString(),
          ...(escrow?.withdrawalFee ? { withdrawalFee: escrow.withdrawalFee.toString() } : {}),
          tokenSymbol: tokenInfo.symbol,
          tokenDecimals: tokenInfo.decimals,
          phase: "submitting",
          startTime: page.now(),
          deployment: {
            portal: source.portal as Hex,
            l2Token: source.l2Token,
            ...(executor ? { executor: executor as Hex } : {}),
          },
          ...(skyArgs
            ? {
                skyMove: {
                  direction,
                  factory: skyArgs.factory,
                  recipientCommitment: skyArgs.recipientCommitment,
                  recoveryCommitment: skyArgs.recoveryCommitment,
                  relayerTip: skyArgs.relayerTip.toString(),
                  nonce: skyArgs.nonce,
                },
              }
            : {}),
          ...(multiStep
            ? { vaultMove: { holdingId: request.holdingId, nonce: request.nonce } }
            : {}),
        },
        burn: (_record, stamp) => {
          // Only here: past the proof the burn is away, and a cancel would erase a real move.
          // The burn sequence reads the detail as a cancel, and drops the seed.
          if (signal?.aborted) throw new WalletError("aborted", "Cancelled")
          return sourceToken.exitToL1PrivateSponsored(
            EthAddress.fromString(request.target),
            amount.toString(),
            sponsor,
            {
              operationId: request.operationId,
              userAccount: account,
              useRawAmount: true,
              withdrawal: { ...options, ...request.withdrawal },
              onTxHash: stamp,
            },
          )
        },
      })
      // Sent, not yet mined: the chain settles it, and the move follows its record.
      if (!result) throw new TxInFlightError(record.l2TxHash ?? "", "burn sent, not yet mined")
      noteSponsoredMine(kit, sponsor, "move")
      return { txHash: result.txHash, blockNumber: result.blockNumber }
    })
  }

  const sendL1 = async (
    call: L1Call,
    title: string,
    paid: { label: string; address: Address },
    watch?: MoveSendWatch,
  ) => {
    const channel = await l1ExitChannel(session, title, paid, watch)
    const txHash = await channel.sendTransaction(call.to, call.data)
    if (!(await channel.waitForReceipt(txHash)))
      throw new WalletError("tx.failed", `${title}: ${txHash} reverted`)
    return txHash
  }

  return {
    address: account.getAddress(),
    recoveryAccount: parts.recoveryAccount,
    recovery: {
      sign: async (digest) => {
        const { account: signer, signAccount } = await walletRecoverer(session, l1)
        return signAccount(signer, digest)
      },
      send: (call, to, watch) =>
        sendL1(call, "Recover your zk.money move", { label: "Recovered to", address: to }, watch),
    },
    runRoute: (call, target, watch) =>
      sendL1(call, "Run your zk.money move", { label: "Escrow", address: target }, watch),
    salts: (nonce, rail) =>
      rail === "skyEscrow"
        ? deriveSkyEscrowSalts(secret, nonce)
        : deriveVaultMoveSalts(secret, nonce),
    balance: async (bridge) => (await tokenOf(bridge)).getBalance(),
    burn,
    messageReady: (messageKey) => isL1ToL2MessageReady(wallet.node, Fr.fromHexString(messageKey)),
    async claim(bridge, deposit, signal) {
      signal?.throwIfAborted()
      await (
        await tokenOf(bridge)
      ).ensureSweptDeposit({
        inboxIndex: deposit.inboxIndex,
        amount: deposit.amount,
        recipient: account.getAddress(),
        sharedSecretSalt: deposit.secret,
      })
    },
    async moveBurns(bridge, rail) {
      // The PXE reads the token's events only once its contract is registered.
      await (await tokenOf(bridge)).getTokenContract()
      const portal = await portalContract(l1, bridge.portal as Address).getPortalDomain()
      const owner = account.getAddress()
      const source = createWithdrawEventSource({
        wallet,
        portal,
        accountAddress: owner.toString(),
        readExecutor,
      })
      const range = { fromBlock: 1, toBlockExclusive: (await source.headBlock()) + 1 }
      if (rail === "executor") {
        const executors = [...new Set(vaults.map((h) => h.executor.address as Address))]
        const scan = await recoverVaultMoveBurns({ wallet, portal, owner, executors, ...range })
        return executorMoveBurns(scan, source.blockTimestampMs)
      }
      const factories = sky.map((h) => h.escrow.factory as Address)
      return skyEscrowMoveBurns(source, { factories, ...range })
    },
    // Built as finalizing the burn by hand builds its call.
    async releaseArgs({ txHash, source, executor }, tipRecipient) {
      await (await tokenOf(source)).getTokenContract()
      const [portal, signer] = await Promise.all([
        portalContract(l1, source.portal as Address).getPortalDomain(),
        connectSigner(session, source.l2Token),
      ])
      try {
        return await buildBurnReleaseArgs(
          { node: wallet.node, wallet, signer, portal, executor, l1 },
          { burnTxHash: txHash as Hex, owner: account.getAddress(), tipRecipient },
        )
      } catch (error) {
        if (!(error instanceof WithdrawFinalizationError)) throw error
        const code =
          error.reason === "enclave-unavailable" ? "move.signerUnreachable" : "move.noRecovery"
        throw new WalletError(code, `${txHash}: ${error.reason}`, { cause: error })
      }
    },
  }
}

/** The co-signer of the deployment holding `l2Token`, which a burn out of it needs. */
async function connectSigner(session: Pick<Session, "page">, l2Token: string) {
  try {
    return await session.page.chain.teeSignerOfToken(l2Token)
  } catch (cause) {
    throw new WalletError("move.signerUnreachable", l2Token, { cause })
  }
}

/**
 * What finalizing a move out's burn by hand runs on: the burn's own deployment, which an older move
 * keeps after Savings moves to a new portal, and its co-signer.
 */
export async function moveFinalizeDeployment(
  session: Pick<Session, "page">,
  burn: Pick<WithdrawalRecord, "deployment">,
): Promise<{ tuple: OxideEnvTuple; signer: RegisteredTeeSigner }> {
  const { chain, config } = session.page
  const portal = burn.deployment?.portal
  const deployment = await chain.holdings.read()
  const held = portal
    ? deployment.holdings.find((h) => isAddressEqual(h.held.portal as Address, portal))
    : savingsHolding(deployment, config.holdings)
  const tuple = held ? held.held.tuple : portal && (await chain.portalTuple(portal).read())
  if (!tuple) throw new WalletError("invariant", "a move out's burn names no deployment")
  return { tuple, signer: await connectSigner(session, tuple.l2Token) }
}

/** A move's operation id: one per `add` or `withdraw`. */
export const moveOperationId = (): string => nextOperationId("withdraw")
