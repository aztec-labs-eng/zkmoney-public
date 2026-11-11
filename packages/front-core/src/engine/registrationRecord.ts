/**
 * The record behind deposit-gated tag registration (registration-fee.md: registration by deposit),
 * one per registration SIPA. It is created before the deposit address shows and closed when the
 * Registry settles the name. It holds no bearer material: the NameClaim and the consent signature
 * are re-requestable or re-derivable, so it stays valid in plain storage.
 */

import type { Hex } from "viem"

export type PendingRegistrationPhase =
  | "awaiting_deposit" // SIPA derived + NameClaim obtained + broadcast; waiting for the sender's L1 deposit
  | "funded" // a deposit at/above the registration floor was seen at the SIPA; waiting for the relayer sweep
  | "confirmed" // Registry resolves the name to our account. Terminal.
  | "failed_taken" // name race lost to another claimant. Terminal.
  | "failed_terminal" // abandoned, or a terminal failure. Terminal.
  | "replaced" // another address took the registration over; a deposit here is only recovered. Terminal.

/** UI projection of the record: what the badge surfaces render. */
export type RegistrationUiState = "none" | "pending" | "escalated" | "failed"

/** The public P-256 key the original session included — pinned by value so a resumed rebuild is identical. */
export interface PendingRegistrationR1Key {
  qx: Hex
  qy: Hex
}

export interface PendingRegistrationRecord {
  /** Predicted L1 OxideAccount (the record's `owner`). */
  account: string
  /** Bare tag ("alice"). */
  tag: string
  /** Wire nameHash the Registry keys on. */
  nameHash: Hex
  /** The L2 address recorded as UserRecord.l2Address — pinned so a resumed rebuild is identical. */
  l2Address: Hex
  /** Present when the batch installs an r1 key; its qx/qy is also the confirmation match target. */
  r1Key?: PendingRegistrationR1Key
  /** The passkey credential id (base64url) the install records as the r1 key's metadata — pinned so a
   *  resumed rebuild is identical. */
  credentialId?: string
  /** Chain the session started on; a tick under a different chain no-ops. */
  l1ChainId: number

  // ── registration SIPA custody ──────────────────────────────────────────
  /** The registration SIPA a sender funds — the deposit address whose sweep registers the name. */
  sipaAddress: string
  /** The exact fee (base units, decimal string) and the allowlisted funder the SIPA address commits
   *  to; the sweep pays exactly these. */
  fee: string
  beneficiary: Hex
  /** The fee token the deposit must be paid in (`RegistrationController.FEE_TOKEN`). */
  depositToken: Hex
  /** Whether the initial broadcast to relayers landed (the SIPA is discoverable). */
  broadcast: boolean
  /** ms epoch a funding transfer at/above the floor was first seen at the SIPA. */
  fundedAt?: number
  /** ms epoch the SIPA was first funded. A refund that clears `fundedAt` keeps it. */
  firstFundedAt?: number
  /** The L1 transfer that funded the SIPA (self-initiated deposits only; a third-party's is invisible). */
  fundingTxHash?: Hex
  /** ms epoch the registration sweep was observed (a `Sweep` event on the SIPA). */
  sweptAt?: number
  /** The deploy-and-sweep tx that registered the name. */
  sweepTxHash?: Hex
  /** This wallet's transfer to the SIPA, saved before its receipt; gone once it fails. */
  submittedFunding?: SubmittedTx
  /** This wallet's manual sweep, saved before its receipt; gone once it fails. */
  submittedSweep?: SubmittedTx
  /** The recovered deposit that bought wallet entry: on the refunded record once its funded stamp
   *  is gone, and on the addresses that replaced it. */
  refundedEntry?: { sipaAddress: string; recoveryTxHash: Hex; amount: string }
  /** The address this one replaced. `refunded`: its deposit was recovered first. `broadcastSpent`:
   *  it, or one before it, used the account's one-shot broadcast, so only a manual sweep registers
   *  this address and nothing broadcasts it. */
  replaced?: { sipaAddress: string; refunded: boolean; broadcastSpent: boolean }

  phase: PendingRegistrationPhase
  /** Forced re-sign cycles — incremented only once sign-deps are in hand, right before signDomain. */
  retries: number
  /** ms epoch when the session created the record. */
  startTime: number
  /** ms epoch when the record reached a terminal phase. */
  endTime?: number
  terms?: RegistrationTerms
  /** The user settled on the tag: the address may be broadcast. Final. */
  tagConfirmed?: true
  route?: RegistrationRoute
  refunds?: RegistrationRefunds
  /** `recovery`: the account holds a name no local source maps. `acknowledged`: the user saw the
   *  loss, or chose it. */
  notice?: { recovery?: true; acknowledged?: true }
  /** The quote ran out with the deposit still owed. */
  lapsedAt?: number
}

/** A transaction this wallet sent, with its sender and nonce when the node reported them. */
export interface SubmittedTx {
  txHash: Hex
  /** When it was sent. */
  at: number
  from?: Hex
  nonce?: number
}

/** Past either bound the registration reads as escalated: the pending step leads with its retry. */
export const ESCALATION_MAX_RETRIES = 3
export const ESCALATION_MAX_AGE_MS = 48 * 60 * 60 * 1000

const TERMINAL_PHASES: ReadonlySet<PendingRegistrationPhase> = new Set([
  "confirmed",
  "failed_taken",
  "failed_terminal",
  "replaced",
])

export function isTerminalRegistrationPhase(phase: PendingRegistrationPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

/** Whether the registration is past either escalation bound. */
export function isRegistrationEscalated(
  record: Pick<PendingRegistrationRecord, "retries" | "startTime">,
  nowMs: number,
): boolean {
  return (
    record.retries >= ESCALATION_MAX_RETRIES || nowMs - record.startTime > ESCALATION_MAX_AGE_MS
  )
}

/** The badge state a record projects to; failure states persist until the user re-enters claiming. */
export function registrationUiState(
  record: PendingRegistrationRecord | null,
  nowMs: number,
): RegistrationUiState {
  if (!record) return "none"
  if (record.phase === "confirmed" || record.phase === "replaced") return "none"
  if (record.phase === "failed_taken" || record.phase === "failed_terminal") return "failed"
  if (isRegistrationEscalated(record, nowMs)) return "escalated"
  return "pending"
}

/** How the tag was got. `invite` and `past_user` confirm it on their own. */
export const REGISTRATION_ROUTES = ["random", "paid", "invite", "past_user", "ticket"] as const

export type RegistrationRoute = (typeof REGISTRATION_ROUTES)[number]

/** Whether the route settles the tag with no keep-or-choose step. */
export const routeConfirmsTag = (route: RegistrationRoute | undefined): boolean =>
  route !== undefined && route !== "random" && route !== "paid"

/**
 * What a NameClaim told the user about their reservation, and what the wallet decided on it since.
 * The claim itself is never kept: it is re-requestable.
 */
export interface RegistrationTerms {
  /** End of the reservation, unix seconds: the claim server's hold. Past it, the deposit needs a
   *  fresh quote. The NameClaim itself stays valid longer; the wallet holds the user to the hold. */
  deadline: number
  /** Signed-terms amounts (decimal wei); absent when the claim carried none and the contract's
   *  immutable schedule prices the floor. */
  fee?: string
  minDeposit?: string
  /** The signed schedule is the reduced one: the tag price is waived and `fee` is the relayer's
   *  sweep fee. Stored, not derived, so pre-terms records stay readable. Absent where no signed
   *  schedule has named a kind, which is not the same as one signed on the standard schedule. */
  feeWaived?: boolean
  /** A paylink's golden ticket bought this schedule; the link's claim funds the SIPA. */
  paylinkFunded?: boolean
  /** The link pays the signed deposit as quoted: no ticket priced it, so a renewal it covers keeps
   *  it bound. */
  paylinkDeposit?: boolean
  /** The link's note, base units, and its creator's tag: a review names them once the link reads
   *  as claimed and its note no longer can. */
  paylinkAmount?: string
  paylinkSender?: string
  /** That link, as `linkIdentity` names it: never the fragment, whose secret spends the link. Only
   *  a stashed marker for this link continues the signup, on Home or on the pending step. */
  paylinkId?: string
  /** The last re-sign quoted a schedule the link cannot pay. The link stays this registration's,
   *  and nothing claims it, until a re-sign quotes a ticket again or the registration is
   *  abandoned. */
  paylinkBlocked?: boolean
  /** The prover tip the link's burn carries, base units, as the review committed it. */
  proverTip?: string
  /** The speed the review committed; a later review starts from it. */
  speed?: "standard" | "faster"
  /** The withdrawal fee the split was priced with when the tip was committed, base units: the
   *  review of a claim at work or sent shows it. */
  withdrawalFee?: string
  /** Campaign expectation, distinct from the signer's authoritative waiver. Survives reopening. */
  earnedExpected?: boolean
}

/** A ticket signup: a link's ticket bought the terms, and the link's claim funds the address. */
export const isTicketSignup = (terms: RegistrationTerms | undefined): boolean =>
  terms?.paylinkFunded === true && !!terms.paylinkId

/** Refunds confirmed off the address. `amounts` sizes each, registration-token units. */
export interface RegistrationRefunds {
  txHashes: Hex[]
  amounts?: Record<string, string>
}

export const registrationId = (sipaAddress: string) => sipaAddress.toLowerCase()
