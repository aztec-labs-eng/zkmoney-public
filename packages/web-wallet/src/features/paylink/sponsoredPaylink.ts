import { WalletError } from "@obsidion/core/errors"
import type { PageFacts } from "../../session/pageChain"
import { assertPaylinkSwapSource, readPaylinkSource } from "./paylinkSource"
import { paylinkRowUrl, paylinkShareUrl } from "../shortLinks"
/**
 * Web glue for direct and email-locked ClaimFPC-sponsored paylinks.
 * The sponsored create/claim/view orchestration lives in the
 * shared `PaylinkService`; this module only supplies
 * the web-specific inputs: the ClaimFPC sponsor context (via
 * `claimSponsorContext`), the parked
 * funding-deposit redemption, and the amount/link formatting. Screens build
 * `PaylinkService` from the shared front-core contexts and call these helpers.
 */
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { TxHash } from "@aztec-labs/stdlib/tx"
import { formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem"
import type { Network, PaylinkL1Proof } from "@obsidion/sdk"
import {
  bestEffort,
  broadcastAttemptEnded,
  broadcastJob,
  refundRuns,
  withdrawalFailure,
  linkIdFor,
  linkIdOf,
  loadRecords,
  paylinkIdentity,
  type PaylinkRecord,
  type Write,
} from "@obsidion/front-core"
import { withdrawalExecutorFee } from "../withdraw/withdrawalFee"
import {
  trackSubmission,
  trackWithdrawalSubmission,
  TxInFlightError,
  type PaylinkRecovery,
  type SubmissionTracker,
} from "@obsidion/front-core"
import {
  PaylinkService,
  type ContractService,
  encodePaylinkInline,
  decodePaylinkInline,
  nextOperationId,
  PAYLINK_TERMS_REFUSAL,
  paylinkVoucherUses,
  readClaimFpcAllowance,
  UnknownRailError,
  ClaimBatchFullError,
  type ClaimSponsorContext,
  type ObsidionAccount,
  type PaylinkNoteView,
  type PaylinkParams,
  type ObsidionWallet,
  type RegisteredTeeSigner,
  type TokenService,
  type TxHashCallback,
  type WithdrawalOptions,
} from "@obsidion/sdk"
import {
  DEFAULT_CONTRACTS,
  PAYLINK_GRACE_PERIOD_SECONDS,
  PAYLINK_MIN_CLAIM_WINDOW_SECONDS,
  SECONDS_IN_A_DAY,
  tokenDecimalsForNetwork,
  ZKJWT_VKEY_HASH,
  WITHDRAW_RELAYER_TIP,
} from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  parseEscrowAmount,
  PaylinkWindowClosedError,
  type TokenInTxService,
  newWithdrawalLocalId,
  upsertSavedL1WalletContact,
  type AddressScreener,
  type WithdrawalRecord,
  readPaylinkNote,
  paylinkWindows,
  withdrawalAmounts,
  withdrawalRecipients,
  currentRegistration,
  goldenTicketCoverage,
  allowanceCovers,
  deriveAllowanceState,
  type OperationKind,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import {
  committedProverTip,
  PAYLINK_TICKET_REFUSED_MESSAGE,
  quoteExpired,
  registrationOffer,
  signedSchedule,
} from "../registration/registrationTerms"
import { recordBurnDuration } from "../withdraw/burnTiming"
import { isFlowCancelled, runOperation, type OperationHandle } from "../operations/operations"
import { chainOf } from "../../session/session"
import type { Chain, ChainSession, Session, SessionDeps } from "../../session/session"
import { writeDeviceKeys, type DeviceState } from "../../platform/storage/deviceKeys"
import { deadline, TimeoutError, withTimeout } from "../../lib/withTimeout"
import {
  firePaylinkEvent,
  paylinkAmountBucket,
  paylinkPh,
  type PaylinkEvent,
} from "../../lib/analytics"
import { holdSigningFlow } from "../../lib/passkeyTelemetry"
import type { WebWalletConfig } from "../../config/env"
import { emailLockedLinksEnabled } from "../../config/features"
import { findHistoricTuple, historicTokenContext } from "../migration/historicTokenContext"
import { assertWithinWithdrawalLimit } from "../limits/withdrawalLimit"
import {
  claimSponsorContext,
  claimSponsorRail,
  noteSubscribed,
} from "../registration/claimSponsorship"
import { latestChainSeconds } from "./chainTime"
import { resolveTagViaRegistry } from "../contacts/registryResolution"
import { owePaylinkClaim, reportPaylinkClaims } from "./paylinkClaimReport"
import { runLinkBurn } from "./linkBurn"
import { RAIL_REGISTERED, RAIL_VOUCHER } from "../registration/rails"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { canCancelAt, linkMadeBy } from "@obsidion/front-core"
import type { WithdrawalReceiveAsset } from "../withdraw/withdrawAssets"
import {
  currentDeployment,
  planSwapLeg,
  sessionSwapRecoverer,
  runBurn,
  swapRecordFields,
  withdrawalOptions,
  type SwapCommit,
  type SwapLeg,
  type WithdrawStage,
} from "../withdraw/withdrawGateway"
import { planBridgeLeg, type BridgeOutChoice } from "../withdraw/bridgeOut"
import type { CreateStage, LinkFlavor, PaymentLink } from "./types"
import { sponsorshipErrorCopy } from "../allowance/sponsorshipError"
import {
  registrationBroadcastPayload,
  type RegistrationBroadcastStores,
} from "../broadcasts/registrationExecutor"
import {
  cacheFreshClaim,
  createWebRegistrationBroadcaster,
  registrationBroadcastCalls,
} from "../registration/webRegistrationBroadcast"
import { loadedRegistrations } from "../registration/webRegistration"

/** How long a fresh link stays claimable when the creator picks no expiry. */
export const DEFAULT_CLAIM_WINDOW_DAYS = 30
/** E2e-only: opens a `from_claimable` grace window (seconds after chain now). Unset = {@link PAYLINK_GRACE_PERIOD_SECONDS}. */
const GRACE_PERIOD_OVERRIDE = import.meta.env.VITE_E2E_PAYLINK_GRACE_SECONDS as string | undefined
/** Cap on `viewLink`'s escrow-note read; see the call site. */
const NOTE_READ_TIMEOUT_MS = 20_000
const SENDER_TAG_CHECK_TIMEOUT_MS = 5_000
/** Cap on the voucher and allowance reads a sheet waits on; a stalled read must not pin it. */
const VOUCHER_CHECK_TIMEOUT_MS = 8_000
/** Cap on a registration claim's voucher read: nothing waits on it but the claim, queued behind Home's reads. */
const REGISTRATION_VOUCHER_CHECK_TIMEOUT_MS = 30_000
/** How long a ticket claim waits for the chain to decide a broadcast of its address already sent. */
const PUBLISH_SETTLE_MS = 60_000
/**
 * Cap on a claim's preparation, its reads before it sends anything: room for the capped waits it
 * can pass through back to back. Its proof is never capped.
 */
const CLAIM_PREPARE_TIMEOUT_MS =
  NOTE_READ_TIMEOUT_MS + REGISTRATION_VOUCHER_CHECK_TIMEOUT_MS + PUBLISH_SETTLE_MS
const CLAIM_PREPARE_TIMEOUT_MESSAGE =
  "The claim took too long to prepare. Nothing was sent, so you can try again."

/**
 * Whether a ticket claim's own batch carries the registration broadcast its burn pays into. The
 * merged transaction publishes nothing the two separate ones do not: the burn already pays the
 * registration address, whose public record names the account (docs/paylink/golden-ticket.md
 * §4.1). Off, or with no room in the batch, the address is published in a transaction of its own
 * first.
 */
const CLAIM_BATCHES_REGISTRATION_BROADCAST = true

export interface SponsoredPaylinkDeps {
  /** Active network's rollup address (hydrated by AztecContext at boot) — a `paylinkPh` input. */
  rollupAddress: string
  /** The session the flow runs in: a task's core, or the screen's session. */
  session: PaylinkSession
  /** Who pays in place of the session: a backup's one-key account, or signup's new account. */
  account?: ObsidionAccount
  tokenService?: TokenService
  teeSigner?: RegisteredTeeSigner
}

/** The deps with the session's wallet, contracts and payer, each ready. */
export type ReadyPaylinkDeps = Required<SponsoredPaylinkDeps> & Chain

export async function readyPaylinkDeps(deps: SponsoredPaylinkDeps): Promise<ReadyPaylinkDeps> {
  const { session } = deps
  const account = deps.account ?? (session.account && (await session.account.ready()))
  const tokenService = deps.tokenService ?? (session.token && (await session.token.ready()))
  if (!account || !tokenService) throw new WalletError("wallet.notReady", "no account session")
  const teeSigner = deps.teeSigner ?? (await session.teeSigner.ready())
  return { ...deps, ...(await chainOf(session)), account, tokenService, teeSigner }
}

/** Wallet + contract service are enough for the nullifier status read (no passkey). */
export interface ViewLinkDeps {
  session: Pick<Session, "page">
  wallet: ObsidionWallet
  contractService: ContractService
  /** When present, `sync_note` simulates from this account instead of the placeholder. */
  account?: ObsidionAccount
}

interface PendingDeposit {
  leafIndex: string
  amount: string
  recipient: string
  messageSecret: string
}

function service(deps: ReadyPaylinkDeps): PaylinkService {
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
function readPendingDeposits(device: DeviceState): PendingDeposit[] {
  try {
    const parsed = JSON.parse(device.pendingDeposits ?? "[]")
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
export function hasPendingDeposits(device: DeviceState): boolean {
  return readPendingDeposits(device).length > 0
}

/**
 * Redeem funding deposits parked in wallet storage by the e2e funding helper
 * (STORE PARAMS): `store_deposit` is a free utility sim in this PXE;
 * the create tx then claims the deposit lazily.
 */
async function redeemPendingDeposits(
  session: Pick<Session, "database" | "device">,
  deps: ReadyPaylinkDeps,
): Promise<void> {
  const pending = readPendingDeposits(session.device.get())
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
  await writeDeviceKeys(session.database, { pendingDeposits: JSON.stringify(remaining) })
}

/** The wallet token as a link's record, and its claim's or refund's row, show it. */
async function linkToken(
  deps: ReadyPaylinkDeps,
  amount: { atomic: bigint; human: number } | undefined,
): Promise<TokenInTxService> {
  const token = await deps.tokenService.fetchTokenInformation()
  return {
    symbol: token.symbol,
    name: token.name,
    address: token.address,
    logo: "",
    amount: amount?.human ?? 0,
    decimals: token.decimals,
    // Single USD-pegged asset; the activity feed multiplies amount × price.
    price: 1,
    hasUnknownAmount: amount === undefined,
  }
}

type Payout = Extract<OperationKind, { kind: "paylink-claim" | "paylink-refund" }>

/** What a claim's or refund's row shows. */
async function payout(
  deps: ReadyPaylinkDeps,
  kind: Payout["kind"],
  params: PaylinkParams,
  amount: { atomic: bigint; human: number } | undefined,
): Promise<Payout> {
  return {
    kind,
    payload: {
      networkId: deps.wallet.networkId.toLowerCase(),
      token: await linkToken(deps, amount),
      amountAtomic: String(amount?.atomic ?? 0n),
      flavor: params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct",
      linkId: linkIdFor(params),
    },
  }
}

/** A claim's or refund's operation takes what its row shows, before the proof. */
async function startPayout(
  op: OperationHandle,
  deps: ReadyPaylinkDeps,
  kind: Payout["kind"],
  params: PaylinkParams,
  amount: { atomic: bigint; human: number } | undefined,
): Promise<void> {
  await op.transfer(await payout(deps, kind, params, amount))
}

/**
 * The note a claim reads before its proof. A note the link was not made for is the link's claim's
 * final failure, so the claim's payload goes on before the refusal throws.
 */
export async function claimNote(
  op: OperationHandle,
  deps: ReadyPaylinkDeps,
  params: PaylinkParams,
  read: Promise<PaylinkNoteView | undefined>,
): Promise<PaylinkNoteView | undefined> {
  try {
    return await read
  } catch (e) {
    if (e instanceof WalletError && e.code === "paylink.termsMismatch")
      await startPayout(op, deps, "paylink-claim", params, undefined)
    throw e
  }
}

/** The operation's one-line name, e.g. "$25 paylink". */
function linkSummary(amount: string | number | null | undefined): string {
  return amount == null ? "Paylink" : `$${amount} paylink`
}

/** The stores a link's writes commit to together. */
export type LinkStores = Pick<Session, "paylinks" | "operations" | "db">

/** What a paylink flow reads and writes in the session it runs in: a task's core, or a session. */
export type PaylinkSession = Pick<
  Session,
  | "paylinks"
  | "operations"
  | "page"
  | "db"
  | "withdrawals"
  | "owedClaims"
  | "burnDurations"
  | "contacts"
  | "wake"
  | "withdrawalTracker"
> &
  Pick<Session, "wallet" | "contractService" | "account" | "token" | "teeSigner"> &
  RegistrationBroadcastStores &
  Pick<SessionDeps, "auth" | "database" | "device"> & {
    holdBroadcast(address: string): () => void
  }

type PaylinkRowFields = Pick<
  PaylinkRecord,
  "fallbackSecret" | "fromClaimable" | "untilClaimable" | "refundableUntil" | "paylink"
> & { payToEmailSecret: string }

/** What a create knows of its link before the link's secrets exist. */
export type LinkDraft = Omit<PaylinkRecord, "id" | keyof PaylinkRowFields>

/** The link this operation creates, once prepared. */
async function linkOfOperation(
  { paylinks }: LinkStores,
  operationId: string,
): Promise<PaylinkRecord | undefined> {
  const [link] = await loadRecords(paylinks.where("operation", operationId.toLowerCase()))
  return link
}

/** Runs `fn` in one write, once the operations and link stores are open. */
async function writing<T>(
  { operations, paylinks, db }: LinkStores,
  fn: (w: Write) => Promise<T>,
): Promise<T> {
  await Promise.all([operations.ready, paylinks.ready])
  return db.write(fn)
}

/**
 * Files a prepared link before signing, so a funded link keeps its refund details. An earlier
 * create that never sent can leave a link at the same slot: this one takes its place.
 */
export async function savePreparedLink(
  stores: LinkStores,
  draft: LinkDraft,
  fields: PaylinkRowFields,
): Promise<void> {
  const { paylinks } = stores
  const id = linkIdOf({ ...draft, ...fields })
  await writing(stores, async (w) => {
    if (await paylinks.get(id, w)) await paylinks.remove(id, w)
    await paylinks.put({ ...draft, ...fields, id }, w)
  })
}

/**
 * The create's `onTxHash`: its operation and its link take the hash in one write, before the node
 * takes the tx, so a reload finds both.
 */
export function saveLinkTxHash(stores: LinkStores, operationId: string) {
  return async (txHash: string): Promise<void> => {
    const { operations, paylinks } = stores
    const link = await linkOfOperation(stores, operationId)
    await writing(stores, async (w) => {
      const held = link && ((await paylinks.apply(link.id, { type: "sent", txHash }, w)) ?? link)
      const sent = await operations.apply(operationId, { type: "sent", txHash }, w)
      if (!sent || held?.txHash !== txHash)
        throw new WalletError("invariant", "paylink create: no record for its hash")
    })
  }
}

/**
 * Puts the create's tx-bearing `paylink` on its link once the tx is out; a failed save is logged,
 * never the flow's failure.
 */
export async function fundLink(
  stores: LinkStores,
  operationId: string,
  paylink: string,
): Promise<void> {
  const fund = async () => {
    const link = await linkOfOperation(stores, operationId)
    if (link) await stores.paylinks.apply(link.id, { type: "funded", paylink })
  }
  await bestEffort("unknown", fund())
}

/** A closed passkey prompt before submit sent nothing: the prepared link goes. */
async function dropCancelledLink(
  stores: LinkStores,
  operationId: string,
  error: unknown,
): Promise<void> {
  if (!isPasskeyCancelled(error)) return
  const drop = async () => {
    const link = await linkOfOperation(stores, operationId)
    if (link && !link.txHash) await writing(stores, (w) => stores.paylinks.remove(link.id, w))
  }
  await bestEffort("unknown", drop())
}

/**
 * The error a rejected sponsored call surfaces. Past the submit boundary the transaction may still
 * land, so the operation stays sent for the chain to settle and the caller gets a
 * `TxInFlightError` to report as such; otherwise the transport error stands.
 */
export async function paylinkFailure(
  stores: LinkStores,
  operationId: string,
  error: unknown,
  submission: Pick<SubmissionTracker, "survived">,
  node: Parameters<SubmissionTracker["survived"]>[0],
): Promise<unknown> {
  const inFlight = await submission.survived(node)
  if (inFlight) return new TxInFlightError(inFlight, error)
  await dropCancelledLink(stores, operationId, error)
  return error
}

/**
 * The link `account` made that `params` names. The flavor and the rollup are part of its identity,
 * so same-day direct and email links, and two rollups' links, never share one.
 */
async function createdLink(
  { paylinks }: LinkStores,
  params: PaylinkParams,
  account?: string,
  w?: Write,
): Promise<PaylinkRecord | undefined> {
  const link = await paylinks.get(linkIdFor(params), w)
  return link && (account === undefined || link.obsidionAccountAddress === account)
    ? link
    : undefined
}

/** When this account created the link, marks it claimed by this account. */
export async function markLinkClaimed(
  stores: LinkStores,
  params: PaylinkParams,
  account: string,
): Promise<void> {
  const link = await createdLink(stores, params, account)
  if (!link) return
  await stores.paylinks.apply(link.id, {
    type: "claimed",
    at: Date.now(),
    epoch: link.reorgEpoch,
    refundInFlight: refundRuns(stores.operations, link.id),
    by: "self",
  })
}

/** Marks the creator's link refunded, with the refund's hash: the link carries the round trip. */
export async function markLinkRefunded(
  stores: LinkStores,
  params: PaylinkParams,
  account: string,
  refundTxHash?: string,
  refundKind?: PaylinkRecovery,
): Promise<void> {
  const link = await createdLink(stores, params, account)
  if (!link) return
  await stores.paylinks.apply(link.id, { type: "refunded", refundTxHash, refundKind })
}

/**
 * Saves a submitted refund's hash on its operation and on the creator's link in one write; the
 * sweep settles the link from that pair. A refund by fragment alone has no link here.
 */
export async function saveRefundSubmitted(
  stores: LinkStores,
  operationId: string,
  params: PaylinkParams,
  account: string,
  refundTxHash: string,
  refundKind: PaylinkRecovery,
): Promise<void> {
  const { operations, paylinks } = stores
  await writing(stores, async (w) => {
    if (!(await operations.apply(operationId, { type: "sent", txHash: refundTxHash }, w)))
      throw new WalletError("invariant", "paylink refund: no record for its hash")
    const link = await createdLink(stores, params, account, w)
    if (link)
      await paylinks.apply(link.id, { type: "refundSubmitted", refundTxHash, refundKind }, w)
  })
}

/** This device's link for a fragment: presence marks the viewer as the creator. */
export async function creatorLinkFor(
  stores: LinkStores,
  fragment: string,
): Promise<PaylinkRecord | null> {
  let params
  try {
    params = decodePaylinkInline(fragment)
  } catch {
    return null
  }
  return (await createdLink(stores, params)) ?? null
}

/**
 * Funnel event for a settled lifecycle stage. Never awaited and never throws: the payment has
 * already succeeded by the time this runs, so nothing here may fail it.
 */
function emitPaylinkStage(
  stage: PaylinkEvent["stage"],
  flavor: LinkFlavor,
  deps: ReadyPaylinkDeps,
  secret: { toBuffer(): Uint8Array },
  amount: bigint | undefined,
  decimals: number,
): void {
  void paylinkPh({ rollupAddress: deps.rollupAddress, secret })
    .then((ph) =>
      firePaylinkEvent({
        stage,
        flavor,
        amount_bucket: paylinkAmountBucket(amount, decimals),
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
  /** The creator's tag, which the link holder sees as who sent it. */
  senderTag?: string
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
export class VoucherReadError extends WalletError {
  constructor(cause: unknown) {
    super(
      "paylink.voucherUnread",
      "We couldn't check whether this link still pays for its claim. Please try again.",
      { cause },
    )
    this.name = "VoucherReadError"
  }
}

/** The voucher rail's sponsor context, or undefined where this deployment declares no such rail. */
async function voucherSponsor(deps: ReadyPaylinkDeps): Promise<ClaimSponsorContext | undefined> {
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
  deps: ReadyPaylinkDeps,
  params: ReturnType<typeof decodePaylinkInline>,
  timeoutMs = VOUCHER_CHECK_TIMEOUT_MS,
): Promise<ClaimSponsorContext | undefined> {
  const sponsor = await voucherSponsor(deps)
  if (!sponsor) return undefined
  let uses: number
  try {
    const read = paylinkVoucherUses(
      { wallet: deps.wallet, contractService: deps.contractService, sponsor },
      params,
    )
    uses = await withTimeout(read, timeoutMs)
  } catch (err) {
    throw new VoucherReadError(err)
  }
  return uses > 0 ? sponsor : undefined
}

/**
 * Whether a link created now can carry a voucher: the deployment offers the voucher rail and the
 * creator's allowance covers both the create and the gift it pops. A creator not yet subscribed on
 * the open rail subscribes in the create batch and holds the whole allowance. A stored zero counts as
 * none, since the read cannot say whether the create renews it. Never throws — a link without a
 * voucher is still a link.
 */
export async function voucherAvailable(input: SponsoredPaylinkDeps): Promise<boolean> {
  try {
    return await withTimeout(
      (async () => {
        const deps = await readyPaylinkDeps(input)
        // The deployment has to offer the rail at all — an older one has no voucher slot.
        await claimSponsorRail(deps, RAIL_VOUCHER)
        const { sponsor } = await claimSponsorRail(deps, RAIL_REGISTERED)
        const allowance = await readClaimFpcAllowance(
          deps.wallet,
          sponsor.fpcAddress,
          sponsor.fpcArtifact,
          deps.account.getAddress(),
          sponsor.railId,
        )
        return allowanceCovers(deriveAllowanceState(allowance), 2)
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
  const decimals = tokenDecimalsForNetwork(deps.session.page.config.network)
  const summary = linkSummary(parseEscrowAmount(amountDisplay, decimals).human)
  return runOperation(
    deps.session,
    { operationId: nextOperationId("paylink-create"), flow: "paylink-create", summary },
    (op) => createSponsoredLinkFlow(op, deps, amountDisplay, onStage, opts),
    (created) => created.txHash,
  )
}

async function createSponsoredLinkFlow(
  op: OperationHandle,
  input: SponsoredPaylinkDeps,
  amountDisplay: string,
  onStage?: (stage: CreateStage) => void,
  opts: CreateLinkOptions = {},
): Promise<CreatedLink> {
  const deps = await readyPaylinkDeps(input)
  const { email, expiryDays = DEFAULT_CLAIM_WINDOW_DAYS, memo, senderTag, voucher = false } = opts
  onStage?.("building")
  const svc = service(deps)
  const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)
  // A link matters more than the gift riding it: a voucher rail that has rolled away or cannot be
  // read since the review sheet asked costs the recipient a cash-out, not the creator their link.
  const voucherRail = voucher ? await voucherSponsor(deps).catch(() => undefined) : undefined
  await redeemPendingDeposits(deps.session, deps)

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

  const { network } = input.session.page.config
  const decimals = tokenDecimalsForNetwork(network)
  const { atomic: amount, human } = parseEscrowAmount(amountDisplay, decimals)
  // A locked session would derive random secrets, and the signing ceremony that unlocks it runs
  // too late to help. Fail before any funds move.
  const stores = deps.session
  const masterSecret = await stores.auth.getSecretKey()
  if (!masterSecret) throw new WalletError("account.locked", "no master secret to create a paylink")

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
  // Another device names a rebuilt link's refund by this floor, since a spent link's expiry is gone.
  if (windowSeconds < PAYLINK_MIN_CLAIM_WINDOW_SECONDS) {
    throw new WalletError("config.invalid", `claim window ${windowSeconds}s is under a day`)
  }
  const windows = paylinkWindows(chainNow, windowSeconds, graceSeconds)

  const { operationId } = op
  const token = await linkToken(deps, { atomic: amount, human })
  const draft: LinkDraft = {
    timestamp: Date.now(),
    operationId,
    networkId: deps.wallet.networkId.toLowerCase(),
    kind: "paylink-create",
    amountAtomic: amount,
    token,
    tokenAddress: token.address,
    flavor,
    obsidionAccountAddress: deps.account.getAddress().toString(),
    ...(email !== undefined ? { to: email } : {}),
    ...(memo !== undefined ? { memo } : {}),
  }
  // The link record keeps the full link: refunds, migration and status reads decode it. Shares
  // convert it.
  const rowFields = (p: { secret: Fr; fallbackSecret: Fr }, link: PaymentLink) => ({
    payToEmailSecret: p.secret.toString(),
    fallbackSecret: p.fallbackSecret.toString(),
    fromClaimable: Number(windows.fromClaimable),
    untilClaimable: Number(windows.untilClaimable),
    refundableUntil: Number(windows.refundableUntil),
    paylink: paylinkRowUrl(link.fragment),
  })
  let params: Awaited<ReturnType<PaylinkService["createSponsoredPaylink"]>>
  let link: PaymentLink | undefined
  const submission = trackSubmission(deps.session.page.prover.progress, operationId)
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
        senderTag,
        // Binds the paylink's secrets to the creator, so a refund needs only the link and the
        // passkey.
        masterSecret,
        ...(voucherRail ? { voucher: { railId: voucherRail.railId } } : {}),
      },
      sponsor,
      {
        // Correlates the TEE and prove benchmark legs → one tx_timing analytics event.
        operationId,
        onTxHash: saveLinkTxHash(stores, operationId),
        // The fragment needs nothing from the funding tx, so the link exists before the passkey
        // prompt: its record carries it from here, and the caller can show it while the
        // proof runs.
        onPrepared: async (prepared) => {
          link = {
            ...linkShape(network, encodePaylinkInline(prepared), amount, flavor, email),
            memo,
          }
          await savePreparedLink(stores, draft, rowFields(prepared, link))
          opts.onLink?.(link)
        },
      },
    )
    if (sponsor.subscribe) noteSubscribed(deps, sponsor.fpcAddress, sponsor.railId)
    deps.session.oweFpcRefuel({ address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact })
    onStage?.("submitting")
    if (!link) throw new Error("sponsored paylink create never prepared its link")
    // The link now carries the tx-bearing URL: later copies let a claimer read the memo.
    link = { ...linkShape(network, encodePaylinkInline(params), amount, flavor, email), memo }
    await fundLink(stores, operationId, paylinkRowUrl(link.fragment))
  } catch (e) {
    throw await paylinkFailure(stores, operationId, e, submission, deps.wallet.node)
  } finally {
    submission.stop()
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
      deps.session,
      {
        operationId: nextOperationId("paylink-claim"),
        flow: "paylink-claim",
        summary: linkSummary(null),
      },
      (op) => {
        // From inside the gate: a background proof the claim waits out is not its preparation.
        const prepare = deadline(
          CLAIM_PREPARE_TIMEOUT_MS,
          () =>
            new Error(CLAIM_PREPARE_TIMEOUT_MESSAGE, {
              cause: new TimeoutError(CLAIM_PREPARE_TIMEOUT_MS),
            }),
        )
        return claimSponsoredLinkFlow(op, deps, fragment, prepare, onStage, zkProof, opts).finally(
          prepare.clear,
        )
      },
      (txHash) => txHash,
      { dropRetryable: opts?.dropRetryable },
    )
  } finally {
    release?.()
  }
}

export interface ClaimSponsoredLinkOptions {
  /** The claim pays for this account's pending registration: the SIPA burn is required, not optional. */
  fundRegistration?: boolean
  /** Home's automatic claim: a retryable failure before its proof leaves no record. */
  dropRetryable?: boolean
  /** {@link CLAIM_BATCHES_REGISTRATION_BROADCAST} for this claim. */
  batchRegistrationBroadcast?: boolean
}

/** Resolves to the claim tx hash. */
async function claimSponsoredLinkFlow(
  op: OperationHandle,
  input: SponsoredPaylinkDeps,
  fragment: string,
  prepare: ReturnType<typeof deadline>,
  onStage?: (stage: CreateStage) => void,
  zkProof?: { vkey: string[]; proof: string[]; public_inputs: string[] },
  opts?: ClaimSponsoredLinkOptions,
): Promise<string> {
  onStage?.("building")
  const deps = await readyPaylinkDeps(input)
  const stores = deps.session
  const svc = service(deps)
  const params = decodePaylinkInline(fragment)
  const isEmail = params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail
  if (isEmail && !zkProof) {
    throw new Error("This link is locked to an email — sign in first to prove ownership")
  }
  // The operation's row is up already; the note read fills it in. The payload names the link, so
  // every failure after it, the voucher's refusal included, is the link's claim's.
  const note = await claimNote(op, deps, params, prepare.within(readPaylinkNote(svc, params)))
  const flavor: LinkFlavor = isEmail ? "email" : "direct"
  const decimals = tokenDecimalsForNetwork(input.session.page.config.network)
  op.describe(linkSummary(note && formatUnits(note.amount, decimals)))
  const { operationId } = op
  await startPayout(
    op,
    deps,
    "paylink-claim",
    params,
    note && { atomic: note.amount, human: Number(formatUnits(note.amount, decimals)) },
  )
  const [{ sponsor, voucherRail }] = await prepare.within(
    Promise.all([
      claimRail(deps, params, Boolean(opts?.fundRegistration)),
      isEmail
        ? deps.contractService.registerContractWithName(DEFAULT_CONTRACTS.oidcKeyRegistry)
        : undefined,
    ]),
  )
  onStage?.("proving")
  let txHash: string
  let burn: Awaited<ReturnType<typeof seedRegistrationBurn>> | undefined
  let publish: Awaited<ReturnType<typeof registrationPublish>> | undefined
  const submission = trackSubmission(deps.session.page.prover.progress, operationId)
  try {
    const slice = await prepare.within(
      registrationSlice(deps, note?.amount, Boolean(opts?.fundRegistration)),
    )
    const batched = opts?.batchRegistrationBroadcast ?? CLAIM_BATCHES_REGISTRATION_BROADCAST
    publish = slice?.unpublished
      ? await prepare.within(registrationPublish(deps, slice.unpublished, batched))
      : undefined
    // What follows sends, and is never cut short.
    prepare.clear()
    // The address the burn pays is published before the burn, by the batch or on its own.
    if (publish && !publish.calls) {
      await publish.alone()
      publish = undefined
    }
    burn = slice ? await seedRegistrationBurn(deps, params, slice, operationId) : undefined
    const send = (broadcasts?: ContractFunctionInteraction[]) =>
      svc.claimSponsoredPaylink(params, sponsor, {
        operationId,
        // The claim's operation and the burn riding it hold the hash, in one write, before the
        // node takes it.
        onTxHash: async (hash) => {
          await writing(stores, async (w) => {
            if (!(await stores.operations.apply(operationId, { type: "sent", txHash: hash }, w)))
              throw new WalletError("invariant", "paylink claim: no record for its hash")
            await burn?.stamp(hash, w)
          })
        },
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
        ...(broadcasts ? { broadcasts } : {}),
      })
    try {
      try {
        txHash = await send(publish?.calls)
      } catch (err) {
        if (!publish || !(err instanceof ClaimBatchFullError)) throw err
        // A batch with no room for the broadcast: it goes first, on its own, and the burn after.
        await publish.alone()
        publish = undefined
        txHash = await send()
      }
    } catch (err) {
      // A batch that went out is a claim that went out: the burn's record keeps its hash, and the
      // chain settles both.
      const broadcast = burn ? await burn.recover(err) : null
      if (!broadcast) throw err
      await publish?.inFlight(broadcast)
      throw new TxInFlightError(broadcast, err)
    }
    await publish?.landed()
    await burn?.mined(txHash)
    if (sponsor.subscribe) noteSubscribed(deps, sponsor.fpcAddress, sponsor.railId)
    deps.session.oweFpcRefuel({ address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact })
    onStage?.("submitting")
    await bestEffort(
      "unknown",
      markLinkClaimed(stores, params, deps.account.getAddress().toString()),
    )
  } catch (e) {
    if (e instanceof TxInFlightError) throw e
    throw await paylinkFailure(stores, operationId, e, submission, deps.wallet.node)
  } finally {
    submission.stop()
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
  constructor(
    readonly reason: RegistrationFundingRefusal,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "RegistrationFundingError"
  }
}

/** The burn a funding claim adds to its batch, with what priced it. */
export interface RegistrationSlice {
  l1Recipient: EthAddress
  /** The gross the batch burns. */
  amount: bigint
  withdrawalFee: bigint
  relayerTip: bigint
  proverTip: bigint
  /** What the SIPA holds once the portal releases the burn. */
  target: bigint
  /** How the burn settles; its finalization request rides the claim batch. */
  withdrawal: WithdrawalOptions
  /** The registration whose address is not published yet: the claim publishes it. */
  unpublished?: PendingRegistrationRecord
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
  deps: ReadyPaylinkDeps,
  params: ReturnType<typeof decodePaylinkInline>,
  fundRegistration: boolean,
): Promise<{ sponsor: ClaimSponsorContext; voucherRail: ClaimSponsorContext | undefined }> {
  if (fundRegistration) {
    const voucherRail = await linkVoucher(deps, params, REGISTRATION_VOUCHER_CHECK_TIMEOUT_MS)
    if (!voucherRail)
      throw new Error("this link's voucher is spent, so it cannot pay for the account")
    return { sponsor: voucherRail, voucherRail }
  }
  try {
    return { sponsor: await claimSponsorContext(deps, RAIL_REGISTERED), voucherRail: undefined }
  } catch (err) {
    const voucherRail = await linkVoucher(deps, params, VOUCHER_CHECK_TIMEOUT_MS)
    if (!voucherRail) throw err
    return { sponsor: voucherRail, voucherRail }
  }
}

/**
 * The golden ticket's second half: when this account's registration still waits for its deposit,
 * the claim batch also burns the ticket quote to the registration SIPA, so the link pays for the
 * tag. The quote is `goldenTicketCoverage` off the signed schedule and the prover tip the review
 * committed, none when it committed nothing. Undefined leaves an
 * ordinary claim as it was; a required burn that cannot be priced or covered refuses the claim, as
 * do lapsed terms, which need a renewal before the irreversible burn. An address not yet published
 * is published by the claim.
 */
export async function registrationSlice(
  deps: ReadyPaylinkDeps,
  noteAmount: bigint | undefined,
  required: boolean,
  nowMs: number = Date.now(),
): Promise<RegistrationSlice | undefined> {
  if (!required) return undefined
  const record = currentRegistration(
    loadedRegistrations(deps.session.registrations),
    deps.account.getAddress().toString(),
  )
  if (!record || record.phase !== "awaiting_deposit" || record.fundedAt !== undefined) {
    throw new RegistrationFundingError(
      "no_registration",
      "this account has no registration waiting for the link's deposit",
    )
  }
  const terms = record.terms ?? null
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
  if (quoteExpired(terms, nowMs)) {
    throw new RegistrationFundingError(
      "expired",
      "the registration's reservation lapsed; renew it before the link funds it",
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
  const tuple = await deps.session.page.chain.oxideTuple.read()
  const unpriced = (what: string, err: unknown) =>
    new RegistrationFundingError(
      "unpriced",
      `the portal's ${what} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    )
  const proverTip = committedProverTip(terms)
  let withdrawalFee: bigint
  try {
    withdrawalFee = await withdrawalExecutorFee(deps.session.page.chain, tuple)
  } catch (err) {
    throw unpriced("withdrawal fee", err)
  }
  const coverage = goldenTicketCoverage(noteAmount, schedule, proverTip, withdrawalFee)
  if (!coverage.covers) {
    throw new RegistrationFundingError(
      "uncovered",
      `the link holds ${noteAmount} and the registration burns ${coverage.burn}`,
    )
  }
  let withdrawal: WithdrawalOptions
  try {
    withdrawal = withdrawalOptions(deps.session.page.config, tuple)
  } catch (err) {
    throw unpriced("withdrawal state", err)
  }
  return {
    l1Recipient: EthAddress.fromString(record.sipaAddress),
    amount: coverage.burn,
    withdrawalFee,
    relayerTip: WITHDRAW_RELAYER_TIP,
    proverTip,
    target: coverage.sipaTarget,
    withdrawal,
    ...(record.broadcast ? {} : { unpublished: record }),
  }
}

/**
 * A ticket signup's registration broadcast, which its claim sends: in the claim's own batch
 * (`calls`, when `batched`), or `alone` ahead of it. A queued ledger job for the address is dropped,
 * since the claim sends it. One the ledger is proving or sent is waited out: undefined once it
 * landed, nothing left to publish.
 */
async function registrationPublish(
  deps: ReadyPaylinkDeps,
  record: PendingRegistrationRecord,
  batched: boolean,
) {
  const { config } = deps.session.page
  const address = record.sipaAddress.toLowerCase()
  const { sipaDeposits: store, holdBroadcast, registrationPayloads } = deps.session
  await store.ready
  const job = () => broadcastJob(store.view.get().records, address)
  try {
    await withTimeout(broadcastAttemptEnded(store.view, address), PUBLISH_SETTLE_MS)
  } catch (err) {
    throw new RegistrationFundingError(
      "unpublished",
      "the registration's deposit address is still being published; claim once it lands",
      { cause: err },
    )
  }
  const landed = async (): Promise<void> => {
    registrationPayloads.delete(address)
    await deps.session.registrations.broadcastSent(address)
    if (job()) await store.apply(address, { type: "broadcastLanded" })
  }
  if (job()?.state === "landed") {
    await landed()
    return undefined
  }
  let built: Awaited<ReturnType<typeof registrationBroadcastPayload>>
  try {
    built = await registrationBroadcastPayload(deps.wallet, config, record, deps.session)
  } catch (err) {
    throw new RegistrationFundingError(
      "unpublished",
      `the registration's deposit address cannot be published yet: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  const sender = {
    wallet: deps.wallet,
    account: built.account,
    contractService: deps.contractService,
    config,
    handle: record.tag,
    session: deps.session,
  }
  await cacheFreshClaim(sender, built.payload)
  const calls = batched ? await registrationBroadcastCalls(sender, built.payload) : undefined
  if (job()) await store.apply(address, { type: "broadcastAbandoned" })
  const owed = (txHash: string) =>
    store.oweBroadcast(address, {
      kind: "registration",
      source: { type: "registration", account: record.account },
      txHash,
    })
  return {
    calls,
    /**
     * The broadcast as its own tx, before the claim. The ledger holds its hash from the send on, so
     * a send whose outcome is unknown is decided by the chain, never sent twice. Its job is held
     * while this page sends.
     */
    async alone(): Promise<void> {
      let noted: Promise<unknown> | undefined
      const release = holdBroadcast(address)
      try {
        await createWebRegistrationBroadcaster(sender)(built.payload, {
          onTxHash: async (txHash) => {
            noted = owed(txHash)
            await noted
          },
        })
      } catch (err) {
        release()
        if (!noted) throw err
        await noted
        await withTimeout(broadcastAttemptEnded(store.view, address), PUBLISH_SETTLE_MS).catch(
          () => {},
        )
        if (job()?.state !== "landed") throw err
      }
      try {
        await landed()
      } finally {
        release()
      }
    },
    /** The tx carrying the broadcast landed: the record says so, and no ledger job is left owing. */
    landed,
    /** The tx carrying it reached the node: the ledger watches that hash, and re-sends if it drops. */
    async inFlight(txHash: string): Promise<void> {
      await owed(txHash)
    },
  }
}

/**
 * The registration burn's withdrawal record, kept the way a balance withdrawal is: seeded before
 * the batch signs, mined after it, failed or dropped when it does not go out, and armed on the
 * chain watcher. That record is what tells the activation surfaces the funding is on its way, and
 * what offers the burn's manual finalization if the relayer stalls.
 */
async function seedRegistrationBurn(
  deps: ReadyPaylinkDeps,
  params: ReturnType<typeof decodePaylinkInline>,
  slice: RegistrationSlice,
  operationId: string,
) {
  const store = deps.session.withdrawals
  await store.ready
  const token = await deps.tokenService.fetchTokenInformation()
  const tuple = await deps.session.page.chain.oxideTuple.read()
  const localId = newWithdrawalLocalId(deps.session.page.now())
  const startTime = Date.now()
  await store.create({
    localId,
    operationId,
    networkId: deps.wallet.networkId,
    recipient: getAddress(slice.l1Recipient.toString()),
    recipientProvenance: "saved-recipient",
    source: "paylink",
    intent: "registration",
    paylinkId: paylinkIdentity(params),
    // The gross the batch burns: what leaves the balance, and what the feed's row shows.
    amount: formatUnits(slice.amount, token.decimals),
    rawAmount: slice.amount.toString(),
    relayerTip: slice.relayerTip.toString(),
    ...(slice.withdrawalFee ? { withdrawalFee: slice.withdrawalFee.toString() } : {}),
    ...(slice.proverTip ? { proverTip: slice.proverTip.toString() } : {}),
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    phase: "submitting",
    startTime,
    deployment: await currentDeployment(tuple),
  })
  // The claim's own write sends the operation.
  const submission = trackWithdrawalSubmission(
    deps.session.page.prover.progress,
    store,
    localId,
    operationId,
  )
  return {
    /** Saves the burn's hash on its record; rejects when it did not persist. */
    stamp: (hash: string, w?: Write) => submission.stampIn(hash, w),
    /**
     * After a failed send: the burn's hash when the batch was broadcast and not seen failing, so
     * the claim went out with it; null once the record is dropped (a cancel) or failed.
     */
    async recover(err: unknown): Promise<string | null> {
      try {
        const pending = await submission.recover(deps.wallet.node)
        const broadcast = pending && (pending.l2TxHash ?? submission.txHash)
        if (pending && broadcast) {
          void deps.session.wake(deps.session.withdrawalTracker)
          return broadcast
        }
        const message =
          sponsorshipErrorCopy(err, "registration:burn")?.message ??
          (err instanceof Error ? err.message : "Withdrawal failed")
        if (isFlowCancelled(err)) {
          await bestEffort("unknown", store.remove(localId))
        } else {
          const failed = { phase: "failed", failure: withdrawalFailure(message) } as const
          await bestEffort("unknown", store.apply(localId, { type: "patch", fields: failed }))
        }
        return null
      } finally {
        submission.stop()
      }
    },
    /** Mined. Nothing here may fail the claim: a record left at its hash resumes on the next boot. */
    async mined(txHash: string): Promise<void> {
      const durationMs = Date.now() - startTime
      submission.stop()
      try {
        const receipt = await deps.wallet.node
          .getTxReceipt(TxHash.fromString(txHash))
          .catch(() => undefined)
        if (receipt?.blockNumber !== undefined) {
          await store.apply(localId, {
            type: "mined",
            l2TxHash: txHash,
            blockNumber: receipt.blockNumber,
            rawAmount: slice.amount.toString(),
            relayerTip: slice.relayerTip.toString(),
          })
          void recordBurnDuration(deps.session.burnDurations, durationMs)
        } else {
          await store.apply(localId, {
            type: "patch",
            fields: { phase: "submitting", l2TxHash: txHash as Hex },
          })
        }
        void deps.session.wake(deps.session.withdrawalTracker)
      } catch (e) {
        console.warn("registration burn mined; its record could not be updated, resumes on boot", e)
      }
    },
  }
}

/**
 * Sponsored `claim_to_l1`: the escrow burns to `recipient` through the portal and
 * the result is tracked as a withdrawal — the record is seeded pre-sign, marked mined, and armed on
 * the chain watcher exactly like a balance withdrawal, swap route included (a non-DAI output burns
 * to the planned escrow with the deploy broadcast riding the burn). No paylink queue row is
 * written; the withdrawal record is the activity row. A create row this device made is still
 * marked claimed. Like a cash-out, it runs under the link's one burn operation.
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
  /** Paid to the first prover of the burn's checkpoint; a planned leg's must match. */
  proverTip = 0n,
  /** Land on another chain: the burn pays an Across escrow instead of a swap. */
  bridge?: BridgeOutChoice,
): Promise<WithdrawalRecord> {
  const summary = `Paylink to ${recipientAlias?.trim() || "Ethereum"}`
  return runLinkBurn(deps.session, fragment, summary, (op) =>
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
      proverTip,
      bridge,
    ),
  )
}

/** The swap leg of a link claim, sized off the escrow note's `amount` (the link carries none). */
export async function planLinkClaimSwap(
  session: ChainSession & Pick<Session, "auth" | "page">,
  fragment: string,
  amount: bigint,
  recipient: Address,
  receiveAsset: WithdrawalReceiveAsset,
  quote?: SwapCommit,
  proverTip = 0n,
): Promise<SwapLeg | undefined> {
  const chain = await chainOf(session)
  const { note, tuple } = await readPaylinkSource(chain, fragment, session.page)
  if (note.amount !== amount) throw new Error("The link balance changed; reopen the withdrawal")
  return planSwapLeg(
    session.page.chain,
    (tuple) => sessionSwapRecoverer(session, tuple),
    receiveAsset,
    recipient,
    amount,
    quote,
    tuple,
    proverTip,
  )
}

async function claimLinkToL1Flow(
  op: OperationHandle,
  input: SponsoredPaylinkDeps,
  fragment: string,
  recipient: Address,
  screener: AddressScreener,
  onStage: (stage: WithdrawStage) => void,
  recipientAlias?: string,
  receiveAsset: WithdrawalReceiveAsset = "DAI",
  quote?: SwapCommit,
  zkProof?: PaylinkL1Proof,
  planned?: SwapLeg,
  proverTip = 0n,
  bridge?: BridgeOutChoice,
): Promise<WithdrawalRecord> {
  const startedAt = Date.now()
  onStage("building")
  const { config, chain } = input.session.page
  const liveDeps = await readyPaylinkDeps(input)
  const { params, note, tuple } = await readPaylinkSource(liveDeps, fragment, input.session.page)
  const { wallet, account } = liveDeps
  const sourceContext = await historicTokenContext(chain, wallet, account, tuple)
  const deps = { ...liveDeps, ...sourceContext }
  const flavor: LinkFlavor =
    params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct"
  const svc = service(deps)
  // The burn spends the escrow note and the fee comes off it. A note that cannot clear the fee
  // would revert, or leave the recipient nothing — refuse up front. The whole note is the
  // withdrawal the limit counts.
  const amount = note.amount
  const decimals = tokenDecimalsForNetwork(config.network)
  assertWithinWithdrawalLimit(
    amount,
    await chain.txAmountCap(tuple.portal as Address).read(),
    "link",
    decimals,
  )
  const withdrawalFee = await withdrawalExecutorFee(input.session.page.chain, tuple)
  const fee = withdrawalFee + WITHDRAW_RELAYER_TIP + proverTip
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
  const bridgeLeg =
    bridge &&
    (await planBridgeLeg(input.session.page, deps, tuple, {
      ...bridge,
      from: deps.account.getAddress(),
      amount,
      recipient,
      proverTip,
      recoverer: await sessionSwapRecoverer(deps.session, tuple),
    }))
  const swap = bridgeLeg
    ? undefined
    : planned ??
      (await planLinkClaimSwap(
        deps.session,
        fragment,
        amount,
        recipient,
        receiveAsset,
        quote,
        proverTip,
      ))
  assertPaylinkSwapSource(swap, tuple)
  const withdrawal = bridgeLeg
    ? { ...withdrawalOptions(config, tuple), escrow: bridgeLeg.escrow }
    : withdrawalOptions(config, tuple, swap)
  const token = await deps.tokenService.fetchTokenInformation()
  op.describe(`$${formatUnits(amount - fee, decimals)} to ${recipientAlias?.trim() || "Ethereum"}`)
  const paylinkId = paylinkIdentity(params)
  await owePaylinkClaim(deps.session.owedClaims, paylinkId, {
    rollupAddress: deps.rollupAddress,
    secret: params.secret,
    flavor,
    amount,
    decimals,
  })
  const { record, result } = await runBurn({
    op,
    session: deps.session,
    record: {
      recipient,
      recipientProvenance: "saved-recipient",
      recipientAlias: recipientAlias?.trim() || undefined,
      source: "paylink",
      paylinkId,
      amount: formatUnits(amount - fee, token.decimals),
      rawAmount: amount.toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      ...(withdrawalFee ? { withdrawalFee: withdrawalFee.toString() } : {}),
      ...(proverTip ? { proverTip: proverTip.toString() } : {}),
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      phase: "submitting",
      startTime: Date.now(),
      deployment: await currentDeployment(tuple),
      ...(bridgeLeg ? bridgeLeg.record : swapRecordFields(swap, quote)),
    },
    burn: (seeded, onTxHash) => {
      onStage("proving")
      // Off the persisted record, so what the burn pays can never drift from what was written.
      return svc.claimSponsoredPaylinkToL1(
        params,
        EthAddress.fromString(withdrawalRecipients(seeded).release),
        { proverTip, withdrawal },
        sponsor,
        { operationId: op.operationId, zkProof, onTxHash },
      )
    },
    // The batch refuses to sign unless the burn spends the whole note.
    minedFigures: async () => ({
      amount: amount.toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
    }),
  })
  // A burn left to the chain reports once the tracker marks its record mined.
  void bestEffort(
    "unknown",
    deps.session.withdrawals
      .all()
      .then((burns) => reportPaylinkClaims(burns, deps.session.owedClaims)),
  )
  if (!result) return record
  void recordBurnDuration(deps.session.burnDurations, Date.now() - startedAt)
  // Mined and irreversible: none of this may fail the record.
  onStage("submitting")
  let mined = record
  try {
    // The burn spent what the note held, which the seeded net may not match.
    if (mined.rawAmount !== amount.toString()) {
      const net = { phase: mined.phase, amount: withdrawalAmounts(mined).netDisplay }
      mined =
        (await deps.session.withdrawals.apply(mined.localId, { type: "patch", fields: net })) ??
        mined
    }
    if (sponsor.subscribe) noteSubscribed(deps, sponsor.fpcAddress, sponsor.railId)
    deps.session.oweFpcRefuel({ address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact })
    await markLinkClaimed(deps.session, params, deps.account.getAddress().toString())
    if (deps.session.contacts)
      void upsertSavedL1WalletContact(deps.session.contacts, {
        address: recipient,
        name: recipientAlias,
      })
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
export async function recoverSponsoredLink(
  input: SponsoredPaylinkDeps,
  fragment: string,
  onStage?: (stage: CreateStage) => void,
  /** Runs at the submit boundary before the rows learn the hash; a throw aborts the send. */
  onTxHash?: TxHashCallback,
): Promise<string> {
  const params = decodePaylinkInline(fragment)
  const deps = await readyPaylinkDeps(input)
  return runOperation(
    deps.session,
    {
      operationId: nextOperationId("paylink-refund"),
      flow: "paylink-reclaim",
      summary: linkSummary(null),
      // The link reads as refunding from the tap.
      ...(await payout(deps, "paylink-refund", params, undefined)),
    },
    (op) => recoverSponsoredLinkFlow(op, deps, fragment, params, onStage, onTxHash),
    (txHash) => txHash,
  )
}

/**
 * Whether the creator can take the link back now, only once it expires, or not at all because its
 * escrow is spent: `spending` until an L1 checkpoint holds the spend, since a reorg can reopen the
 * link. Read from the chain, as `recoverSponsoredLink` decides the same.
 */
export async function linkRefundable(
  deps: ViewLinkDeps,
  row: Pick<PaylinkRecord, "untilClaimable" | "refundableUntil"> | null,
  fragment: string,
): Promise<"now" | "later" | "spending" | "spent"> {
  const spentAt = await statusService(deps).paylinkClaimBlock(decodePaylinkInline(fragment))
  if (spentAt !== undefined)
    return spentAt <= (await deps.wallet.node.getBlockNumber("checkpointed")) ? "spent" : "spending"
  const now = await latestChainSeconds(deps.wallet.node)
  if (row?.untilClaimable != null && now > row.untilClaimable) return "now"
  return row?.refundableUntil != null && canCancelAt(row.refundableUntil, now) ? "now" : "later"
}

/**
 * The escrow refunds the token baked into its note. For a link created on a retired deployment
 * that is the historic l2Token, so the refund runs through that generation's token service, TEE
 * signer and ClaimFPC; a row without a token, on the current token, or on a delisted one keeps the
 * live deps.
 */
export async function refundDepsForRow(
  deps: ReadyPaylinkDeps,
  row: Pick<PaylinkRecord, "tokenAddress"> | null,
): Promise<{ deps: ReadyPaylinkDeps; tuple?: OxideEnvTuple }> {
  const tokenAddress = row?.tokenAddress
  const current = deps.tokenService.tokenAddressOrNull?.toString()
  if (!tokenAddress || !current || tokenAddress.toLowerCase() === current.toLowerCase()) {
    return { deps }
  }
  const { config, chain } = deps.session.page
  const historic = await findHistoricTuple(config, tokenAddress)
  if (!historic) {
    throw new Error(`The refund token ${tokenAddress} has no available deployment`)
  }
  const context = await historicTokenContext(chain, deps.wallet, deps.account, historic)
  return { deps: { ...deps, ...context }, tuple: historic }
}

async function recoverSponsoredLinkFlow(
  op: OperationHandle,
  liveDeps: ReadyPaylinkDeps,
  fragment: string,
  params: PaylinkParams,
  onStage?: (stage: CreateStage) => void,
  onTxHash?: TxHashCallback,
): Promise<string> {
  onStage?.("building")
  const flavor: LinkFlavor =
    params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct"
  // The offer was made from a polled tip that may be seconds old; the refund tx expires at
  // `refundable_until` unless the link is already past expiry. Re-read once before anything is
  // proven or recorded.
  const stores = liveDeps.session
  const row = await creatorLinkFor(stores, fragment)
  const now = await latestChainSeconds(liveDeps.wallet.node)
  // The escrow pays only its creator: another account's refund would fail after proving.
  if (row && !linkMadeBy(row, liveDeps.account.getAddress().toString())) {
    throw new Error("Only the account that made this link can take it back")
  }
  const { deps, tuple } = await refundDepsForRow(liveDeps, row)
  const svc = service(deps)
  const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED, { tuple })
  const expired = row?.untilClaimable != null && now > row.untilClaimable
  const refundKind: PaylinkRecovery = expired ? "reclaim" : "cancel"
  if (!expired && row?.refundableUntil != null && !canCancelAt(row.refundableUntil, now)) {
    throw new PaylinkWindowClosedError()
  }
  const decimals = tokenDecimalsForNetwork(liveDeps.session.page.config.network)
  // The link carries no amount; the create row does.
  const rowAmount = row?.token?.amount
  op.describe(linkSummary(rowAmount))
  const { operationId } = op
  // The row's amount, and the token a retired deployment refunds.
  await startPayout(
    op,
    deps,
    "paylink-refund",
    params,
    row && rowAmount !== undefined ? { atomic: row.amountAtomic, human: rowAmount } : undefined,
  )
  onStage?.("proving")
  const account = deps.account.getAddress().toString()
  const submission = trackSubmission(liveDeps.session.page.prover.progress, operationId)
  let txHash: string
  try {
    txHash = await svc.refundSponsoredPaylink(params, sponsor, {
      operationId,
      // The creator row learns of the refund before submit too: after a reload the claim
      // reconciler would otherwise read the spent note as a recipient's claim.
      onTxHash: async (hash, tx) => {
        await onTxHash?.(hash, tx)
        await saveRefundSubmitted(stores, operationId, params, account, hash, refundKind)
      },
    })
    if (sponsor.subscribe) noteSubscribed(deps, sponsor.fpcAddress, sponsor.railId)
    deps.session.oweFpcRefuel({ address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact })
    onStage?.("submitting")
    await bestEffort("unknown", markLinkRefunded(stores, params, account, txHash, refundKind))
  } catch (e) {
    throw await paylinkFailure(stores, operationId, e, submission, deps.wallet.node)
  } finally {
    submission.stop()
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
  network: Network,
  fragment: string,
  amount: bigint | undefined,
  flavor: LinkFlavor,
  email?: string,
  txHash?: string,
): PaymentLink {
  return {
    url: paylinkShareUrl(fragment, network),
    fragment,
    amount:
      amount === undefined ? undefined : formatUnits(amount, tokenDecimalsForNetwork(network)),
    status: "unclaimed",
    flavor,
    email,
    txHash,
  }
}

/**
 * Decode a link fragment into its display shape — no wallet needed. The fragment names the flavor
 * and nothing else to show: amount, email, memo and funding tx wait for `viewLink` to read the
 * escrow. Status starts unclaimed until `viewLink` reads the nullifier, or retired for a link made
 * on another rollup of this L1 chain.
 *
 * Every inbound link decodes here (`/link`, Home's stash, `viewLink`), so an email link is refused
 * while email-locked links are off, before any signup, Google sign-in or transaction.
 */
export function decodeLink(config: WebWalletConfig, fragment: string): PaymentLink {
  const params = decodePaylinkInline(fragment)
  const flavor: LinkFlavor =
    params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct"
  if (flavor === "email" && !emailLockedLinksEnabled) throw new EmailPaylinkUnsupportedError()
  const link = linkShape(config.network, fragment, undefined, flavor)
  return isRetiredLink(params, config) ? { ...link, status: "retired" } : link
}

/**
 * A link funded on another rollup of this L1 chain, an earlier generation's: its escrow is not on
 * this rollup, so nothing can claim it here. A link for another L1 chain is not retired; the SDK
 * refuses it.
 */
function isRetiredLink(
  params: { chainId: number; rollupVersion: number },
  config: { l1ChainId: number; profileRollupVersion: string },
): boolean {
  return (
    params.chainId === config.l1ChainId &&
    String(params.rollupVersion) !== config.profileRollupVersion
  )
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
 * `PaylinkService` requires an Account/TokenService in its constructor, but the status and note
 * reads use neither: the memo comes off the token the escrow note names. Placeholders keep the
 * status path runnable before passkey unlock.
 */
function statusService(deps: ViewLinkDeps): PaylinkService {
  const sender =
    deps.account ?? ({ getAddress: () => AztecAddress.ZERO } as unknown as ObsidionAccount)
  return new PaylinkService(deps.wallet, sender, {} as TokenService, deps.contractService)
}

/**
 * The funding transfer's sender tag, kept only when the name registry resolves it to that
 * transfer's sender: the creator writes the tag, so any creator could write any tag. A read that
 * fails drops it.
 */
async function verifiedSenderTag(
  page: PageFacts,
  tag?: string,
  from?: string,
): Promise<string | undefined> {
  if (!tag || !from) return undefined
  try {
    const resolution = await withTimeout(
      resolveTagViaRegistry(page, tag),
      SENDER_TAG_CHECK_TIMEOUT_MS,
    )
    return resolution.status === "resolved" &&
      resolution.l2Address.toLowerCase() === from.toLowerCase()
      ? tag
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Decode a link + read its on-chain status via the paylink nullifier tree
 * (`PaylinkService.isPaylinkClaimed`). Needs only wallet + contractService — no
 * passkey. `resolveLink` also unpacks `from_claimable` so `/link` can withhold Claim
 * during grace; the placeholder sender is enough to reconstruct the escrow.
 */
/** Whether the link's note is spent on chain, read now: the nullifier read the sweep makes. */
export function linkClaimed(deps: ViewLinkDeps, fragment: string): Promise<boolean> {
  return statusService(deps).isPaylinkClaimed(decodePaylinkInline(fragment))
}

export async function viewLink(deps: ViewLinkDeps, fragment: string): Promise<PaymentLink> {
  const params = decodePaylinkInline(fragment)
  const link = decodeLink(deps.session.page.config, fragment)
  if (link.status === "retired") return link
  const svc = statusService(deps)
  const claimed = await svc.isPaylinkClaimed(params)
  if (claimed) return { ...link, status: "claimed" }
  try {
    // The note read is a PXE simulation that can wait on block sync (the PXE trails the tip; a
    // just-created escrow's note is unreadable until the chain moves on). Bound it so a stalled
    // read cannot pin the screen's status check; without it the link shows as claimable now and
    // the contract still gates the claim.
    const resolved = await withTimeout(svc.resolveLink(params, deps.account), NOTE_READ_TIMEOUT_MS)
    const { page } = deps.session
    const decimals = tokenDecimalsForNetwork(page.config.network)
    const senderTag = await verifiedSenderTag(page, resolved.senderTag, resolved.from)
    return {
      ...link,
      status: "unclaimed",
      amount: formatUnits(resolved.note.amount, decimals),
      tokenAddress: resolved.note.tokenAddress.toString(),
      claimableFrom: resolved.note.claimableFrom,
      claimableUntil: resolved.note.claimableUntil,
      memo: resolved.memo,
      senderTag,
      email: resolved.email,
      commitment: resolved.commitment.toString(),
      txHash: resolved.txHash,
    }
  } catch (e) {
    // A note other than the one the link was made for is refused outright.
    if (e instanceof Error && e.message === PAYLINK_TERMS_REFUSAL)
      throw new WalletError("paylink.termsMismatch", PAYLINK_TERMS_REFUSAL, { cause: e })
    // Note sync failed but nullifier says unclaimed — no amount to show; the watcher retries.
  }
  return { ...link, status: "unclaimed" }
}
