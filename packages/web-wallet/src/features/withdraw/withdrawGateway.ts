/**
 * The L2→L1 withdrawal rail for the browser, composing the shared machinery
 * (`TokenService.exitToL1PrivateSponsored`, the session's withdrawal store and
 * tracker, `resolveWithdrawalWiring`) over browser collaborators. The burn is
 * ClaimFPC-sponsored — web has no fee service, so the FPC batch is the only fee
 * rail — and finalization is oxide's headless relayer: once the burn is mined
 * this module only wakes the session's withdrawal tracker.
 *
 * The tracker reads the L1 through sdk readers over the tuple's portal
 * (`PageChain.withdrawalRails`); front-core originates no contract call.
 */
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { bridgeUnderlying } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, Hex } from "viem"
import { formatUnits } from "viem"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  createWithdrawEventSource,
  nextOperationId,
  planSwapOnWithdraw,
  predictAccountAddress,
  type ObsidionAccount,
  type ObsidionWallet,
  type SwapEscrowArgs,
  type SwapEscrowOutput,
  type SwapOnWithdrawPlan,
  type SwapSimulation,
  type TokenService,
  type WithdrawalExecutorKind,
  type WithdrawalOptions,
} from "@obsidion/sdk"
import {
  conflictingPendingTx,
  deriveBootstrapKey,
  deriveSwapEscrowRecoverySalt,
  newWithdrawalLocalId,
  PendingTxConflictError,
  rebuildWithdrawals,
  resolveWithdrawalWiring,
  revivePendingWithdrawal,
  trackWithdrawalSubmission,
  withdrawalRecipients,
  bestEffort,
  task,
  within,
  WalletError,
  withdrawalFailure,
} from "@obsidion/front-core"
import type {
  Task,
  WithdrawalDeployment,
  WithdrawalRescanDeps,
  AddressScreener,
  FieldLike,
  WithdrawalRecord,
  Withdrawals,
  Service,
} from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { tokenMetadata } from "../sipa/loadDepositFacts"
import { portalDomainOfToken } from "../token/oxideToken"
import { usdBalance } from "../../ui/format"
import { isFlowCancelled, runOperation, type OperationHandle } from "../operations/operations"
import { accountKitOf, type AccountKit, type Session } from "../../session/session"
import { claimSponsorContext, noteSubscribed } from "../registration/claimSponsorship"
import { RAIL_REGISTERED } from "../registration/rails"
import { assertWithinWithdrawalLimit } from "../limits/withdrawalLimit"
import type { WithdrawalReceiveAsset } from "./withdrawAssets"
import { withdrawalExecutorFee } from "./withdrawalFee"
import type { PageChain } from "../../session/pageChain"
import { sponsorshipErrorCopy } from "../allowance/sponsorshipError"

/** Progress stages the modal's proving view renders. */
export type WithdrawStage = "building" | "proving" | "submitting"

/** What a swap route commits to at confirm: the tip the escrow pays, and the estimate the record keeps. */
export type SwapCommit = Pick<SwapSimulation, "relayerTip" | "amountOut" | "decimals"> &
  Partial<Pick<SwapSimulation, "gasOut">>

/** The live deployment's withdrawal coordinates and executor, stamped on every new record. */
export async function currentDeployment(
  tuple: OxideEnvTuple,
): Promise<WithdrawalDeployment | undefined> {
  const wiring = resolveWithdrawalWiring(tuple)
  return wiring
    ? { portal: wiring.portal, l2Token: wiring.l2Token, executor: wiring.plainWithdrawalExecutor }
    : undefined
}

/** A token whose recovery events the rescan rebuilds burns from. */
export interface RescanToken {
  tokenService: Pick<TokenService, "fetchTokenInformation" | "getTokenContract">
  /** The deployment the token belongs to, stamped on its rebuilt records; Main's live one when absent. */
  tuple?: OxideEnvTuple
  /** The kind of each executor the token's burns name; plain when absent. */
  executorKind?: (executor: Address) => WithdrawalExecutorKind
  /** What the console calls this scan; the token's own symbol when absent. */
  label?: string
  /** `executorKind` may not know every executor: the pass runs, then fails, so a later call scans again. */
  partial?: boolean
}

/** What a session's rescans read and write beside the wallet and account each call names. */
export interface RescanDeps extends Pick<WithdrawalRescanDeps, "keep" | "chainName"> {
  store: Withdrawals
  /** Main's deployment, for a token that names none. */
  deployment(): Promise<OxideEnvTuple>
  /** An L1 token's ERC-20 symbol. */
  l1Symbol(token: Address): Promise<string>
  /** Runs the tracker over the records a rescan rebuilt. */
  wake(): void
  /** Rejects a pass that skipped a burn whose executor it could not read, after rebuilding the rest. */
  strict?: boolean
  readExecutor: PageChain["withdrawalExecutorAt"]
  chain: PageChain
}

/**
 * Once per session and token: rebuild the records this browser lost from an account's own
 * recovery events on every token it holds, Savings' included, and wake the tracker for them.
 * Reading the events syncs PXE first, so a fresh device gets its whole history. Tokens run one at a
 * time; a token missing from an earlier call is scanned when a later call names it. A failed pass,
 * or one that skipped a burn whose executor it could not read, is dropped so a later call tries
 * again. Resolves to the records created.
 */
export function rescanWithdrawals(deps: RescanDeps, scan = rescanToken) {
  const passes = new Map<string, Promise<WithdrawalRecord[]>>()
  return async (
    wallet: ObsidionWallet,
    /** The account whose burns are read. */
    owner: string,
    tokens: RescanToken[],
  ): Promise<WithdrawalRecord[]> => {
    const rebuilt: WithdrawalRecord[] = []
    for (const token of tokens) {
      const key = token.tuple?.l2Token ?? "main"
      let pass = passes.get(key)
      if (!pass) {
        let skipped = false
        const forget = () => {
          if (passes.get(key) === made) passes.delete(key)
        }
        const skip = () => {
          skipped = true
          forget()
        }
        const made = scan(deps, wallet, owner, token, skip).then((records) => {
          if (token.partial || (deps.strict && skipped))
            throw new WalletError(
              "scan.incomplete",
              `rescan ${token.label ?? key} ran without every executor`,
            )
          return records
        })
        passes.set(key, made)
        made.catch(forget)
        pass = made
      }
      rebuilt.push(...(await pass))
    }
    return rebuilt
  }
}

/** Rebuilds Main's withdrawals once per session; not retried, as the Savings replay runs it again. */
export function withdrawalRescan(
  needs: {
    wallet: Service<ObsidionWallet>
    account: Service<ObsidionAccount>
    token: Service<TokenService>
  },
  rescan: ReturnType<typeof rescanWithdrawals>,
): Task {
  return task("withdrawalRescan", {
    needs,
    after: { firstBalance: true, depositsReplayed: { whenCatchingUp: 0 } },
    every: "once",
    async run({ wallet, account, token, signal }) {
      const owner = account.getAddress().toString()
      await within(rescan(wallet, owner, [{ tokenService: token }]), "withdrawalRescan", {
        signal,
      })
    },
  })
}

async function rescanToken(
  deps: RescanDeps,
  wallet: ObsidionWallet,
  owner: string,
  { tokenService, tuple, label, executorKind = () => "plain" }: RescanToken,
  forget: () => void,
): Promise<WithdrawalRecord[]> {
  const token = await tokenService.fetchTokenInformation()
  const deployment = tuple ?? (await deps.deployment())
  const wiring = resolveWithdrawalWiring(deployment)
  if (!wiring) return []
  // The L1 token the burned amounts count, not the L2 token's own symbol.
  const tokenSymbol = await deps.l1Symbol(bridgeUnderlying(deployment) as Address)
  // Reading the token's events runs its sync, which needs its immutables stored in this PXE.
  await tokenService.getTokenContract()
  const rebuilt = await rebuildWithdrawals({
    source: createWithdrawEventSource({
      wallet,
      portal: await portalDomainOfToken(deps.chain, deployment.l2Token),
      accountAddress: owner,
      // Every executor the account's burns name, not only the one the bridge lists today.
      readExecutor: (address) =>
        deps
          .readExecutor(address, executorKind(address))
          .read()
          .catch((err: unknown) => {
            forget()
            throw err
          }),
    }),
    store: deps.store,
    keep: deps.keep,
    chainName: deps.chainName,
    tokenSymbol,
    tokenDecimals: token.decimals,
    networkId: wallet.networkId,
    deployment: { portal: wiring.portal, l2Token: wiring.l2Token },
    report: ({ tokenSymbol, events, unknown, created, savingsMoves }) =>
      console.info(
        `[withdrawGateway] rescan ${
          label ?? tokenSymbol
        }: ${events} withdrawals, ${unknown} unknown, ${
          created.length
        } rebuilt (${savingsMoves} Savings moves)`,
      ),
  })
  // Most rebuilt burns settled long ago; until a pass reads that, their rows show in progress.
  if (rebuilt.length > 0) deps.wake()
  return rebuilt
}

export interface WithdrawDeps {
  screener: AddressScreener
  session: Session
}
type WithdrawKit = WithdrawDeps & AccountKit

/**
 * Run a sponsored withdrawal end to end: refuse an amount over the per-withdrawal limit, screen the
 * recipient, then {@link runBurn} through the ClaimFPC batch. The record is the source of truth
 * from there: oxide's relayer finalizes on L1 and the tracker walks the phases to `done`.
 */
export function submitSponsoredWithdrawal(
  deps: WithdrawDeps,
  recipient: Address,
  /** The burn, in DAI base units. */
  amountAtomic: bigint,
  onStage: (stage: WithdrawStage) => void,
  recipientAlias?: string,
  receiveAsset: WithdrawalReceiveAsset = "DAI",
  swap?: SwapCommit,
  proverTip = 0n,
): Promise<WithdrawalRecord> {
  const amount = usdBalance(formatUnits(amountAtomic, DEFAULT_DECIMALS))
  const summary = `${amount} to ${recipientAlias?.trim() || "Ethereum"}`
  return runOperation(
    deps.session,
    { operationId: nextOperationId("withdraw"), flow: "withdraw", summary },
    (op) =>
      submitSponsoredWithdrawalFlow(
        op,
        deps,
        recipient,
        amountAtomic,
        onStage,
        recipientAlias,
        receiveAsset,
        swap,
        proverTip,
      ),
  )
}

/** A mined burn: what `markMined` stores. */
export interface BurnResult {
  txHash: string
  blockNumber: number
}

/** What a burn writes in the session it runs in. */
export type BurnSession = Pick<
  Session,
  "withdrawals" | "operations" | "db" | "wake" | "withdrawalTracker" | "wallet" | "page"
>

export interface BurnInput<R extends BurnResult> {
  op: OperationHandle
  session: BurnSession
  /** The record seeded before the burn is sent, so a reload mid-prove finds it. */
  record: Omit<WithdrawalRecord, "localId" | "operationId">
  /** The row key a caller chose ahead of the seed, one no row holds yet; a fresh one otherwise. */
  localId?: string
  /** Runs once the record is seeded, before the burn: records of the caller's own ride the seed. */
  onSeeded?: (record: WithdrawalRecord) => Promise<void>
  /**
   * Signs, proves and sends the burn off the persisted record; resolves on the L2 receipt. Hands
   * `onTxHash` to the sdk, which awaits it before the node takes the burn.
   */
  burn: (record: WithdrawalRecord, onTxHash: (txHash: string) => Promise<void>) => Promise<R>
  /** The mined amount and tip; the seeded record's figures stand in when absent or rejected. */
  minedFigures?: (result: R) => Promise<{ amount: string; relayerTip: string } | undefined>
  /** The context the failure copy is worded for; "withdraw:submit" when absent. */
  reportContext?: string
}

/**
 * The one burn sequence behind every L2→L1 exit. Seeds the withdrawal record and runs the burn,
 * which saves its hash on the record before the node takes it. A burn that may still land is
 * returned unmined, left to the chain and the tracker (`result` absent). One a node refused because
 * a burn it holds spends the same notes drops its seed and puts that earlier withdrawal back to
 * pending. One that never went out drops its seed on a cancel and is marked `failed` otherwise,
 * then rethrows. A mined burn is marked mined and wakes the tracker; nothing after the mine
 * fails the record, so callers keep their own bookkeeping off it too.
 */
export async function runBurn<R extends BurnResult>(
  input: BurnInput<R>,
): Promise<{ record: WithdrawalRecord; result?: R }> {
  const { op, session } = input
  const wallet = await session.wallet.ready()
  const { withdrawals: store, operations, db } = session
  await store.ready
  const localId = input.localId ?? newWithdrawalLocalId(session.page.now())
  const record = await store.create({
    ...input.record,
    localId,
    operationId: op.operationId,
    networkId: wallet.networkId,
  })
  const submission = trackWithdrawalSubmission(
    session.page.prover.progress,
    store,
    localId,
    op.operationId,
    {
      db,
      operations,
    },
  )
  let result: R
  try {
    await input.onSeeded?.(record)
    result = await input.burn(record, submission.stamp)
  } catch (err) {
    // The node refused this burn because one it holds spends the same notes, so this one never
    // went out. When that one is an earlier withdrawal, it is pending again, whatever it read.
    const conflict = conflictingPendingTx(err)
    if (conflict) {
      await bestEffort("unknown", store.remove(localId))
      const earlier = await bestEffort("unknown", revivePendingWithdrawal(store, conflict))
      if (earlier) void session.wake(session.withdrawalTracker)
      throw new PendingTxConflictError(
        conflict,
        earlier
          ? "An earlier withdrawal of these funds is still pending. It is back in your activity."
          : "These funds are held by a transaction that is still pending. Try again once it finishes.",
        err,
      )
    }
    const pending = await submission.recover(wallet.node)
    if (pending) {
      op.leaveToChain(pending.l2TxHash ?? submission.txHash)
      void session.wake(session.withdrawalTracker)
      return { record: pending }
    }
    // A cancel thrown from a stage callback lands before the burn: drop the seed, not fail it.
    if (isFlowCancelled(err)) {
      await bestEffort("unknown", store.remove(localId))
    } else {
      const message =
        sponsorshipErrorCopy(err, input.reportContext ?? "withdraw:submit")?.message ??
        (err instanceof Error ? err.message : "Withdrawal failed")
      const failed = { phase: "failed", failure: withdrawalFailure(message) } as const
      await bestEffort("unknown", store.apply(localId, { type: "patch", fields: failed }))
    }
    throw err
  } finally {
    submission.stop()
  }
  const figures = await input.minedFigures?.(result).catch(() => undefined)
  let mined: WithdrawalRecord
  try {
    const marked = await store.apply(localId, {
      type: "mined",
      l2TxHash: result.txHash,
      blockNumber: result.blockNumber,
      rawAmount: figures?.amount ?? record.rawAmount ?? "0",
      relayerTip: figures?.relayerTip ?? record.relayerTip,
    })
    if (!marked) throw new Error(`no withdrawal record ${localId}`)
    mined = marked
  } catch (err) {
    // Mined but not recorded as such: the tracker picks it up from the stamped hash.
    console.warn("[withdrawGateway] burn mined; its record could not be updated:", err)
    op.leaveToChain(result.txHash)
    return { record: (await store.get(localId)) ?? record }
  }
  void session.wake(session.withdrawalTracker)
  return { record: mined, result }
}

/** The swap leg, fully built during planning: the plan the record persists and the burn pays. */
export interface SwapLeg {
  source: { portal: string; l2Token: string }
  output: SwapEscrowOutput
  plan: SwapOnWithdrawPlan
  /** The factory the escrow address was derived from; stored so a later exit targets the same one. */
  factory: Address
}

/**
 * Who may recover a swap escrow the route cannot deliver, and the secret its recovery salt derives
 * from.
 */
export interface SwapRecoverer {
  account: Address
  secret: FieldLike
}

/**
 * Plan the swap leg of a burn. A non-DAI output, or any output with a gas swap, burns to oxide's
 * counterfactual SwapEscrow instead of the recipient; the sdk pairs the escrow's swap with the
 * release in the Broadcaster call riding the burn tx, so a mined burn implies a mined broadcast. Call it before the record exists, so a
 * bad manifest aborts with nothing persisted and the escrow args land on the record before the
 * burn is sent.
 * Undefined for DAI without a gas swap.
 */
export async function planSwapLeg(
  reads: Pick<PageChain, "oxideTuple" | "withdrawalExecutorAt">,
  /** Who can take the escrow back on the deployment the leg uses. */
  recoverer: (tuple: OxideEnvTuple) => Promise<SwapRecoverer>,
  receiveAsset: WithdrawalReceiveAsset,
  recipient: Address,
  amount: bigint,
  commit?: SwapCommit,
  source?: OxideEnvTuple,
  /** Must match the burn's, which the escrow's funding is net of. */
  proverTip = 0n,
  /** DAI the escrow swaps to ETH for the recipient: with it, even DAI rides an escrow. */
  daiForGas = 0n,
): Promise<SwapLeg | undefined> {
  if (receiveAsset === "DAI" && daiForGas === 0n) return undefined
  if (!commit) throw new Error("Swap fee unavailable. Withdraw DAI instead.")
  const tuple = source ?? (await reads.oxideTuple.read())
  requireTupleField(tuple, "l2Broadcaster")
  const swapEscrowFactoryV2 = requireTupleField(tuple, "swapEscrowFactoryV2") as Address
  const nonce = Fr.random().toString() as Hex
  const [{ account, secret }, withdrawalFee] = await Promise.all([
    recoverer(tuple),
    withdrawalExecutorFee(reads, tuple),
  ])
  const plan = planSwapOnWithdraw({
    swapEscrowFactoryV2,
    output: receiveAsset,
    l1Recipient: recipient,
    amount,
    withdrawalFee,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    proverTip,
    relayerTip: commit.relayerTip,
    daiForGas,
    recovery: { account, salt: deriveSwapEscrowRecoverySalt(secret, nonce) },
    nonce,
  })

  return {
    output: receiveAsset,
    source: { portal: tuple.portal, l2Token: tuple.l2Token },
    plan,
    factory: swapEscrowFactoryV2,
  }
}

/** How a burn from `tuple` settles: the deployment, and the swap leg the burn pays. */
export function withdrawalOptions(
  config: WebWalletConfig,
  tuple: OxideEnvTuple,
  swap?: SwapLeg,
): WithdrawalOptions {
  const l1 = l1PublicClient(config)
  return { tuple, l1, ...(swap ? { swap: swap.plan } : {}) }
}

/** What a swap leg writes on the record before its burn is sent, plus the confirm-time quote for the detail sheet. */
export function swapRecordFields(
  swap: SwapLeg | undefined,
  quote?: SwapCommit,
): Partial<WithdrawalRecord> {
  if (!swap) return {}
  return {
    swapOutput: swap.output,
    swapEscrow: swap.plan.escrow,
    swapEscrowFactory: swap.factory,
    swapEscrowLayout: "v2",
    swapRecoveryCommitment: swap.plan.escrowArgs.recoveryCommitment,
    swapNonce: swap.plan.escrowArgs.nonce,
    swapRelayerTip: swap.plan.escrowArgs.relayerTip.toString(),
    ...gasRecordFields(swap.plan.escrowArgs),
    swapEstimatedOut: quote?.amountOut.toString(),
    swapOutputDecimals: quote?.decimals,
    ...(quote?.gasOut ? { swapEstimatedGasOut: quote.gasOut.toString() } : {}),
  }
}

function gasRecordFields(args: SwapEscrowArgs): Partial<WithdrawalRecord> {
  return {
    ...(args.daiForGas > 0n ? { swapDaiForGas: args.daiForGas.toString() } : {}),
    ...(args.minEthForGas > 0n ? { swapMinEthForGas: args.minEthForGas.toString() } : {}),
  }
}

async function submitSponsoredWithdrawalFlow(
  op: OperationHandle,
  deps: WithdrawDeps,
  recipient: Address,
  amount: bigint,
  onStage: (stage: WithdrawStage) => void,
  /** User label for the recipient; shown by the sheet and the activity row. */
  recipientAlias?: string,
  receiveAsset: WithdrawalReceiveAsset = "DAI",
  /**
   * The simulation the user confirmed: the escrow commits to its tip, and the record keeps its estimate
   * for the detail sheet. Required for a swap route — without a simulated tip there is nothing to offer
   * the relayer.
   */
  swapCommit?: SwapCommit,
  /** Paid to the first prover of the burn's checkpoint, out of the burn. */
  proverTip = 0n,
): Promise<WithdrawalRecord> {
  onStage("building")
  const kit = { ...deps, ...(await accountKitOf(deps.session)) }
  assertWithinWithdrawalLimit(amount, await deps.session.page.chain.currentTxAmountCap.read())
  const ctx = await burnContext(kit, recipient)
  const swap = await planSwapLeg(
    deps.session.page.chain,
    (tuple) => sessionSwapRecoverer(deps.session, tuple),
    receiveAsset,
    recipient,
    amount,
    swapCommit,
    ctx.tuple,
    proverTip,
  )
  const burn = { recipient, recipientAlias, amount, swap, swapCommit, proverTip }
  return (await runSponsoredBurn(op, kit, ctx, burn, onStage)).record
}

/**
 * What a sponsored burn to `recipient` settles against, read before any record exists. A
 * bridge-out names `chainId`, the chain its recipient is screened on.
 */
export async function burnContext(deps: WithdrawKit, recipient: Address, chainId?: number) {
  // Re-screen at the commit point, before any record or burn exists: oxide's relayer enforces
  // the same policy at batching time, where a blocked recipient means a burned-but-never-
  // finalized withdrawal. A screener throw (verdict unknown) also aborts — fail closed. For a
  // swap withdrawal the burn recipient is a fresh counterfactual escrow, so this screen on the
  // swap-output recipient is the only meaningful one.
  const verdict = await deps.screener.screen(recipient, chainId)
  if (!verdict.compliant) {
    throw new Error(verdict.reason?.message ?? "This address can't receive withdrawals")
  }

  const token = await deps.tokenService.fetchTokenInformation()
  const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)

  const { chain } = deps.session.page
  const tuple = await chain.oxideTuple.read()
  const unit = await tokenMetadata({ chain }, bridgeUnderlying(tuple) as Address)
  return {
    tokenSymbol: unit.symbol,
    tokenDecimals: token.decimals,
    sponsor,
    tuple,
    deployment: await currentDeployment(tuple),
  }
}

export type BurnContext = Awaited<ReturnType<typeof burnContext>>

export interface SponsoredBurnInput {
  recipient: Address
  recipientAlias?: string
  /** Atomic units of the wallet asset the burn removes. */
  amount: bigint
  /** The planned swap leg and the quote it was confirmed on; both absent for a direct DAI burn. */
  swap?: SwapLeg
  swapCommit?: SwapCommit
  /** Laid over the record and the sdk options every sponsored burn shares. */
  record?: Partial<WithdrawalRecord>
  options?: Partial<WithdrawalOptions>
  /** Paid to the first prover of the burn's checkpoint, out of the burn. */
  proverTip?: bigint
}

/** What a sponsored burn hands the sdk, off the fields its record is seeded with. */
async function sponsoredExit(
  config: WebWalletConfig,
  tuple: OxideEnvTuple,
  input: SponsoredBurnInput,
) {
  const { recipient, amount, swap } = input
  const seed = { recipient, ...swapRecordFields(swap), ...input.record }
  return {
    l1Recipient: EthAddress.fromString(withdrawalRecipients(seed).release),
    amount: seed.rawAmount ?? amount.toString(),
    withdrawal: { ...withdrawalOptions(config, tuple, swap), ...input.options },
    proverTip: input.proverTip,
  }
}

/**
 * One sponsored burn through {@link runBurn}, then the sponsor bookkeeping once mined. `mined` is
 * false for a burn left to the chain.
 */
export async function runSponsoredBurn(
  op: OperationHandle,
  deps: WithdrawKit,
  { tokenSymbol, tokenDecimals, sponsor, tuple, deployment }: BurnContext,
  input: SponsoredBurnInput,
  onStage: (stage: WithdrawStage) => void,
): Promise<{ record: WithdrawalRecord; mined: boolean }> {
  const { recipient, recipientAlias, amount, swap, swapCommit } = input
  const [exit, withdrawalFee] = await Promise.all([
    sponsoredExit(deps.session.page.config, tuple, input),
    withdrawalExecutorFee(deps.session.page.chain, tuple),
  ])

  const { record, result } = await runBurn({
    op,
    session: deps.session,
    record: {
      recipient,
      recipientProvenance: "saved-recipient",
      recipientAlias: recipientAlias?.trim() || undefined,
      amount: formatUnits(amount, tokenDecimals),
      rawAmount: amount.toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      ...(withdrawalFee ? { withdrawalFee: withdrawalFee.toString() } : {}),
      ...(exit.proverTip ? { proverTip: exit.proverTip.toString() } : {}),
      tokenSymbol,
      tokenDecimals,
      phase: "submitting",
      startTime: Date.now(),
      deployment,
      ...swapRecordFields(swap, swapCommit),
      ...input.record,
    },
    burn: (_record, onTxHash) => {
      onStage("proving")
      return deps.tokenService.exitToL1PrivateSponsored(exit.l1Recipient, exit.amount, sponsor, {
        operationId: op.operationId,
        onTxHash,
        userAccount: deps.account,
        useRawAmount: true,
        withdrawal: exit.withdrawal,
        proverTip: exit.proverTip,
      })
    },
    minedFigures: async (burned) => ({
      amount: burned.amount.toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
    }),
  })
  if (!result) return { record, mined: false }
  onStage("submitting")
  noteSponsoredMine(deps, sponsor, "withdrawal")
  return { record, mined: true }
}

/** A sponsored burn mined: the subscription and the FPC's fuel are noted; nothing after the mine fails the burn. */
export function noteSponsoredMine(
  deps: Parameters<typeof noteSubscribed>[0] &
    Pick<AccountKit, "wallet" | "contractService"> & { session: Pick<Session, "oweFpcRefuel"> },
  sponsor: Awaited<ReturnType<typeof claimSponsorContext>>,
  what: string,
): void {
  try {
    if (sponsor.subscribe) noteSubscribed(deps, sponsor.fpcAddress, sponsor.railId)
    deps.session.oweFpcRefuel({ address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact })
  } catch (err) {
    console.warn(`[withdrawGateway] ${what} mined; sponsor bookkeeping failed:`, err)
  }
}

/** This wallet's Oxide account and its secret: the one handed in, else the unlocked passkey secret. */
export async function sessionSwapRecoverer(
  session: Pick<Session, "auth" | "page">,
  tuple: OxideEnvTuple,
  secret?: Fr,
): Promise<SwapRecoverer> {
  const msk = secret ?? (await session.auth.getSecretKey())
  if (!msk) throw new Error("Unlock your wallet with your passkey and try again.")
  const account = await predictAccountAddress(
    l1PublicClient(session.page.config),
    requireTupleField(tuple, "accountFactory") as Address,
    deriveBootstrapKey(msk).address,
  )
  return { account, secret: msk }
}
