import { assertPaylinkSwapSource, readPaylinkSource } from "./paylinkSource"
/**
 * Web glue for direct and email-locked ClaimFPC-sponsored paylinks.
 * The sponsored create/claim/view orchestration lives in the
 * shared `PaylinkService`; this module only supplies
 * the web-specific inputs: the ClaimFPC sponsor context (via
 * `claimSponsorContext`), the localStorage-parked
 * funding-deposit redemption, and the amount/link formatting. Screens build
 * `PaylinkService` from the shared front-core contexts and call these helpers.
 */
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { TxHash } from "@aztec/stdlib/tx"
import { formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem"
import type { PaylinkL1Proof } from "@obsidion/sdk"
import { paylinkIdentity } from "@obsidion/front-core"
import {
  trackSubmission,
  trackWithdrawalSubmission,
  TxInFlightError,
  type SubmissionTracker,
} from "@obsidion/front-core"
import {
  PaylinkService,
  ContractService,
  encodePaylinkInline,
  decodePaylinkInline,
  nextOperationId,
  PaylinkActionEnum,
  QueueStatus,
  claimFpcSubscriptionUses,
  hasClaimFpcSubscription,
  paylinkVoucherUses,
  UnknownRailError,
  type ClaimSponsorContext,
  type ObsidionAccount,
  type ObsidionWallet,
  type TeeSigner,
  type TokenService,
  type WithdrawalOptions,
} from "@obsidion/sdk"
import {
  DEFAULT_CONTRACTS,
  PAYLINK_GRACE_PERIOD_SECONDS,
  SECONDS_IN_A_DAY,
  tokenDecimalsForNetwork,
  ZKJWT_VKEY_HASH,
  WITHDRAW_RELAYER_TIP,
  GOLDEN_TICKET_PROVER_TIP,
} from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  parseEscrowAmount,
  PaylinkWindowClosedError,
  TransactionStorage,
  TxLifecycleService,
  type PaylinkTransaction,
  newWithdrawalLocalId,
  upsertSavedL1WalletContact,
  type AddressScreener,
  type WithdrawalRecord,
  readPaylinkNote,
  patchClaimRowMemo,
  paylinkWindows,
  withdrawalAmounts,
  withdrawalRecipients,
  PendingRegistrationStore,
  goldenTicketCoverage,
} from "@obsidion/front-core"
import {
  loadRegistrationTerms,
  PAYLINK_TICKET_REFUSED_MESSAGE,
  registrationOffer,
  signedSchedule,
} from "../onboarding/registrationTerms"
import { fpcFundingCut } from "../fees/fpcFundingCut"
import { isFlowCancelled, runOperation, type OperationHandle } from "../operations/operations"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { withTimeout } from "../../lib/withTimeout"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { amountBucket, firePaylinkEvent, paylinkPh, type PaylinkEvent } from "../../lib/analytics"
import { holdSigningFlow } from "../../lib/passkeyTelemetry"
import { getConfig } from "../../config/env"
import { emailLockedLinksEnabled } from "../../config/features"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { maybeRefuelFpc } from "../fees/fpcRefuel"
import { findHistoricTuple, historicTokenContext } from "../migration/historicTokenContext"
import {
  claimSponsorContext,
  claimSponsorRail,
  noteSubscribed,
} from "../onboarding/claimSponsorship"
import { latestChainSeconds } from "./chainTime"
import { canCancelAt } from "./claimWindow"
import { RAIL_REGISTERED, RAIL_VOUCHER } from "../onboarding/rails"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import type { WithdrawalReceiveAsset } from "../withdraw/withdrawAssets"
import {
  currentDeployment,
  ensureWithdrawalTracker,
  getWithdrawalStore,
  planSwapLeg,
  publishedBurn,
  runBurn,
  swapRecordFields,
  withdrawalOptions,
  type SwapCommit,
  type SwapLeg,
  type WithdrawStage,
} from "../withdraw/withdrawGateway"
import type { CreateStage, LinkFlavor, PaymentLink } from "./types"

/** How long a fresh link stays claimable when the creator picks no expiry. */
export const DEFAULT_CLAIM_WINDOW_DAYS = 30
/** E2e-only: opens a `from_claimable` grace window (seconds after chain now). Unset = {@link PAYLINK_GRACE_PERIOD_SECONDS}. */
const GRACE_PERIOD_OVERRIDE = import.meta.env.VITE_E2E_PAYLINK_GRACE_SECONDS as string | undefined
const PENDING_DEPOSITS_KEY = "webwallet.pendingDeposits"
/** Cap on `viewLink`'s escrow-note read; see the call site. */
const NOTE_READ_TIMEOUT_MS = 20_000
/** Cap on the allowance reads behind `voucherAvailable`; a stalled read must not pin the review sheet. */
const VOUCHER_CHECK_TIMEOUT_MS = 8_000

export interface SponsoredPaylinkDeps {
  wallet: ObsidionWallet
  account: ObsidionAccount
  tokenService: TokenService
  contractService: ContractService
  teeSigner: TeeSigner
  /** Active network's rollup address (hydrated by AztecContext at boot) — a `paylinkPh` input. */
  rollupAddress: string
}

/** Wallet + contract service are enough for the nullifier status read (no passkey). */
export interface ViewLinkDeps {
  wallet: ObsidionWallet
  contractService: ContractService
  /** When present, `sync_note` simulates from this account instead of the placeholder. */
  account?: ObsidionAccount
  tokenService?: TokenService
}

interface PendingDeposit {
  leafIndex: string
  amount: string
  recipient: string
  messageSecret: string
}

function service(deps: SponsoredPaylinkDeps): PaylinkService {
  return new PaylinkService(
    deps.wallet,
    deps.account,
    deps.tokenService,
    deps.contractService,
    undefined,
    deps.teeSigner,
  )
}

/** Parked funding deposits, or [] when the key is absent or unparseable. */
function readPendingDeposits(): PendingDeposit[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_DEPOSITS_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Whether spendable funds exist that the displayed balance cannot see. `createSponsoredLink`
 * redeems parked deposits itself and the escrow claims them in the same tx, so an account funded
 * this way creates links fine while `assets` still reads zero — the overspend gate has to stand
 * down rather than block a create that would have worked.
 */
export function hasPendingDeposits(): boolean {
  return readPendingDeposits().length > 0
}

/**
 * Redeem funding deposits parked in localStorage by `pnpm sandbox:fund-oxide`
 * (STORE PARAMS): `store_deposit` is a free utility sim in this PXE;
 * the create tx then claims the deposit lazily.
 */
async function redeemPendingDeposits(deps: SponsoredPaylinkDeps): Promise<void> {
  const pending = readPendingDeposits()
  if (pending.length === 0) return
  const token = await deps.tokenService.getTokenContract()
  const user = deps.account.getAddress()
  const remaining: PendingDeposit[] = []
  for (const dep of pending) {
    try {
      await token.methods.store_deposit!(
        new Fr(BigInt(dep.leafIndex)),
        BigInt(dep.amount),
        AztecAddress.fromStringUnsafe(dep.recipient),
        Fr.fromHexString(dep.messageSecret),
      ).simulate({ from: user })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/already|dedup/i.test(msg)) remaining.push(dep)
    }
  }
  localStorage.setItem(PENDING_DEPOSITS_KEY, JSON.stringify(remaining))
}

/**
 * Activity rows ride the shared TxLifecycleService → TransactionStorage path: a
 * Pending PaylinkTransaction row before sign/prove, its txHash written at the submit boundary
 * (`saveRowTxHash`), paylink fields patched after. No lifecycle poller runs on web, so the row is
 * terminalized here as soon as the sponsored call resolves, or by the chain after a reload.
 */
export async function startPaylinkRow(
  deps: SponsoredPaylinkDeps,
  svc: PaylinkService,
  kind: "paylink-create" | "paylink-claim" | "paylink-refund",
  action: PaylinkActionEnum.PAY | PaylinkActionEnum.CLAIM | PaylinkActionEnum.CLAIM_BACK,
  amountHuman: number | undefined,
  opts?: { flavor?: LinkFlavor; to?: string; memo?: string; operationId?: string },
): Promise<{ queueId: string; operationId: string }> {
  TransactionStorage.get(webStorage)
  const lifecycle = TxLifecycleService.getInstance()
  const queueId = await lifecycle.startTrackingTx(action, 240_000, svc)
  const token = await deps.tokenService.fetchTokenInformation()
  // One id for the row and the wallet call both: the submit boundary's hash is matched by it.
  const operationId = opts?.operationId ?? nextOperationId(kind)
  await lifecycle.recordPreSubmitPaylinkRow(queueId, operationId, {
    action,
    flavor: opts?.flavor ?? "direct",
    kind,
    ...(opts?.to !== undefined ? { to: opts.to } : {}),
    ...(opts?.memo !== undefined ? { memo: opts.memo } : {}),
    token: {
      symbol: token.symbol,
      name: token.name,
      address: token.address,
      logo: "",
      amount: amountHuman ?? 0,
      decimals: token.decimals,
      // Single USD-pegged asset; the activity feed multiplies amount × price.
      price: 1,
      hasUnknownAmount: amountHuman === undefined,
    },
    obsidionAccountAddress: deps.account.getAddress().toString(),
    tokenAddress: token.address,
  })
  return { queueId, operationId }
}

/** The operation's one-line name, e.g. "$25 paylink". */
function linkSummary(amount: string | number | null | undefined): string {
  return amount == null ? "Paylink" : `$${amount} paylink`
}

/** Writes the submitted hash onto the row, so the chain settles it even if this tab closes. */
function saveRowTxHash(queueId: string) {
  return (txHash: string) => TxLifecycleService.getInstance().patchTxHashForQueue(queueId, txHash)
}

export async function finishPaylinkRow(
  queueId: string,
  txHash: string,
  paylinkFields?: Parameters<TxLifecycleService["patchPaylinkSynthRow"]>[1],
): Promise<void> {
  const lifecycle = TxLifecycleService.getInstance()
  await lifecycle.patchTxHashForQueue(queueId, txHash)
  if (paylinkFields) await lifecycle.patchPaylinkSynthRow(queueId, paylinkFields)
  lifecycle.completeTransaction(queueId, QueueStatus.SUCCESS, txHash)
}

export async function failPaylinkRow(queueId: string, error: unknown): Promise<void> {
  if (isPasskeyCancelled(error)) {
    // Completion clears queueId, so remove the pre-submit row before releasing its tracking.
    const removed = await TransactionStorage.get(webStorage)
      .removeTransaction((tx) => tx.queueId === queueId && !tx.txHash)
      .catch(console.warn)
    if (removed) {
      TxLifecycleService.getInstance().completeTransaction(queueId, QueueStatus.CANCELLED)
      return
    }
  }
  TxLifecycleService.getInstance().completeTransaction(
    queueId,
    QueueStatus.FAILED,
    undefined,
    error instanceof Error ? error.message : String(error),
  )
}

/**
 * The error a rejected sponsored call surfaces. Past the submit boundary the transaction may still
 * land, so the row stays pending for the chain to settle and the caller gets a `TxInFlightError`
 * to report as such; otherwise the row is failed and the transport error stands.
 */
export async function paylinkFailure(
  queueId: string,
  error: unknown,
  submission: Pick<SubmissionTracker, "survived">,
  node: Parameters<SubmissionTracker["survived"]>[0],
): Promise<unknown> {
  const inFlight = await submission.survived(node)
  if (inFlight) return new TxInFlightError(inFlight, error)
  await failPaylinkRow(queueId, error)
  return error
}

/**
 * Predicate for THIS link's create row. Match secret and flavor: flavor is part of the row
 * identity, and of the key hash, so same-day direct and email links never share a secret.
 */
function createRowMatcher(secret: string, flavor: LinkFlavor, account?: string) {
  return (tx: unknown): boolean => {
    const ptx = tx as Partial<PaylinkTransaction> & { flavor?: LinkFlavor }
    return (
      ptx.emailPaymentAction === PaylinkActionEnum.PAY &&
      ptx.payToEmailSecret === secret &&
      ptx.flavor === flavor &&
      (account === undefined || ptx.obsidionAccountAddress === account)
    )
  }
}

/** When this account created the link, flip its PAY row to claimed. */
export async function markCreateRowClaimed(
  secret: string,
  flavor: LinkFlavor,
  account: string,
): Promise<void> {
  try {
    await TransactionStorage.get(webStorage).updateTransaction(
      createRowMatcher(secret, flavor, account),
      (tx) => {
        const ptx = tx as PaylinkTransaction
        ptx.isClaimed = true
        ptx.paylink = undefined
      },
    )
  } catch (e) {
    console.warn("marking own paylink row claimed failed:", e)
  }
}

/**
 * Flip the creator's PAY row to refunded, stamping the refund
 * transaction on it — that row is the only record of the round trip, so it carries both hashes.
 */
export async function markCreateRowRefunded(
  secret: string,
  flavor: LinkFlavor,
  account: string,
  refundTxHash?: string,
): Promise<void> {
  try {
    await TransactionStorage.get(webStorage).updateTransaction(
      createRowMatcher(secret, flavor, account),
      (tx) => {
        const ptx = tx as PaylinkTransaction
        ptx.isRefunded = true
        ptx.paylink = undefined
        if (refundTxHash) ptx.refundTxHash = refundTxHash
      },
    )
  } catch (e) {
    console.warn("marking own paylink row refunded failed:", e)
  }
}

/** Stamp the submitted refund on the creator's PAY row; the claim reconciler settles it from chain. */
export async function markCreateRowRefundSubmitted(
  secret: string,
  flavor: LinkFlavor,
  account: string,
  refundTxHash: string,
): Promise<void> {
  await TransactionStorage.get(webStorage).updateTransaction(
    createRowMatcher(secret, flavor, account),
    (tx) => {
      ;(tx as PaylinkTransaction).refundTxHash = refundTxHash
    },
  )
}

/**
 * This device's create row for a link, keyed by the fragment's secret + flavor — presence marks
 * the viewer as the creator; the full row feeds front-core's `paylinkRefundEligibility`.
 */
export async function creatorRowFor(fragment: string): Promise<PaylinkTransaction | null> {
  try {
    const params = decodePaylinkInline(fragment)
    const flavor: LinkFlavor =
      params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct"
    const rows = await TransactionStorage.get(webStorage).getTransactions()
    const row = rows.find(createRowMatcher(params.secret.toString(), flavor)) as
      | PaylinkTransaction
      | undefined
    return row ?? null
  } catch {
    return null
  }
}

/**
 * Funnel event for a settled lifecycle stage. Never awaited and never throws: the payment has
 * already succeeded by the time this runs, so nothing here may fail it.
 */
function emitPaylinkStage(
  stage: PaylinkEvent["stage"],
  flavor: LinkFlavor,
  deps: SponsoredPaylinkDeps,
  secret: { toBuffer(): Uint8Array },
  amount: bigint | undefined,
  decimals: number,
): void {
  void paylinkPh({ rollupAddress: deps.rollupAddress, secret })
    .then((ph) =>
      firePaylinkEvent({
        stage,
        flavor,
        amount_bucket: amount === undefined ? "unknown" : amountBucket(amount, decimals),
        paylink_ph: ph,
      }),
    )
    .catch(() => {})
}

export type CreatedLink = PaymentLink & { txHash: string }

export interface CreateLinkOptions {
  email?: string
  expiryDays?: number
  memo?: string
  voucher?: boolean
  /**
   * The share link, as soon as it exists — before the passkey prompt, while the deposit has yet to
   * prove. It opens the same escrow as the landed link, which additionally names the funding tx
   * (the claim side reads the memo off that tx).
   */
  onLink?: (link: PaymentLink) => void
}

/**
 * The link's voucher could not be read, so whether it still pays is unknown. The claim stops here
 * for a retry rather than deciding on a guess: a guess of "spent" sends a claimer with no rail of
 * their own to a refusal, and the voucher stays unspent either way.
 */
export class VoucherReadError extends Error {
  constructor(cause: unknown) {
    super("We couldn't check whether this link still pays for its claim. Please try again.", {
      cause,
    })
    this.name = "VoucherReadError"
  }
}

/** The voucher rail's sponsor context, or undefined where this deployment declares no such rail. */
async function voucherSponsor(
  deps: SponsoredPaylinkDeps,
): Promise<ClaimSponsorContext | undefined> {
  try {
    return (await claimSponsorRail(deps, RAIL_VOUCHER)).sponsor
  } catch (err) {
    if (err instanceof UnknownRailError) return undefined
    throw new VoucherReadError(err)
  }
}

/**
 * The link's own voucher, when its escrow still holds one: the sponsor context a claim pays itself
 * with, so a claimer fresh from signup needs no subscription. Undefined for an unvouchered or spent
 * link, which only a read that succeeded can say; a read that failed throws {@link VoucherReadError}.
 */
async function linkVoucher(
  deps: SponsoredPaylinkDeps,
  params: ReturnType<typeof decodePaylinkInline>,
): Promise<ClaimSponsorContext | undefined> {
  const sponsor = await voucherSponsor(deps)
  if (!sponsor) return undefined
  let uses: number
  try {
    uses = await withTimeout(
      paylinkVoucherUses(
        { wallet: deps.wallet, contractService: deps.contractService, sponsor },
        params,
      ),
      VOUCHER_CHECK_TIMEOUT_MS,
    )
  } catch (err) {
    throw new VoucherReadError(err)
  }
  return uses > 0 ? sponsor : undefined
}

/**
 * Whether a link created now can carry a voucher: the deployment offers the voucher rail and
 * the creator's allowance covers both the create and the gift it pops. A creator not yet subscribed
 * on the open rail subscribes in the create batch and holds the whole allowance. Never throws — a
 * link without a voucher is still a link.
 */
export async function voucherAvailable(deps: SponsoredPaylinkDeps): Promise<boolean> {
  try {
    return await withTimeout(
      (async () => {
        // The deployment has to offer the rail at all — an older one has no voucher slot.
        await claimSponsorRail(deps, RAIL_VOUCHER)
        const { sponsor } = await claimSponsorRail(deps, RAIL_REGISTERED)
        const user = deps.account.getAddress()
        const uses = await claimFpcSubscriptionUses(
          deps.wallet,
          sponsor.fpcAddress,
          sponsor.fpcArtifact,
          user,
          sponsor.railId,
        )
        if (uses >= 2) return true
        // A stored 0 is either no subscription (the create subscribes, full allowance) or an
        // allowance spent today; 1 covers the create alone.
        if (uses === 1) return false
        return !(await hasClaimFpcSubscription(
          deps.wallet,
          sponsor.fpcAddress,
          sponsor.fpcArtifact,
          user,
          sponsor.railId,
        ))
      })(),
      VOUCHER_CHECK_TIMEOUT_MS,
    )
  } catch {
    return false
  }
}

/** An email-locked link, or an email lock at creation, while `emailLockedLinksEnabled` is off. */
export class EmailPaylinkUnsupportedError extends Error {
  constructor() {
    super("Email-locked payment links aren't supported in this wallet.")
    this.name = "EmailPaylinkUnsupportedError"
  }
}

/**
 * Create a ClaimFPC-sponsored paylink (direct, or email-locked when `email` is
 * set); resolves once the funding tx lands. `voucher` gifts the link one sponsored transaction
 * out of the creator's allowance (`voucherAvailable` says whether it can). An email lock is
 * refused, never dropped, while email-locked links are off.
 */
export function createSponsoredLink(
  deps: SponsoredPaylinkDeps,
  amountDisplay: string,
  onStage?: (stage: CreateStage) => void,
  opts: CreateLinkOptions = {},
): Promise<CreatedLink> {
  if (opts.email && !emailLockedLinksEnabled) {
    return Promise.reject(new EmailPaylinkUnsupportedError())
  }
  const decimals = tokenDecimalsForNetwork(getConfig().network)
  const summary = linkSummary(parseEscrowAmount(amountDisplay, decimals).human)
  return runOperation(
    { operationId: nextOperationId("paylink-create"), flow: "paylink-create", summary },
    (op) => createSponsoredLinkFlow(op, deps, amountDisplay, onStage, opts),
    (created) => created.txHash,
  )
}

async function createSponsoredLinkFlow(
  op: OperationHandle,
  deps: SponsoredPaylinkDeps,
  amountDisplay: string,
  onStage?: (stage: CreateStage) => void,
  opts: CreateLinkOptions = {},
): Promise<CreatedLink> {
  const { email, expiryDays = DEFAULT_CLAIM_WINDOW_DAYS, memo, voucher = false } = opts
  onStage?.("building")
  const svc = service(deps)
  const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)
  // A link matters more than the gift riding it: a voucher rail that has rolled away or cannot be
  // read since the review sheet asked costs the recipient a cash-out, not the creator their link.
  const voucherRail = voucher ? await voucherSponsor(deps).catch(() => undefined) : undefined
  await redeemPendingDeposits(deps)

  let emailInit: { address: string; registryAddress: AztecAddress; vkeyHash: Fr } | undefined
  if (email) {
    // The claim-side zkJWT proof is checked against this registry + vkey, bound
    // into the escrow note at deposit.
    const registryAddress = await deps.contractService.getContractAddress(
      DEFAULT_CONTRACTS.oidcKeyRegistry,
    )
    if (!registryAddress) {
      throw new Error(
        "Identity registry not available — email links can't be created on this network",
      )
    }
    emailInit = { address: email, registryAddress, vkeyHash: Fr.fromString(ZKJWT_VKEY_HASH) }
  }
  const flavor: LinkFlavor = email ? "email" : "direct"

  const decimals = tokenDecimalsForNetwork(getConfig().network)
  const { atomic: amount, human } = parseEscrowAmount(amountDisplay, decimals)
  // A locked session would derive random secrets, and the signing ceremony that unlocks it runs
  // too late to help. Fail before any funds move.
  const masterSecret = await getAuthService().getSecretKey()
  if (!masterSecret) throw new Error("wallet is locked — unlock before creating a paylink")

  // Anchor the windows AFTER the passkey ceremony — a slow approval must not eat the grace
  // period the creator is promised. Proving/inclusion delay still shortens it, but that is
  // machine time, not a human wait.
  const chainNow = BigInt(await latestChainSeconds(deps.wallet.node))
  // The escrow address derives from the `(day, n, flavor)` nonce, not the deposit params, so a
  // block-quantised claim window is collision-free.
  const windowSeconds = BigInt(expiryDays) * SECONDS_IN_A_DAY
  const graceSeconds = GRACE_PERIOD_OVERRIDE
    ? BigInt(GRACE_PERIOD_OVERRIDE)
    : PAYLINK_GRACE_PERIOD_SECONDS
  if (windowSeconds <= graceSeconds) {
    throw new Error(
      `paylink grace period (${graceSeconds}s) must be shorter than the claim window (${windowSeconds}s)`,
    )
  }
  const windows = paylinkWindows(chainNow, windowSeconds, graceSeconds)

  const { queueId, operationId } = await startPaylinkRow(
    deps,
    svc,
    "paylink-create",
    PaylinkActionEnum.PAY,
    human,
    { flavor, to: email, memo, operationId: op.operationId },
  )
  const rowFields = (p: { secret: Fr; fallbackSecret: Fr }, url: string) => ({
    payToEmailSecret: p.secret.toString(),
    fallbackSecret: p.fallbackSecret.toString(),
    fromClaimable: Number(windows.fromClaimable),
    untilClaimable: Number(windows.untilClaimable),
    refundableUntil: Number(windows.refundableUntil),
    paylink: url,
  })
  let params: Awaited<ReturnType<PaylinkService["createSponsoredPaylink"]>>
  let link: PaymentLink | undefined
  const submission = trackSubmission(operationId, saveRowTxHash(queueId))
  try {
    // createSponsoredPaylink runs sign → prove → submit in one call; emit a coarse
    // proving marker around it (the fine-grained sheet is the passkey prompt itself).
    // Inside the try so a cancel thrown from the stage callback fails the pending row.
    onStage?.("proving")
    params = await svc.createSponsoredPaylink(
      {
        amount,
        token: deps.tokenService.tokenAddress,
        window: windows,
        email: emailInit,
        memo,
        // Binds the paylink's secrets to the creator, so a refund needs only the link and the
        // passkey.
        masterSecret,
        ...(voucherRail ? { voucher: { railId: voucherRail.railId } } : {}),
      },
      sponsor,
      {
        // Correlates the TEE and prove benchmark legs → one tx_timing analytics event.
        operationId,
        // The fragment needs nothing from the funding tx, so the link exists before the passkey
        // prompt: the pending row carries it from here, and the caller can show it while the
        // proof runs.
        onPrepared: async (prepared) => {
          link = {
            ...linkShape(encodePaylinkInline(prepared), amount, decimals, flavor, email),
            memo,
          }
          await TxLifecycleService.getInstance().patchPaylinkSynthRow(
            queueId,
            rowFields(prepared, link.url),
          )
          opts.onLink?.(link)
        },
      },
    )
    if (sponsor.subscribe) noteSubscribed(deps.account, sponsor.fpcAddress, sponsor.railId)
    maybeRefuelFpc({ ...deps, fpc: { address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact } })
    onStage?.("submitting")
    if (!link) throw new Error("sponsored paylink create never prepared its link")
    // The row now carries the tx-bearing link: later copies let a claimer read the memo.
    link = { ...linkShape(encodePaylinkInline(params), amount, decimals, flavor, email), memo }
    await finishPaylinkRow(queueId, params.txHash, rowFields(params, link.url))
  } catch (e) {
    throw await paylinkFailure(queueId, e, submission, deps.wallet.node)
  } finally {
    await submission.stop()
  }
  emitPaylinkStage("created", flavor, deps, params.secret, amount, decimals)
  return { ...link, txHash: params.txHash }
}

/**
 * Sponsored claim paying out to the active account. Email-flavored links additionally need
 * `zkProof` (a claimer-bound zkJWT proof — see `emailClaim.ts`); the claim enqueues a public
 * `assert_valid` view on the OidcKeyRegistry, so that contract is registered in the PXE first.
 */
export async function claimSponsoredLink(
  deps: SponsoredPaylinkDeps,
  fragment: string,
  onStage?: (stage: CreateStage) => void,
  zkProof?: { vkey: string[]; proof: string[]; public_inputs: string[] },
  opts?: ClaimSponsoredLinkOptions,
): Promise<string> {
  // A claim that pays for a registration is the last step of a signup, signed with the passkey
  // just made, so its signature is reported as signup rather than as an ordinary approval. Three
  // screens can start it, which is why the flow is named here and not on any one of them.
  const release = opts?.fundRegistration ? holdSigningFlow("onboarding") : undefined
  try {
    return await runOperation(
      {
        operationId: nextOperationId("paylink-claim"),
        flow: "paylink-claim",
        summary: linkSummary(null),
      },
      (op) => claimSponsoredLinkFlow(op, deps, fragment, onStage, zkProof, opts),
      (txHash) => txHash,
    )
  } finally {
    release?.()
  }
}

export interface ClaimSponsoredLinkOptions {
  /** The claim pays for this account's pending registration: the SIPA burn is required, not optional. */
  fundRegistration?: boolean
}

/** Resolves to the claim tx hash. */
async function claimSponsoredLinkFlow(
  op: OperationHandle,
  deps: SponsoredPaylinkDeps,
  fragment: string,
  onStage?: (stage: CreateStage) => void,
  zkProof?: { vkey: string[]; proof: string[]; public_inputs: string[] },
  opts?: ClaimSponsoredLinkOptions,
): Promise<string> {
  onStage?.("building")
  const svc = service(deps)
  const params = decodePaylinkInline(fragment)
  const { sponsor, voucherRail } = await claimRail(deps, params, Boolean(opts?.fundRegistration))
  const isEmail = params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail
  if (isEmail && !zkProof) {
    throw new Error("This link is locked to an email — sign in first to prove ownership")
  }
  if (isEmail) {
    await deps.contractService.registerContractWithName(DEFAULT_CONTRACTS.oidcKeyRegistry)
  }
  const flavor: LinkFlavor = isEmail ? "email" : "direct"
  const decimals = tokenDecimalsForNetwork(getConfig().network)
  const note = await readPaylinkNote(svc, params)
  op.describe(linkSummary(note && formatUnits(note.amount, decimals)))
  const { queueId, operationId } = await startPaylinkRow(
    deps,
    svc,
    "paylink-claim",
    PaylinkActionEnum.CLAIM,
    note && Number(formatUnits(note.amount, decimals)),
    { flavor, operationId: op.operationId },
  )
  onStage?.("proving")
  let txHash: string
  let burn: Awaited<ReturnType<typeof seedRegistrationBurn>> | undefined
  // The claim is saved once its row holds the hash, and the burn riding it its record.
  const submission = trackSubmission(operationId, async (hash) => {
    await saveRowTxHash(queueId)(hash)
    if (burn && !(await burn.saved())) throw new Error("registration burn hash not saved")
  })
  try {
    const slice = await registrationSlice(deps, note?.amount, Boolean(opts?.fundRegistration))
    burn = slice ? await seedRegistrationBurn(deps, params, slice, operationId) : undefined
    try {
      txHash = await svc.claimSponsoredPaylink(params, sponsor, {
        operationId,
        ...(isEmail ? { zkProof } : {}),
        ...(voucherRail
          ? {
              voucher: {
                railId: voucherRail.railId,
                // Same-batch SIPA burn when this claim is paying for a pending registration.
                ...(slice ? { withdraw: burnArgs(slice) } : {}),
              },
            }
          : slice
          ? { withdraw: burnArgs(slice) }
          : {}),
      })
    } catch (err) {
      // A batch that went out is a claim that went out: the burn's record keeps its hash, and the
      // chain settles both.
      const broadcast = burn ? await burn.recover(err) : null
      if (!broadcast) throw err
      throw new TxInFlightError(broadcast, err)
    }
    await burn?.mined(txHash)
    patchClaimRowMemo(svc, params, queueId)
    if (sponsor.subscribe) noteSubscribed(deps.account, sponsor.fpcAddress, sponsor.railId)
    maybeRefuelFpc({ ...deps, fpc: { address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact } })
    onStage?.("submitting")
    await finishPaylinkRow(queueId, txHash)
    await markCreateRowClaimed(
      params.secret.toString(),
      flavor,
      deps.account.getAddress().toString(),
    )
  } catch (e) {
    if (e instanceof TxInFlightError) throw e
    throw await paylinkFailure(queueId, e, submission, deps.wallet.node)
  } finally {
    await submission.stop()
  }
  emitPaylinkStage("claimed", flavor, deps, params.secret, note?.amount, decimals)
  return txHash
}

/** Why a required registration burn could not go into the claim batch. */
export type RegistrationFundingRefusal =
  | "no_registration"
  | "not_ticket"
  | "blocked"
  | "expired"
  | "unpublished"
  | "no_schedule"
  | "unpriced"
  | "uncovered"

/**
 * A claim that was asked to fund a registration and cannot. Thrown instead of claiming plain: a
 * plain claim would credit the whole note and leave the name unfunded, which the caller never asked
 * for.
 */
export class RegistrationFundingError extends Error {
  constructor(readonly reason: RegistrationFundingRefusal, message: string) {
    super(message)
    this.name = "RegistrationFundingError"
  }
}

/** The burn a funding claim adds to its batch, with what priced it. */
export interface RegistrationSlice {
  l1Recipient: EthAddress
  /** The gross the batch burns. */
  amount: bigint
  relayerTip: bigint
  proverTip: bigint
  /** The portal's cut, priced on both legs. */
  fundingCut: bigint
  /** What the SIPA holds once the portal releases the burn. */
  target: bigint
  /** How the burn settles; its release broadcast rides the claim batch. */
  withdrawal: WithdrawalOptions
}

/** The burn as the batch takes it. */
function burnArgs({ l1Recipient, amount, proverTip, withdrawal }: RegistrationSlice) {
  return { l1Recipient, amount, proverTip, withdrawal }
}

/**
 * Who pays for the claim. A registered account rides its own rail, as every sponsored flow does.
 * The voucher the creator gifted the link is for an account that has no rail yet: the one fresh
 * from signup, whose claim it also funds (`fundRegistration`), or one whose name has not reached
 * L2. A funding claim with no voucher left cannot proceed: the burn needs the escrow to pay. A
 * voucher that could not be read decides nothing: the read's {@link VoucherReadError} comes back
 * to retry on, and only a read that succeeded can call the voucher spent.
 */
export async function claimRail(
  deps: SponsoredPaylinkDeps,
  params: ReturnType<typeof decodePaylinkInline>,
  fundRegistration: boolean,
): Promise<{ sponsor: ClaimSponsorContext; voucherRail: ClaimSponsorContext | undefined }> {
  if (fundRegistration) {
    const voucherRail = await linkVoucher(deps, params)
    if (!voucherRail)
      throw new Error("this link's voucher is spent, so it cannot pay for the account")
    return { sponsor: voucherRail, voucherRail }
  }
  try {
    return { sponsor: await claimSponsorContext(deps, RAIL_REGISTERED), voucherRail: undefined }
  } catch (err) {
    const voucherRail = await linkVoucher(deps, params)
    if (!voucherRail) throw err
    return { sponsor: voucherRail, voucherRail }
  }
}

/**
 * The golden ticket's second half: when this account's registration still waits for its deposit,
 * the claim batch also burns the ticket quote to the registration SIPA, so the link pays for the
 * tag. The quote is `goldenTicketCoverage` off the signed schedule and the portal's live cut on
 * both legs. Undefined leaves an ordinary claim as it was; a required burn that cannot be priced
 * or covered refuses the claim, as does one the SIPA cannot take yet: lapsed terms need a renewal
 * and an unpublished address its broadcast before a burn to it is swept, and the burn is the
 * irreversible half.
 */
export async function registrationSlice(
  deps: SponsoredPaylinkDeps,
  noteAmount: bigint | undefined,
  required: boolean,
  nowMs: number = Date.now(),
): Promise<RegistrationSlice | undefined> {
  if (!required) return undefined
  const record = PendingRegistrationStore.get(webStorage).current(
    deps.account.getAddress().toString(),
  )
  if (!record || record.phase !== "awaiting_deposit" || record.fundedAt !== undefined) {
    throw new RegistrationFundingError(
      "no_registration",
      "this account has no registration waiting for the link's deposit",
    )
  }
  const terms = loadRegistrationTerms(record.account, record.tag)
  const offer = registrationOffer(terms)
  if (offer.funding !== "paylink") {
    throw new RegistrationFundingError(
      "not_ticket",
      "this registration is not one a paylink's ticket bought, so its deposit is asked for, never burned",
    )
  }
  if (offer.blocked) {
    throw new RegistrationFundingError("blocked", PAYLINK_TICKET_REFUSED_MESSAGE)
  }
  if (terms !== null && terms.deadline > 0 && nowMs > terms.deadline * 1000) {
    throw new RegistrationFundingError(
      "expired",
      "the registration's reservation lapsed; renew it before the link funds it",
    )
  }
  if (!record.broadcast) {
    throw new RegistrationFundingError(
      "unpublished",
      "the registration's deposit address is not published yet, so a burn to it would not be swept",
    )
  }
  const schedule = signedSchedule(terms)
  if (!schedule) {
    throw new RegistrationFundingError(
      "no_schedule",
      "the registration carries no signed schedule to price the burn from",
    )
  }
  if (noteAmount === undefined) {
    throw new RegistrationFundingError("unpriced", "the link's amount is unknown")
  }
  const config = getConfig()
  const tuple = await getOxideTuple(config)
  const unpriced = (what: string, err: unknown) =>
    new RegistrationFundingError(
      "unpriced",
      `the portal's ${what} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    )
  let cut: bigint
  try {
    cut = await fpcFundingCut(l1PublicClient(config), requireTupleField(tuple, "portal") as Address)
  } catch (err) {
    throw unpriced("funding cut", err)
  }
  const coverage = goldenTicketCoverage(noteAmount, schedule, {
    withdrawalCut: cut,
    depositCut: cut,
  })
  if (!coverage.covers) {
    throw new RegistrationFundingError(
      "uncovered",
      `the link holds ${noteAmount} and the registration burns ${coverage.burn}`,
    )
  }
  let withdrawal: WithdrawalOptions
  try {
    withdrawal = await withdrawalOptions(tuple)
  } catch (err) {
    throw unpriced("withdrawal state", err)
  }
  return {
    l1Recipient: EthAddress.fromString(record.sipaAddress),
    amount: coverage.burn,
    relayerTip: WITHDRAW_RELAYER_TIP,
    proverTip: GOLDEN_TICKET_PROVER_TIP,
    fundingCut: cut,
    target: coverage.sipaTarget,
    withdrawal,
  }
}

/**
 * The registration burn's withdrawal record, kept the way a balance withdrawal is: seeded before
 * the batch signs, mined after it, failed or dropped when it does not go out, and armed on the
 * chain watcher. That record is what tells the activation surfaces the funding is on its way, and
 * what offers the burn's manual finalization if the relayer stalls.
 */
async function seedRegistrationBurn(
  deps: SponsoredPaylinkDeps,
  params: ReturnType<typeof decodePaylinkInline>,
  slice: RegistrationSlice,
  operationId: string,
) {
  const store = getWithdrawalStore()
  await store.load()
  const token = await deps.tokenService.fetchTokenInformation()
  const tuple = await getOxideTuple(getConfig())
  const localId = newWithdrawalLocalId()
  await store.create({
    localId,
    operationId,
    recipient: getAddress(slice.l1Recipient.toString()),
    recipientProvenance: "saved-recipient",
    source: "paylink",
    intent: "registration",
    paylinkId: paylinkIdentity(params),
    amount: formatUnits(slice.target, tokenDecimalsForNetwork(getConfig().network)),
    rawAmount: slice.amount.toString(),
    relayerTip: slice.relayerTip.toString(),
    proverTip: slice.proverTip.toString(),
    fpcFundingCut: slice.fundingCut.toString(),
    tokenSymbol: token.symbol,
    phase: "submitting",
    startTime: Date.now(),
    deployment: await currentDeployment(tuple),
  })
  // The claim's own tracker announces the batch, once this stamp and its row both saved.
  const submission = trackWithdrawalSubmission(store, localId, operationId, { announce: false })
  const arm = (record: WithdrawalRecord) =>
    ensureWithdrawalTracker(deps.wallet)
      .then((tracker) => tracker?.watch(record))
      .catch((e) =>
        console.warn("registration burn: watcher arm failed, resumed on next load", e),
      )
  return {
    /** Whether the burn's hash stamp persisted. */
    saved: () => submission.saved(),
    /**
     * After a failed send: the burn's hash when the batch was broadcast and not seen failing, so
     * the claim went out with it; null once the record is dropped (a cancel) or failed.
     */
    async recover(err: unknown): Promise<string | null> {
      try {
        const pending = await submission.recover(deps.wallet.node)
        const broadcast = pending && (pending.l2TxHash ?? submission.txHash)
        if (pending && broadcast) {
          await arm(pending)
          return broadcast
        }
        const message = err instanceof Error ? err.message : "Withdrawal failed"
        if (isFlowCancelled(err)) {
          await store.remove(localId).catch(() => {})
        } else {
          await store.patch(localId, { phase: "failed", error: message }).catch(() => {})
        }
        return null
      } finally {
        await submission.stop()
      }
    },
    /** Mined. Nothing here may fail the claim: a record left at its hash resumes on the next boot. */
    async mined(txHash: string): Promise<void> {
      await submission.stop()
      try {
        const [published, receipt] = await Promise.all([
          publishedBurn(deps.wallet.node, txHash, tuple).catch(() => undefined),
          Promise.resolve()
            .then(() => deps.wallet.node.getTxReceipt(TxHash.fromString(txHash)))
            .catch(() => undefined),
        ])
        const record =
          receipt?.blockNumber !== undefined
            ? await store.markMined(
                localId,
                txHash,
                receipt.blockNumber,
                (published?.amount ?? slice.amount).toString(),
                (published?.relayerTip ?? slice.relayerTip).toString(),
              )
            : await store.patch(localId, { phase: "submitting", l2TxHash: txHash as Hex })
        await arm(record)
      } catch (e) {
        console.warn("registration burn mined; its record could not be updated, resumes on boot", e)
      }
    },
  }
}

/** L1 claims in flight, by fragment: a second confirm while one proves joins it instead of re-burning. */
const inFlightL1Claims = new Map<string, Promise<WithdrawalRecord>>()

export function isL1ClaimInFlight(fragment: string): boolean {
  return inFlightL1Claims.has(fragment)
}

/**
 * Sponsored `claim_to_l1`: the escrow burns to `recipient` through the portal and
 * the result is tracked as a withdrawal — the record is seeded pre-sign, marked mined, and armed on
 * the chain watcher exactly like a balance withdrawal, swap route included (a non-DAI output burns
 * to the planned escrow with the deploy broadcast riding the burn). No paylink queue row is
 * written; the withdrawal record is the activity row. A create row this device made is still
 * marked claimed.
 */
export function claimLinkToL1(
  deps: SponsoredPaylinkDeps,
  fragment: string,
  recipient: Address,
  screener: AddressScreener,
  onStage: (stage: WithdrawStage) => void,
  recipientAlias?: string,
  receiveAsset: WithdrawalReceiveAsset = "DAI",
  /** Live quote at confirm time; persisted so the detail sheet can show the output estimate. */
  quote?: SwapCommit,
  zkProof?: PaylinkL1Proof,
  /** A leg planned ahead of the burn (an email proof binds to its escrow); planned here otherwise. */
  swap?: SwapLeg,
): Promise<WithdrawalRecord> {
  const live = inFlightL1Claims.get(fragment)
  if (live) return live
  const summary = `Paylink to ${recipientAlias?.trim() || "Ethereum"}`
  const run = runOperation(
    { operationId: nextOperationId("paylink-claim"), flow: "paylink-claim-l1", summary },
    (op) =>
      claimLinkToL1Flow(
        op,
        deps,
        fragment,
        recipient,
        screener,
        onStage,
        recipientAlias,
        receiveAsset,
        quote,
        zkProof,
        swap,
      ),
  ).finally(() => inFlightL1Claims.delete(fragment))
  inFlightL1Claims.set(fragment, run)
  return run
}

/** The swap leg of a link claim, sized off the escrow note's `amount` (the link carries none). */
export async function planLinkClaimSwap(
  deps: Pick<SponsoredPaylinkDeps, "wallet" | "contractService">,
  fragment: string,
  amount: bigint,
  recipient: Address,
  receiveAsset: WithdrawalReceiveAsset,
  quote?: SwapCommit,
): Promise<SwapLeg | undefined> {
  const { note, tuple } = await readPaylinkSource(deps, fragment)
  if (note.amount !== amount) throw new Error("The link balance changed; reopen the withdrawal")
  return planSwapLeg(deps.wallet, receiveAsset, recipient, amount, quote, undefined, tuple)
}

async function claimLinkToL1Flow(
  op: OperationHandle,
  liveDeps: SponsoredPaylinkDeps,
  fragment: string,
  recipient: Address,
  screener: AddressScreener,
  onStage: (stage: WithdrawStage) => void,
  recipientAlias?: string,
  receiveAsset: WithdrawalReceiveAsset = "DAI",
  quote?: SwapCommit,
  zkProof?: PaylinkL1Proof,
  planned?: SwapLeg,
): Promise<WithdrawalRecord> {
  onStage("building")
  const network = getConfig().network
  const { params, note, tuple } = await readPaylinkSource(liveDeps, fragment)
  const sourceContext = await historicTokenContext(liveDeps.wallet, liveDeps.account, tuple)
  const deps = { ...liveDeps, ...sourceContext }
  const flavor: LinkFlavor =
    params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct"
  const svc = service(deps)
  // The burn spends the escrow note and the fee comes off it. A note that cannot clear the fee
  // would revert, or leave the recipient nothing — refuse up front, and take the mined burn's
  // figures as the truth below.
  const amount = note.amount
  const cut = await fpcFundingCut(l1PublicClient(getConfig()), tuple.portal as Address)
  const fee = WITHDRAW_RELAYER_TIP + cut
  if (amount <= fee) {
    throw new Error("This link holds too little to cover the withdrawal fee")
  }
  // Same commit-point screen as a balance withdrawal: oxide's relayer enforces the policy at
  // batching time, where a blocked recipient means a burned-but-never-finalized withdrawal.
  const verdict = await screener.screen(recipient)
  if (!verdict.compliant) {
    throw new Error(verdict.reason?.message ?? "This address can't receive withdrawals")
  }
  const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED, { tuple })
  // The escrow is sized off the note; the burn refuses to sign if the note holds anything else.
  const swap =
    planned ?? (await planLinkClaimSwap(deps, fragment, amount, recipient, receiveAsset, quote))
  assertPaylinkSwapSource(swap, tuple)
  const withdrawal = await withdrawalOptions(tuple, swap)
  const token = await deps.tokenService.fetchTokenInformation()
  const decimals = tokenDecimalsForNetwork(getConfig().network)
  op.describe(`$${formatUnits(amount - fee, decimals)} to ${recipientAlias?.trim() || "Ethereum"}`)
  const { record, result } = await runBurn({
    op,
    wallet: deps.wallet,
    record: {
      recipient,
      recipientProvenance: "saved-recipient",
      recipientAlias: recipientAlias?.trim() || undefined,
      source: "paylink",
      paylinkId: paylinkIdentity(params),
      amount: formatUnits(amount - fee, decimals),
      rawAmount: amount.toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      fpcFundingCut: cut.toString(),
      tokenSymbol: token.symbol,
      phase: "submitting",
      startTime: Date.now(),
      deployment: await currentDeployment(tuple),
      ...swapRecordFields(swap, quote),
    },
    burn: (seeded) => {
      if (getConfig().network !== network) throw new Error("Network changed — reopen the link")
      onStage("proving")
      // Off the persisted record, so what the burn pays can never drift from what was written.
      return svc.claimSponsoredPaylinkToL1(
        params,
        EthAddress.fromString(withdrawalRecipients(seeded).release),
        { proverTip: 0n, withdrawal },
        sponsor,
        { operationId: op.operationId, zkProof },
      )
    },
    minedFigures: async (burn) => {
      const published = await publishedBurn(deps.wallet.node, burn.txHash, tuple)
      return (
        published && {
          amount: published.amount.toString(),
          relayerTip: published.relayerTip.toString(),
        }
      )
    },
  })
  if (!result) return record
  // Mined and irreversible: none of this may fail the record.
  onStage("submitting")
  let mined = record
  try {
    // The burn spent what the note held, which the seeded net may not match.
    if (mined.rawAmount !== amount.toString()) {
      mined = await getWithdrawalStore().patch(mined.localId, {
        phase: mined.phase,
        amount: withdrawalAmounts(mined).netDisplay,
      })
    }
    if (sponsor.subscribe) noteSubscribed(deps.account, sponsor.fpcAddress, sponsor.railId)
    maybeRefuelFpc({ ...deps, fpc: { address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact } })
    await markCreateRowClaimed(
      params.secret.toString(),
      flavor,
      deps.account.getAddress().toString(),
    )
    void upsertSavedL1WalletContact({ address: recipient, name: recipientAlias })
    emitPaylinkStage("claimed", flavor, deps, params.secret, amount, decimals)
  } catch (e) {
    console.warn("paylink claim_to_l1 mined; post-mine bookkeeping failed", e)
  }
  return mined
}

/**
 * Sponsored reclaim of an expired, unclaimed EMAIL link back to its creator. Web links deposit
 * with from_claimable = 0, so the only refund window is post-expiry (`refund_post_claim`);
 * the escrow consumes the creator's authwit and pays the note's bound sender.
 * Sponsored recovery of an unclaimed link by its creator: cancel inside the refund window, or
 * reclaim after expiry. Both flavors share the sender-authorized refund; the escrow consumes the
 * creator's authwit, pays the note's bound sender, and decides the branch from chain time.
 * Recorded as a refund since the funds come back.
 */
export function recoverSponsoredLink(
  deps: SponsoredPaylinkDeps,
  fragment: string,
  onStage?: (stage: CreateStage) => void,
): Promise<string> {
  return runOperation(
    {
      operationId: nextOperationId("paylink-refund"),
      flow: "paylink-reclaim",
      summary: linkSummary(null),
    },
    (op) => recoverSponsoredLinkFlow(op, deps, fragment, onStage),
    (txHash) => txHash,
  )
}

/**
 * The escrow refunds the token baked into its note. For a link created on a retired deployment
 * that is the historic l2Token, so the refund runs through that generation's token service, TEE
 * signer and ClaimFPC; a row without a token, on the current token, or on a delisted one keeps the
 * live deps.
 */
export async function refundDepsForRow(
  deps: SponsoredPaylinkDeps,
  row: PaylinkTransaction | null,
): Promise<{ deps: SponsoredPaylinkDeps; tuple?: OxideEnvTuple }> {
  const tokenAddress = row?.tokenAddress
  const current = deps.tokenService.tokenAddressOrNull?.toString()
  if (!tokenAddress || !current || tokenAddress.toLowerCase() === current.toLowerCase()) {
    return { deps }
  }
  const historic = await findHistoricTuple(tokenAddress)
  if (!historic) {
    throw new Error(`The refund token ${tokenAddress} has no available deployment`)
  }
  const context = await historicTokenContext(deps.wallet, deps.account, historic)
  return { deps: { ...deps, ...context }, tuple: historic }
}

async function recoverSponsoredLinkFlow(
  op: OperationHandle,
  liveDeps: SponsoredPaylinkDeps,
  fragment: string,
  onStage?: (stage: CreateStage) => void,
): Promise<string> {
  onStage?.("building")
  const params = decodePaylinkInline(fragment)
  const flavor: LinkFlavor =
    params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct"
  // The offer was made from a polled tip that may be seconds old; the refund tx expires at
  // `refundable_until` unless the link is already past expiry. Re-read once before anything is
  // proven or recorded.
  const [row, now] = await Promise.all([
    creatorRowFor(fragment),
    latestChainSeconds(liveDeps.wallet.node),
  ])
  const { deps, tuple } = await refundDepsForRow(liveDeps, row)
  const svc = service(deps)
  const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED, { tuple })
  const expired = row?.untilClaimable != null && now > row.untilClaimable
  if (!expired && row?.refundableUntil != null && !canCancelAt(row.refundableUntil, now)) {
    throw new PaylinkWindowClosedError()
  }
  const decimals = tokenDecimalsForNetwork(getConfig().network)
  // The link carries no amount; the create row does.
  const rowAmount = row?.token?.amount
  op.describe(linkSummary(rowAmount))
  const { queueId, operationId } = await startPaylinkRow(
    deps,
    svc,
    "paylink-refund",
    PaylinkActionEnum.CLAIM_BACK,
    rowAmount,
    { flavor, operationId: op.operationId },
  )
  onStage?.("proving")
  const secret = params.secret.toString()
  const account = deps.account.getAddress().toString()
  // The creator row learns of the refund at submit too: after a reload the claim reconciler would
  // otherwise read the spent note as a recipient's claim.
  const submission = trackSubmission(operationId, async (txHash) => {
    await saveRowTxHash(queueId)(txHash)
    await markCreateRowRefundSubmitted(secret, flavor, account, txHash)
  })
  let txHash: string
  try {
    txHash = await svc.refundSponsoredPaylink(params, sponsor, {
      operationId,
    })
    if (sponsor.subscribe) noteSubscribed(deps.account, sponsor.fpcAddress, sponsor.railId)
    maybeRefuelFpc({ ...deps, fpc: { address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact } })
    onStage?.("submitting")
    await finishPaylinkRow(queueId, txHash)
    await markCreateRowRefunded(secret, flavor, account, txHash)
  } catch (e) {
    throw await paylinkFailure(queueId, e, submission, deps.wallet.node)
  } finally {
    await submission.stop()
  }
  emitPaylinkStage(
    "refunded",
    flavor,
    deps,
    params.secret,
    rowAmount == null ? undefined : parseUnits(String(rowAmount), decimals),
    decimals,
  )
  return txHash
}

function linkShape(
  fragment: string,
  amount: bigint | undefined,
  decimals: number,
  flavor: LinkFlavor,
  email?: string,
  txHash?: string,
): PaymentLink {
  return {
    url: `${location.origin}/link#${fragment}`,
    fragment,
    amount: amount === undefined ? undefined : formatUnits(amount, decimals),
    status: "unclaimed",
    flavor,
    email,
    txHash,
  }
}

/**
 * Decode a link fragment into its display shape — no wallet needed. The fragment names the flavor
 * and nothing else to show: amount, email, memo and funding tx wait for `viewLink` to read the
 * escrow. Status starts unclaimed until `viewLink` reads the nullifier.
 *
 * Every inbound link decodes here (`/link`, Home's stash, `viewLink`), so an email link is refused
 * while email-locked links are off, before any signup, Google sign-in or transaction.
 */
export function decodeLink(fragment: string): PaymentLink {
  const params = decodePaylinkInline(fragment)
  const flavor: LinkFlavor =
    params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct"
  if (flavor === "email" && !emailLockedLinksEnabled) throw new EmailPaylinkUnsupportedError()
  return linkShape(fragment, undefined, tokenDecimalsForNetwork(getConfig().network), flavor)
}

/**
 * Funnel top for the claim side, fired once per shown link — the /link page, or Home's claim
 * prompt for a handed-off signed-in visitor. The fragment gives the join key and the flavor, so
 * this needs no PXE and no account — only the active network's rollup address. The amount lives
 * on chain, so this stage carries no bucket. Consent-gated inside firePaylinkEvent; never throws.
 */
export function emitLinkOpened(rollupAddress: string, fragment: string): void {
  try {
    const params = decodePaylinkInline(fragment)
    const flavor: LinkFlavor =
      params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct"
    void paylinkPh({ rollupAddress, secret: params.secret })
      .then((ph) =>
        firePaylinkEvent({
          stage: "link_opened",
          flavor,
          amount_bucket: "unknown",
          paylink_ph: ph,
        }),
      )
      .catch(() => {})
  } catch {
    // Malformed fragment: the screen shows its own error card; nothing to report.
  }
}

/**
 * `PaylinkService` requires an Account/TokenService in its constructor, but
 * `isPaylinkClaimed` only uses wallet.node + contractService. Placeholder keeps
 * the status path runnable before passkey unlock.
 */
function statusService(deps: ViewLinkDeps): PaylinkService {
  const sender =
    deps.account ?? ({ getAddress: () => AztecAddress.ZERO } as unknown as ObsidionAccount)
  const tokenService = deps.tokenService ?? ({} as TokenService)
  return new PaylinkService(deps.wallet, sender, tokenService, deps.contractService)
}

/**
 * Decode a link + read its on-chain status via the paylink nullifier tree
 * (`PaylinkService.isPaylinkClaimed`). Needs only wallet + contractService — no
 * passkey. `resolveLink` also unpacks `from_claimable` so `/link` can withhold Claim
 * during grace; the placeholder sender is enough to reconstruct the escrow.
 */
export async function viewLink(deps: ViewLinkDeps, fragment: string): Promise<PaymentLink> {
  const params = decodePaylinkInline(fragment)
  const link = decodeLink(fragment)
  const svc = statusService(deps)
  const claimed = await svc.isPaylinkClaimed(params)
  if (claimed) return { ...link, status: "claimed" }
  try {
    // The note read is a PXE simulation that can wait on block sync (the PXE trails the tip; a
    // just-created escrow's note is unreadable until the chain moves on). Bound it so a stalled
    // read cannot pin the screen's status check; without it the link shows as claimable now and
    // the contract still gates the claim.
    const resolved = await withTimeout(svc.resolveLink(params, deps.account), NOTE_READ_TIMEOUT_MS)
    const decimals = tokenDecimalsForNetwork(getConfig().network)
    return {
      ...link,
      status: "unclaimed",
      amount: formatUnits(resolved.note.amount, decimals),
      tokenAddress: resolved.note.tokenAddress.toString(),
      claimableFrom: resolved.note.claimableFrom,
      memo: resolved.memo,
      email: resolved.email,
      commitment: resolved.commitment.toString(),
      txHash: resolved.txHash,
    }
  } catch {
    // Note sync failed but nullifier says unclaimed — no amount to show; the watcher retries.
  }
  return { ...link, status: "unclaimed" }
}
