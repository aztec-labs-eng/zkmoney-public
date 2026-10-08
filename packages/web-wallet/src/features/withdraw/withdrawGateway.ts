/**
 * The L2→L1 withdrawal rail for the browser, composing the shared machinery
 * (`TokenService.exitToL1PrivateSponsored`, `WithdrawalStorage`,
 * `WithdrawalTrackingService`, `resolveWithdrawalWiring`) over browser
 * collaborators. The burn is ClaimFPC-sponsored — web has no fee service, so
 * the FPC batch is the only fee rail — and finalization is oxide's headless
 * relayer: once the burn is mined this module only ARMS the chain watcher.
 *
 * The tracker singleton needs the wallet's node plus an sdk
 * `L1WithdrawalFinalizationReader` over the tuple's portal; front-core
 * originates no contract call. Boot is memoized per page load and re-armed by
 * `useWithdrawals` whenever a wallet is available.
 */
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { TxHash } from "@aztec/stdlib/tx"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, Hex } from "viem"
import { createPublicClient, formatUnits, parseUnits } from "viem"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  ContractService,
  createWithdrawEventSource,
  fetchWithdrawalsWithIds,
  L1SwapEscrowReader,
  L1WithdrawalFinalizationReader,
  nextOperationId,
  planSwapOnWithdraw,
  predictAccountAddress,
  readPortalWithdrawalState,
  type ObsidionAccount,
  type ObsidionWallet,
  type SponsoredExitAuthorization,
  type SwapOnWithdrawOutput,
  type SwapOnWithdrawPlan,
  type SwapSimulation,
  type TokenService,
  type WithdrawalOptions,
} from "@obsidion/sdk"
import {
  deriveBootstrapKey,
  deriveSwapEscrowRecoverySalt,
  newWithdrawalLocalId,
  rebuildWithdrawals,
  resolveWithdrawalWiring,
  trackWithdrawalSubmission,
  withdrawalRecipients,
  type WithdrawalDeployment,
  WithdrawalStorage,
  WithdrawalTrackingService,
  type AddressScreener,
  type FieldLike,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { getConfig, l1Transport } from "../../config/env"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { isFlowCancelled, runOperation, type OperationHandle } from "../operations/operations"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { maybeRefuelFpc } from "../fees/fpcRefuel"
import { currentFpcFundingCut, fpcFundingCut } from "../fees/fpcFundingCut"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { claimSponsorContext, noteSubscribed } from "../onboarding/claimSponsorship"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { slowWhenHidden } from "../../platform/visibilityScheduler"
import { assertWithinWithdrawalLimit } from "../limits/withdrawalLimit"
import type { WithdrawalReceiveAsset } from "./withdrawAssets"

/** Progress stages the modal's proving view renders. */
export type WithdrawStage = "building" | "proving" | "submitting"

/** What a swap route commits to at confirm: the tip the escrow pays, and the estimate the record keeps. */
export type SwapCommit = Pick<SwapSimulation, "relayerTip" | "amountOut" | "decimals">

export function getWithdrawalStore(): WithdrawalStorage {
  return WithdrawalStorage.get(webStorage)
}

let trackerBoot: Promise<WithdrawalTrackingService | null> | undefined

function l1Client() {
  const config = getConfig()
  return createPublicClient({ chain: config.l1Chain, transport: l1Transport(config) })
}

/** The live deployment's withdrawal coordinates, stamped on every new record. */
export async function currentDeployment(
  source?: OxideEnvTuple,
): Promise<WithdrawalDeployment | undefined> {
  const config = getConfig()
  const tuple = source ?? (await getOxideTuple(config))
  const wiring = resolveWithdrawalWiring(tuple, BigInt(config.l1ChainId))
  return wiring ? { portal: wiring.portal, l2Token: tuple.l2Token } : undefined
}

/**
 * The withdrawal a burn tx published, read from its tx effect — the authoritative amount and tip,
 * as opposed to whatever the caller believed it was burning. Undefined off the oxide rails.
 */
export async function publishedBurn(
  node: ObsidionWallet["node"],
  l2TxHash: string,
  source?: OxideEnvTuple,
) {
  const config = getConfig()
  const wiring = resolveWithdrawalWiring(
    source ?? (await getOxideTuple(config)),
    BigInt(config.l1ChainId),
  )
  if (!wiring) return undefined
  const { withdrawals } = await fetchWithdrawalsWithIds(
    node,
    TxHash.fromString(l2TxHash),
    wiring.portalContext,
  )
  return withdrawals[0]
}

/**
 * Boot (once per page load) and resume the chain watcher. Returns null when
 * the manifest lacks the oxide-rails coordinates — withdrawals are simply
 * unavailable there. A failed boot is not sticky; the next call retries.
 */
export function ensureWithdrawalTracker(
  wallet: ObsidionWallet,
): Promise<WithdrawalTrackingService | null> {
  if (!trackerBoot) {
    const boot = (async () => {
      const config = getConfig()
      const tuple = await getOxideTuple(config)
      const wiring = resolveWithdrawalWiring(tuple, BigInt(config.l1ChainId))
      if (!wiring) return null
      const publicClient = l1Client() as unknown as ConstructorParameters<
        typeof L1WithdrawalFinalizationReader
      >[0]
      const readerFor = (d: { portal: Hex }) =>
        new L1WithdrawalFinalizationReader(publicClient, { portal: d.portal })
      const tracker = WithdrawalTrackingService.get({
        // Slowed rather than stopped behind a hidden tab: an exit already burned on L2 has to keep
        // advancing through its phases, or it sits unfinalized until someone looks at the wallet.
        scheduler: slowWhenHidden(3),
        store: getWithdrawalStore(),
        node: wallet.node,
        finalizationReader: readerFor(wiring),
        portalContext: wiring.portalContext,
        // A burn on a since-retired deployment finalizes on ITS portal, not the live one.
        readerForDeployment: readerFor,
        // The swap leg watches the escrow itself; the factory comes off each record.
        swapEscrowReader: new L1SwapEscrowReader(publicClient, {
          dai: requireTupleField(tuple, "token") as Address,
        }),
      })
      await tracker.resumeAll()
      return tracker
    })()
    trackerBoot = boot
    boot.catch(() => {
      if (trackerBoot === boot) trackerBoot = undefined
    })
  }
  return trackerBoot
}

let rescan: Promise<WithdrawalRecord[]> | undefined

/**
 * Once per page load: rebuild the records this browser lost from the account's own `Withdraw`
 * events and arm the watcher for them. Reading the events syncs PXE first, so a fresh device gets
 * its whole history. Resolves to the records created; a failed pass is not sticky.
 */
export function rescanWithdrawals(
  wallet: ObsidionWallet,
  tokenService: Pick<TokenService, "fetchTokenInformation">,
): Promise<WithdrawalRecord[]> {
  if (!rescan) {
    const pass = (async () => {
      const identity = loadWalletIdentity()
      if (!identity) return []
      const token = await tokenService.fetchTokenInformation()
      const rebuilt = await rebuildWithdrawals({
        source: createWithdrawEventSource({
          wallet,
          tokenAddress: token.address,
          accountAddress: identity.address,
        }),
        store: getWithdrawalStore(),
        tokenSymbol: token.symbol,
        deployment: await currentDeployment(),
      })
      if (rebuilt.length === 0) return rebuilt
      const tracker = await ensureWithdrawalTracker(wallet)
      for (const record of rebuilt) await tracker?.watch(record)
      return rebuilt
    })()
    rescan = pass
    pass.catch(() => {
      if (rescan === pass) rescan = undefined
    })
  }
  return rescan
}

export interface WithdrawDeps {
  wallet: ObsidionWallet
  account: ObsidionAccount
  tokenService: TokenService
  contractService: ContractService
  screener: AddressScreener
}

/**
 * Run a sponsored withdrawal end to end: refuse an amount over the per-withdrawal limit, screen the
 * recipient, then {@link runBurn} through the ClaimFPC batch. The record is the source of truth
 * from there: oxide's relayer finalizes on L1 and the tracker walks the phases to `done`.
 */
export function submitSponsoredWithdrawal(
  deps: WithdrawDeps,
  recipient: Address,
  amountDisplay: string,
  onStage: (stage: WithdrawStage) => void,
  recipientAlias?: string,
  receiveAsset: WithdrawalReceiveAsset = "DAI",
  swap?: SwapCommit,
  proverTip = 0n,
): Promise<WithdrawalRecord> {
  const summary = `$${amountDisplay} to ${recipientAlias?.trim() || "Ethereum"}`
  return runOperation(
    { operationId: nextOperationId("withdraw"), flow: "withdraw", summary },
    (op) =>
      submitSponsoredWithdrawalFlow(
        op,
        deps,
        recipient,
        amountDisplay,
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

export interface BurnInput<R extends BurnResult> {
  op: OperationHandle
  wallet: ObsidionWallet
  /** The record seeded before the burn is sent, so a reload mid-prove finds it. */
  record: Omit<WithdrawalRecord, "localId" | "operationId">
  /** Signs, proves and sends the burn off the persisted record; resolves on the L2 receipt. */
  burn: (record: WithdrawalRecord) => Promise<R>
  /** The mined amount and tip; the seeded record's figures stand in when absent or rejected. */
  minedFigures?: (result: R) => Promise<{ amount: string; relayerTip: string } | undefined>
}

/**
 * The one burn sequence behind every L2→L1 exit. Seeds the withdrawal record, stamps its hash at
 * submit, and runs the burn. A burn that may still land is returned unmined, left to the chain and
 * the tracker (`result` absent). One that never went out drops its seed on a cancel and is marked
 * `failed` otherwise, then rethrows. A mined burn is marked mined and armed on the tracker; nothing
 * after the mine fails the record, so callers keep their own bookkeeping off it too.
 */
export async function runBurn<R extends BurnResult>(
  input: BurnInput<R>,
): Promise<{ record: WithdrawalRecord; result?: R }> {
  const { op, wallet } = input
  const store = getWithdrawalStore()
  await store.load()
  const localId = newWithdrawalLocalId()
  const record = await store.create({ ...input.record, localId, operationId: op.operationId })
  const submission = trackWithdrawalSubmission(store, localId, op.operationId)
  let result: R
  try {
    result = await input.burn(record)
  } catch (err) {
    const pending = await submission.recover(wallet.node)
    if (pending) {
      op.leaveToChain(pending.l2TxHash ?? submission.txHash)
      await ensureWithdrawalTracker(wallet)
        .then((tracker) => tracker?.watch(pending))
        .catch(() => {})
      return { record: pending }
    }
    // A cancel thrown from a stage callback lands before the burn: drop the seed, not fail it.
    if (isFlowCancelled(err)) {
      await store.remove(localId).catch(() => {})
    } else {
      const message = err instanceof Error ? err.message : "Withdrawal failed"
      await store.patch(localId, { phase: "failed", error: message }).catch(() => {})
    }
    throw err
  } finally {
    await submission.stop()
  }
  const figures = await input.minedFigures?.(result).catch(() => undefined)
  let mined: WithdrawalRecord
  try {
    mined = await store.markMined(
      localId,
      result.txHash,
      result.blockNumber,
      figures?.amount ?? record.rawAmount ?? "0",
      figures?.relayerTip ?? record.relayerTip,
    )
  } catch (err) {
    // Mined but not recorded as such: the tracker picks it up from the stamped hash.
    console.warn("[withdrawGateway] burn mined; its record could not be updated:", err)
    op.leaveToChain(result.txHash)
    return { record: store.get(localId) ?? record }
  }
  // Oxide's relayer finalizes the burn regardless, and `OperationsMount` resumes the tracker on the
  // next load.
  try {
    const tracker = await ensureWithdrawalTracker(wallet)
    await tracker?.watch(mined)
  } catch (err) {
    console.warn("[withdrawGateway] burn mined; watcher arm failed (resumed on next load):", err)
  }
  return { record: mined, result }
}

/** The swap leg, fully built during planning: the plan the record persists and the burn pays. */
export interface SwapLeg {
  source: { portal: string; l2Token: string }
  output: SwapOnWithdrawOutput
  plan: SwapOnWithdrawPlan
  /** The factory the escrow address was derived from; stored so a later exit targets the same one. */
  factory: Address
}

/**
 * Who may recover a swap escrow the route cannot deliver, and the secret its recovery salt derives
 * from. A signed-in wallet's own Oxide account by default.
 */
export interface SwapRecoverer {
  account: Address
  secret: FieldLike
}

/**
 * Plan the swap leg of a burn. A non-DAI output burns to oxide's counterfactual SwapEscrow instead
 * of the recipient; the sdk pairs the escrow's swap with the release in the Broadcaster call riding
 * the burn tx, so a mined burn implies a mined broadcast. Call it before the record exists, so a
 * bad manifest aborts with nothing persisted and the escrow args land on the record before the
 * burn is sent.
 * Undefined for DAI.
 */
export async function planSwapLeg(
  _wallet: ObsidionWallet,
  receiveAsset: WithdrawalReceiveAsset,
  recipient: Address,
  amount: bigint,
  commit?: SwapCommit,
  recoverer?: SwapRecoverer,
  source?: OxideEnvTuple,
  /** Must match the burn's, which the escrow's funding is net of. */
  proverTip = 0n,
): Promise<SwapLeg | undefined> {
  if (receiveAsset === "DAI") return undefined
  if (!commit) throw new Error("Swap fee unavailable. Withdraw DAI instead.")
  const tuple = source ?? (await getOxideTuple(getConfig()))
  requireTupleField(tuple, "l2Broadcaster")
  const swapEscrowFactory = requireTupleField(tuple, "swapEscrowFactory") as Address
  const cut = await fpcFundingCut(l1PublicClient(getConfig()), tuple.portal as Address)
  const nonce = Fr.random().toString() as Hex
  const { account, secret } = recoverer ?? (await ownSwapRecoverer(tuple))
  const plan = planSwapOnWithdraw({
    swapEscrowFactory,
    output: receiveAsset,
    l1Recipient: recipient,
    amount,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    proverTip,
    fpcFundingCut: cut,
    relayerTip: commit.relayerTip,
    recovery: { account, salt: deriveSwapEscrowRecoverySalt(secret, nonce) },
    nonce,
  })

  return {
    output: receiveAsset,
    source: { portal: tuple.portal, l2Token: tuple.l2Token },
    plan,
    factory: swapEscrowFactory,
  }
}

/**
 * How a burn from `tuple` settles: the deployment, its portal's state for the sdk's relayer-tip
 * check, and the swap leg the burn pays. Read before the record exists, so an unreadable portal
 * aborts with nothing persisted.
 */
export async function withdrawalOptions(
  tuple: OxideEnvTuple,
  swap?: SwapLeg,
): Promise<WithdrawalOptions> {
  const portal = await readPortalWithdrawalState(
    l1PublicClient(getConfig()),
    requireTupleField(tuple, "portal") as Address,
  )
  return { tuple, portal, ...(swap ? { swap: swap.plan } : {}) }
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
    swapRecoveryCommitment: swap.plan.escrowArgs.recoveryCommitment,
    swapNonce: swap.plan.escrowArgs.nonce,
    swapRelayerTip: swap.plan.escrowArgs.relayerTip.toString(),
    swapEstimatedOut: quote?.amountOut.toString(),
    swapOutputDecimals: quote?.decimals,
  }
}

async function submitSponsoredWithdrawalFlow(
  op: OperationHandle,
  deps: WithdrawDeps,
  recipient: Address,
  amountDisplay: string,
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
  const amount = parseUnits(amountDisplay, DEFAULT_DECIMALS)
  assertWithinWithdrawalLimit(amount)
  const ctx = await burnContext(deps, recipient)
  const swap = await planSwapLeg(
    deps.wallet,
    receiveAsset,
    recipient,
    amount,
    swapCommit,
    undefined,
    ctx.tuple,
    proverTip,
  )
  const burn = { recipient, recipientAlias, amount, swap, swapCommit, proverTip }
  return (await runSponsoredBurn(op, deps, ctx, burn, onStage)).record
}

/** What a sponsored burn to `recipient` settles against, read before any record exists. */
export async function burnContext(deps: WithdrawDeps, recipient: Address) {
  // Re-screen at the commit point, before any record or burn exists: oxide's relayer enforces
  // the same policy at batching time, where a blocked recipient means a burned-but-never-
  // finalized withdrawal. A screener throw (verdict unknown) also aborts — fail closed. For a
  // swap withdrawal the burn recipient is a fresh counterfactual escrow, so this screen on the
  // swap-output recipient is the only meaningful one.
  const verdict = await deps.screener.screen(recipient)
  if (!verdict.compliant) {
    throw new Error(verdict.reason?.message ?? "This address can't receive withdrawals")
  }

  const token = await deps.tokenService.fetchTokenInformation()
  const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)

  const tuple = await getOxideTuple(getConfig())
  return { tokenSymbol: token.symbol, sponsor, tuple, deployment: await currentDeployment(tuple) }
}

export type BurnContext = Awaited<ReturnType<typeof burnContext>>

export interface SponsoredBurnInput {
  recipient: Address
  recipientAlias?: string
  /** Atomic units of the wallet asset the burn removes. */
  amount: bigint
  /** The planned swap leg and the quote it was confirmed on; both absent for DAI. */
  swap?: SwapLeg
  swapCommit?: SwapCommit
  /** Laid over the record and the sdk options every sponsored burn shares. */
  record?: Partial<WithdrawalRecord>
  options?: Partial<WithdrawalOptions>
  /** This burn's share of a signature taken over several; absent, the burn signs for itself. */
  authorization?: SponsoredExitAuthorization
  /** The exit that signature covered; absent, the burn reads its own. */
  exit?: Awaited<ReturnType<typeof sponsoredExit>>
  /** Paid to the first prover of the burn's checkpoint, out of the burn. */
  proverTip?: bigint
}

/**
 * What a sponsored burn hands the sdk, off the fields its record is seeded with. Read before the
 * record exists, so a signature taken over an exit covers the very one the burn runs.
 */
export async function sponsoredExit(tuple: OxideEnvTuple, input: SponsoredBurnInput) {
  const { recipient, amount, swap } = input
  const seed = { recipient, ...swapRecordFields(swap), ...input.record }
  return {
    l1Recipient: EthAddress.fromString(withdrawalRecipients(seed).release),
    amount: seed.rawAmount ?? amount.toString(),
    withdrawal: { ...(await withdrawalOptions(tuple, swap)), ...input.options },
    proverTip: input.proverTip,
  }
}

/**
 * One sponsored burn through {@link runBurn}, then the sponsor bookkeeping once mined. `mined` is
 * false for a burn left to the chain.
 */
export async function runSponsoredBurn(
  op: OperationHandle,
  deps: WithdrawDeps,
  { tokenSymbol, sponsor, tuple, deployment }: BurnContext,
  input: SponsoredBurnInput,
  onStage: (stage: WithdrawStage) => void,
): Promise<{ record: WithdrawalRecord; mined: boolean }> {
  const { recipient, recipientAlias, amount, swap, swapCommit } = input
  const fpcFundingCut = await currentFpcFundingCut()
  const exit = input.exit ?? (await sponsoredExit(tuple, input))

  const { record, result } = await runBurn({
    op,
    wallet: deps.wallet,
    record: {
      recipient,
      recipientProvenance: "saved-recipient",
      recipientAlias: recipientAlias?.trim() || undefined,
      amount: formatUnits(amount, DEFAULT_DECIMALS),
      rawAmount: amount.toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      ...(exit.proverTip ? { proverTip: exit.proverTip.toString() } : {}),
      fpcFundingCut: fpcFundingCut.toString(),
      tokenSymbol,
      phase: "submitting",
      startTime: Date.now(),
      deployment,
      ...swapRecordFields(swap, swapCommit),
      ...input.record,
    },
    burn: () => {
      onStage("proving")
      return deps.tokenService.exitToL1PrivateSponsored(exit.l1Recipient, exit.amount, sponsor, {
        operationId: op.operationId,
        userAccount: deps.account,
        useRawAmount: true,
        withdrawal: exit.withdrawal,
        authorization: input.authorization,
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
  try {
    if (sponsor.subscribe) noteSubscribed(deps.account, sponsor.fpcAddress, sponsor.railId)
    maybeRefuelFpc({ ...deps, fpc: { address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact } })
  } catch (err) {
    console.warn("[withdrawGateway] withdrawal mined; sponsor bookkeeping failed:", err)
  }
  return { record, mined: true }
}

/** This wallet's Oxide account and its secret; needs the unlocked passkey secret. */
export async function ownSwapRecoverer(tuple: OxideEnvTuple): Promise<SwapRecoverer> {
  const msk = await getAuthService().getSecretKey()
  if (!msk) throw new Error("Unlock your wallet with your passkey and try again.")
  const account = await predictAccountAddress(
    l1PublicClient(getConfig()),
    requireTupleField(tuple, "accountFactory") as Address,
    deriveBootstrapKey(msk).address,
  )
  return { account, secret: msk }
}
