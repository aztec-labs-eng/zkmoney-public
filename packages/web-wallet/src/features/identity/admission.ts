// Waitlist admission at wallet entry. The campaign stamps `access_granted_at` on its user row
// (keyed by the SIWE wallet address, which IS this wallet's bootstrap EOA — identical PRF salt and
// derivation label, see launch-campaign-web/src/registration/campaignKeys.ts). The wallet proves
// key possession with a personal-sign over a timestamped preimage and asks the campaign directly;
// no session cookie crosses origins. A granted verdict is durable (grants are add-only), so it is
// cached — pinned to the identity it admitted, cleared with it — and never re-asked. Entry is
// allowed on granted OR a confirmed name registration — paying the registration deposit is the
// documented queue-skip, so a registered name admits by itself.

import { CAMPAIGN_ADMISSION_PREIMAGE_PREFIX, registrationFloor } from "@obsidion/core/constants"
import { fundsIn, type PendingRegistrationRecord } from "@obsidion/front-core"
import type { Hex } from "viem"
import type { PrivateKeyAccount } from "viem/accounts"
import { useSyncExternalStore } from "react"
import { getConfig } from "../../config/env"
import { walletStorage } from "../../platform/storage/walletStorage"
import { fireEvent } from "../../lib/analytics"
import { showReportableError } from "../../errors/errorModal"
import { askedTotal, signedSchedule } from "../onboarding/registrationAsk"
import { loadRegistrationTerms } from "../onboarding/registrationTerms"
import { getPendingStore } from "../onboarding/webRegistration"
import { readRegistrationStage } from "../onboarding/openRegistration"
import { loadWalletIdentity } from "./walletIdentity"

/** Replicates launch-campaign-web/src/api/admissionVerify.ts byte-for-byte. */
export function admissionVerifyPreimage(address: string, timestamp: number): string {
  return `${CAMPAIGN_ADMISSION_PREIMAGE_PREFIX}${address.toLowerCase()}:${timestamp}`
}

const STORAGE_KEY = "webwallet.admission"
const DEPOSIT_ENTRY_KEY = "webwallet.depositAdmission"
const DEPOSIT_ENTRY_CHANGED = "webwallet:deposit-admission-changed"

type DepositEntryRecord = Pick<
  PendingRegistrationRecord,
  "account" | "tag" | "nameHash" | "sipaAddress" | "depositToken" | "l1ChainId" | "l2Address"
>

function depositEntry(record: DepositEntryRecord): string {
  const { account, nameHash, sipaAddress, depositToken, l1ChainId, l2Address } = record
  return JSON.stringify({ account, nameHash, sipaAddress, depositToken, l1ChainId, l2Address })
}

/**
 * What a deposit must reach to buy entry to the wallet: the lower of this registration's own
 * signed floor and what an earned tag is asked to deposit. A deposit the sweep would take admits,
 * and so does one at the figure the campaign asked for, whatever the signed schedule prices.
 * `fpcFundingCut` may be undefined while the read is out; the asked figure stands until it lands.
 */
export function admissionFloor(
  record: Pick<PendingRegistrationRecord, "account" | "tag">,
  fpcFundingCut: bigint | undefined,
): bigint {
  const ask = askedTotal("earned_tag")
  const signed = signedSchedule(loadRegistrationTerms(record.account, record.tag))
  // The ask stands wherever the floor cannot be priced: no usable signed schedule, or no portal cut.
  if (signed === undefined || fpcFundingCut === undefined) return ask
  const floor = registrationFloor(signed, fpcFundingCut)
  return floor < ask ? floor : ask
}

/** Records pending wallet access after an L1 read, without changing sweep readiness or pricing. */
export function recordDepositAdmission(
  record: DepositEntryRecord,
  observed: bigint,
  fpcFundingCut?: bigint,
): boolean {
  if (observed < admissionFloor(record, fpcFundingCut)) return false
  walletStorage.setItem(DEPOSIT_ENTRY_KEY, depositEntry(record))
  window.dispatchEvent(new Event(DEPOSIT_ENTRY_CHANGED))
  return true
}

function subscribeDepositAdmission(onChange: () => void): () => void {
  window.addEventListener(DEPOSIT_ENTRY_CHANGED, onChange)
  return () => window.removeEventListener(DEPOSIT_ENTRY_CHANGED, onChange)
}

export function useDepositAdmission(record: PendingRegistrationRecord | null): boolean {
  return useSyncExternalStore(
    subscribeDepositAdmission,
    () => record !== null && hasDepositAdmission(record),
  )
}

export function hasDepositAdmission(record: PendingRegistrationRecord): boolean {
  try {
    const receipt = JSON.parse(
      walletStorage.getItem(DEPOSIT_ENTRY_KEY) ?? "null",
    ) as DepositEntryRecord | null
    return (
      receipt !== null &&
      receipt.account === record.account &&
      receipt.nameHash === record.nameHash &&
      receipt.sipaAddress === record.sipaAddress &&
      receipt.depositToken === record.depositToken &&
      receipt.l1ChainId === record.l1ChainId &&
      receipt.l2Address === record.l2Address
    )
  } catch {
    return false
  }
}

/**
 * The entry a verified refund carries onto the replacement record, where it outlives sign-outs.
 * The refunded address can never show the deposit again, so the amount is checked here: a refund
 * short of the admission floor restarts the registration but buys no entry.
 */
export function refundedEntry(
  record: Pick<PendingRegistrationRecord, "account" | "tag" | "sipaAddress">,
  refund: { amount: bigint; txHash: Hex },
  fpcFundingCut?: bigint,
): PendingRegistrationRecord["refundedEntry"] {
  if (refund.amount < admissionFloor(record, fpcFundingCut)) return undefined
  return {
    sipaAddress: record.sipaAddress,
    recoveryTxHash: refund.txHash,
    amount: refund.amount.toString(),
  }
}

type AdmissionCache = { address: string; l2Address: string; grantedAt: number }

export type AdmissionCheck =
  | { status: "granted" }
  | { status: "queued"; queuePosition: number | null }
  /** The campaign has never seen this key: it must join the waitlist there first. */
  | { status: "unknown" }
  /** Campaign unreachable or answering garbage — the caller decides how hard to fail. */
  | { status: "unavailable" }
  /** The caller's operation ended while the verify was pending: nothing cached, reported or emitted. */
  | { status: "cancelled" }

function loadCache(): AdmissionCache | null {
  try {
    const raw = walletStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AdmissionCache
    return typeof parsed.address === "string" && typeof parsed.l2Address === "string"
      ? parsed
      : null
  } catch {
    return null
  }
}

/** True when this device already proved a grant for `address` (any address when omitted). */
export function hasCachedAdmission(address?: string): boolean {
  const cache = loadCache()
  if (!cache) return false
  return address === undefined || cache.address === address.toLowerCase()
}

/** A cached grant admits only the identity it was proved for. */
function cacheAdmits(l2Address: string): boolean {
  return loadCache()?.l2Address === l2Address
}

export function cacheAdmission(address: string, l2Address: string): void {
  walletStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      address: address.toLowerCase(),
      l2Address,
      grantedAt: Date.now(),
    } as AdmissionCache),
  )
}

/** The receipt vouches for funds at one address; a refund that emptied it takes the receipt with it. */
export function forgetDepositAdmission(record: PendingRegistrationRecord): void {
  if (!hasDepositAdmission(record)) return
  walletStorage.removeItem(DEPOSIT_ENTRY_KEY)
  window.dispatchEvent(new Event(DEPOSIT_ENTRY_CHANGED))
}

export function clearAdmission(): void {
  walletStorage.removeItem(STORAGE_KEY)
  walletStorage.removeItem(DEPOSIT_ENTRY_KEY)
  window.dispatchEvent(new Event(DEPOSIT_ENTRY_CHANGED))
}

/** Always false in a built wallet: entry asks no waitlist. Tests arm it to cover the gated paths. */
export function admissionGateEnabled(): boolean {
  return getConfig().admissionGate
}

/**
 * The deposit is the paid queue-skip, so it admits the moment the registration's stage has funds
 * in, and keeps admitting once paid: a funded attempt that lost the name race still bought entry.
 * Every one of the identity's registrations counts, not just the newest, and so does a refunded
 * one whose replacement carries it.
 */
function depositAdmits(l2Address: string): boolean {
  return getPendingStore()
    .list()
    .some((rec) => {
      if (rec.l2Address !== l2Address) return false
      if (rec.fundedAt !== undefined || rec.refundedEntry !== undefined) return true
      if (hasDepositAdmission(rec)) return true
      const stage = readRegistrationStage(rec)
      return stage === "registered" || fundsIn(stage)
    })
}

/**
 * The synchronous entry decision (WalletGate renders on it): a cached grant, a confirmed name
 * registration, a funded one, or no gate configured. Queued users still reach onboarding — the
 * claim + deposit flow lives outside the wallet routes on purpose.
 */
export function hasWalletEntry(): boolean {
  if (!admissionGateEnabled()) return true
  const identity = loadWalletIdentity()
  if (identity === null) return false
  if (identity.handle && identity.pending !== true) return true
  if (cacheAdmits(identity.address)) return true
  return depositAdmits(identity.address)
}

/** The record-only variant of the entry decision, for completion paths that run before the
 * identity record exists (a reloaded tab entering from its pending registration). `l2Address` is
 * the account being entered — a cached grant only counts when it was proved for that account. */
export function registrationAdmits(phase: string, l2Address: string): boolean {
  return (
    !admissionGateEnabled() ||
    cacheAdmits(l2Address) ||
    phase === "funded" ||
    phase === "confirmed" ||
    depositAdmits(l2Address)
  )
}

/** Where an admission answer was needed: the route gate, /enter, or onboarding completion. */
export type AdmissionSurface = "gate" | "enter" | "onboarding"

/** The event's closed outcome vocabulary ("unreachable" is the wire name for "unavailable"). */
function admissionOutcome(status: AdmissionCheck["status"]): string {
  return status === "unavailable" ? "unreachable" : status
}

let gateBounceReported = false

/**
 * Counts a queued-or-unverified user bouncing off WalletGate — the gate itself runs no verify
 * (hasWalletEntry is synchronous), so the outcome is honestly "unknown". Once per page load: the
 * gate re-runs on every route render.
 */
export function reportGateBounce(): void {
  if (gateBounceReported) return
  gateBounceReported = true
  fireEvent("admission_checked", { outcome: "unknown", surface: "gate" })
}

/** A verify that has not answered by then is treated like an unreachable campaign. */
const VERIFY_TIMEOUT_MS = 15_000

/**
 * The campaign's answer for one bootstrap key: the network verify alone, with no cache and no
 * reporting. `unknown` is a key the campaign never saw; a transport failure or timeout throws.
 */
export async function verifyAdmission(bootstrap: PrivateKeyAccount): Promise<AdmissionCheck> {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = await bootstrap.signMessage({
    message: admissionVerifyPreimage(bootstrap.address, timestamp),
  })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), VERIFY_TIMEOUT_MS)
  // The deadline covers the answer, not just the headers: fetch settles as soon as the status line
  // arrives, and a body that stalls after it would wait with nothing left to stop it. Aborting
  // errors the body stream too, so the read ends when the request does.
  try {
    const res = await fetch(`${getConfig().campaignUrl.replace(/\/$/, "")}/api/admission/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: bootstrap.address, timestamp, signature }),
      signal: abort.signal,
    })
    if (res.status === 404) return { status: "unknown" }
    if (!res.ok) return { status: "unavailable" }
    const state = (await res.json()) as { status?: unknown; queuePosition?: unknown }
    if (state.status === "granted") return { status: "granted" }
    if (state.status === "queued") {
      return {
        status: "queued",
        queuePosition: typeof state.queuePosition === "number" ? state.queuePosition : null,
      }
    }
    return { status: "unavailable" }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Asks the campaign for this key's admission and caches a grant against `l2Address`, the account
 * the grant is admitting. Call with the unlocked bootstrap account wherever entry is about to be
 * decided (onboarding completion, /enter). Every resolution of the network verify — and only the
 * verify: the gate-off and cached fast paths answered without asking — emits one
 * `admission_checked` with the caller's surface. `stillOwns` is asked once the verify settles: a
 * caller whose operation ended meanwhile gets `cancelled`, with nothing cached, emitted or shown.
 */
export async function checkAdmission(
  bootstrap: PrivateKeyAccount,
  l2Address: string,
  surface: AdmissionSurface,
  stillOwns?: () => boolean,
): Promise<AdmissionCheck> {
  if (!admissionGateEnabled()) return { status: "granted" }
  if (hasCachedAdmission(bootstrap.address) && cacheAdmits(l2Address)) return { status: "granted" }

  const ended = () => stillOwns !== undefined && !stillOwns()
  const resolve = (check: AdmissionCheck): AdmissionCheck => {
    fireEvent("admission_checked", { outcome: admissionOutcome(check.status), surface })
    return check
  }
  try {
    const check = await verifyAdmission(bootstrap)
    if (ended()) return { status: "cancelled" }
    if (check.status === "granted") cacheAdmission(bootstrap.address, l2Address)
    return resolve(check)
  } catch (err) {
    if (ended()) return { status: "cancelled" }
    // The flow still fails closed (queued-style copy), but a transport failure is an operational
    // error, not a clean "queued" — reportable so launch-week triage can tell them apart.
    fireEvent("action_failed", { action: "admission_check", code: "admission_unreachable" })
    showReportableError(err, "admission:verify", { title: "Couldn't verify your waitlist status" })
    return resolve({ status: "unavailable" })
  }
}
