import { WalletError, bestEffort } from "@obsidion/core/errors"
import { parseAbi, zeroAddress, type Address, type PublicClient } from "viem"
import { Network } from "@obsidion/core/constants"
import type { WebWalletConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import type { NameClaimResponse, RegistrationSchedule } from "@obsidion/core/types"
import {
  latestRegistration,
  useStore,
  type PendingRegistrationRecord,
  type RegistrationStore,
  type RegistrationTerms,
} from "@obsidion/front-core"
import { useSession } from "../../session/session"
import errorWords from "../../errors/catalog.copy"

/** Where a record's terms change. */
type TermsWriter = Pick<RegistrationStore, "apply">

export {
  askedTotal,
  floorExceedsAsk,
  quotedRegistrationKind,
  registrationKind,
  registrationOffer,
  registrationQuote,
  scheduleForRecord,
  signedSchedule,
  signedWithoutSchedule,
  termsUnpriced,
  ticketTagCharge,
  wireTermsFundLink,
  wireTermsFundTicket,
  type RegistrationOffer,
  type RegistrationQuote,
} from "./registrationAsk"
import { registrationOffer, wireTermsFundLink, wireTermsFundTicket } from "./registrationAsk"

/** Why a ticket signup cannot go on: its renewed quote is not one the link can pay. */
export const PAYLINK_TICKET_REFUSED_MESSAGE = errorWords["registration.ticketRefused"]

/** A ticket signup that goes on without its ticket: the network paused them before it was redeemed. */
export const PAYLINK_TICKET_PAUSED_MESSAGE =
  "paylink tickets are paused right now, so the tag is at its usual price. Your payment is claimed once you enter the wallet."

/** What a NameClaim states about its registration: the reservation's end and, when signed, its schedule. */
export function claimTerms(
  claim: Pick<NameClaimResponse, "hold" | "terms">,
): Pick<RegistrationTerms, "deadline" | "fee" | "minDeposit" | "feeWaived"> {
  return {
    deadline: Number(claim.hold.deadline),
    ...(claim.terms
      ? {
          fee: claim.terms.fee,
          minDeposit: claim.terms.minDeposit,
          feeWaived: claim.terms.reduced,
        }
      : {}),
  }
}

/** The reservation ended, so the deposit needs a re-signed quote. A 0 deadline is unknown, never lapsed. */
export function quoteExpired(
  terms: Pick<RegistrationTerms, "deadline"> | null | undefined,
  nowMs: number,
): boolean {
  return !!terms && terms.deadline > 0 && nowMs > terms.deadline * 1000
}

/** When the reservation ends, unix ms; undefined when unknown or already over. */
export function reservedUntil(
  terms: Pick<RegistrationTerms, "deadline"> | null | undefined,
  nowMs: number,
): number | undefined {
  const endsMs = (terms?.deadline ?? 0) * 1000
  return endsMs > nowMs ? endsMs : undefined
}

/** The newest record of one claim, identified by both halves of what it priced. */
function claimRecord(
  records: readonly PendingRegistrationRecord[],
  account: string | undefined,
  tag?: string,
): PendingRegistrationRecord | null {
  if (account === undefined) return null
  const latest = latestRegistration(
    tag === undefined ? records : records.filter((r) => r.tag.toLowerCase() === tag.toLowerCase()),
    account,
  )
  return latest
}

/**
 * The stored quote for one claim. The account alone does not identify it: an OxideAccount is
 * CREATE2-derived from the passkey, so every claim from one device shares an account. A caller
 * naming only the account gets its newest record's.
 */
export function loadRegistrationTerms(
  registrations: Pick<RegistrationStore, "view">,
  account: string | undefined,
  tag?: string,
): RegistrationTerms | null {
  return claimRecord(registrations.view.get().records, account, tag)?.terms ?? null
}

/** Changes the record's terms; resolves once saved. */
export async function updateRegistrationTerms(
  registrations: TermsWriter,
  record: Pick<PendingRegistrationRecord, "sipaAddress">,
  terms: Partial<RegistrationTerms>,
): Promise<void> {
  await registrations.apply(record.sipaAddress, { type: "termsUpdated", terms })
}

/**
 * A re-issued claim's deadline and schedule replace the stored terms when it prices the fee the
 * record's address committed to. One priced otherwise cannot register that address, and is left for
 * the caller to refuse. A claim carrying no schedule is no evidence the signed one was wrong, so it
 * refreshes the deadline and leaves the schedule standing.
 *
 * A ticket-funded registration keeps its link either way. Renewed terms the link cannot pay, or
 * that price another fee, block it (`ticketRefused`); terms it can pay lift the block; terms that
 * carry no schedule leave it as it was.
 */
export function rememberReissuedClaim(
  registrations: TermsWriter,
  record: Pick<PendingRegistrationRecord, "sipaAddress" | "fee" | "terms">,
  claim: Pick<NameClaimResponse, "hold" | "terms">,
): { ticketRefused: boolean } {
  const stored = record.terms
  const funded = registrationOffer(stored).funding === "paylink"
  const fundable = stored?.paylinkDeposit
    ? wireTermsFundLink(claim.terms)
    : wireTermsFundTicket(claim.terms)
  if (claim.terms && BigInt(claim.terms.fee) !== BigInt(record.fee)) {
    // Terms priced for another fee cannot register this address, so the stored quote stands; a
    // link-funded registration is blocked on them all the same, since its link cannot pay them.
    if (funded && stored && !stored.paylinkBlocked)
      void bestEffort(
        "unknown",
        updateRegistrationTerms(registrations, record, { paylinkBlocked: true }),
      )
    return { ticketRefused: funded }
  }
  // A claim carrying no schedule refreshes the deadline and leaves the stored schedule standing.
  void bestEffort(
    "unknown",
    updateRegistrationTerms(registrations, record, {
      ...claimTerms(claim),
      ...(funded && claim.terms ? { paylinkBlocked: !fundable } : {}),
    }),
  )
  return { ticketRefused: funded && claim.terms !== undefined && !fundable }
}

/** The prover tip a ticket registration's burn carries: the committed one, else none. */
export function committedProverTip(terms: RegistrationTerms | null | undefined): bigint {
  return terms?.proverTip === undefined ? 0n : BigInt(terms.proverTip)
}

/** Commits the speed and prover tip a review showed to the registration's stored terms. */
export async function commitRegistrationProverTip(
  registrations: TermsWriter,
  record: Pick<PendingRegistrationRecord, "sipaAddress" | "terms">,
  tip: bigint,
  speed: "standard" | "faster",
): Promise<void> {
  const { terms } = record
  if (!terms || (terms.proverTip === tip.toString() && terms.speed === speed)) return
  await updateRegistrationTerms(registrations, record, { proverTip: tip.toString(), speed })
}

export function useRegistrationTerms(
  account: string | undefined,
  tag?: string,
): RegistrationTerms | null {
  return useStore(
    useSession().registrations.view,
    (view) => claimRecord(view.records, account, tag)?.terms ?? null,
  )
}

/**
 * The gross a registration deposit is credited against: the live balance while the address still
 * holds it, else the summed on-chain funding (all tranches), with what the SIPA record showed only
 * as the pre-read fallback. A single funding tranche must never stand in for a topped-up total — the
 * credit projection subtracts the fee from this, so a short gross would misreport the credit as the
 * first tranche instead of the whole deposit.
 *
 * Undefined while the funding read is out and nothing else names a figure: an unread total is not
 * a deposit of nothing.
 */
export function registrationDepositGross(
  live: bigint,
  fundedTotal: bigint | undefined,
  stamped: bigint,
): bigint | undefined {
  if (live > 0n) return live
  if (fundedTotal === undefined) return stamped > 0n ? stamped : undefined
  return fundedTotal > stamped ? fundedTotal : stamped
}

/** Where the deposit is sent, for copy: the L1 by name, or the sandbox's local chain. */
export function depositChainLabel(config: WebWalletConfig): string {
  return config.network === Network.SANDBOX ? "the sandbox L1" : config.l1Chain.name
}

const REGISTRY_PARAMS_ABI = parseAbi([
  "function REGISTRATION_MIN() view returns (uint256)",
  "function REGISTRATION_FEE() view returns (uint256)",
])

const REGISTRY_CONTROLLER_ABI = parseAbi([
  "function registrationController() view returns (address)",
])

/**
 * Where the schedule immutables live. The registry names its own controller, so it is the source
 * of truth — a manifest pin can be absent or stale, and staging proved both. A pre-split registry
 * does not answer the call and holds the immutables itself.
 */
export async function scheduleSource(
  config: WebWalletConfig,
  client: PublicClient,
): Promise<Address> {
  const registry = requireTupleField(await getOxideTuple(config), "registry") as Address
  try {
    const controller = await client.readContract({
      address: registry,
      abi: REGISTRY_CONTROLLER_ABI,
      functionName: "registrationController",
    })
    if (controller && controller !== zeroAddress) return controller
  } catch {
    // Pre-split registry: it holds the immutables itself.
  }
  return registry
}

const BENEFICIARY_ABI = parseAbi([
  "function beneficiaries(uint256) view returns (address)",
  "function nextBeneficiaryId() view returns (uint256)",
])

/**
 * The fee beneficiary a registration commits to, by address: the intent commits the funder itself
 * and the sweep pays exactly that funder. The configured id is per-deployment:
 * `RegistrationController` seeds only id 0 at construction and every later one needs an explicit
 * `addBeneficiary`, so a baked-in id can name an entry a given deployment never allowlisted — and
 * the sweep then reverts permanently, after the user has already deposited. Prefer the configured
 * id's address when the chain has it, else the newest allowlisted one; with none the registration
 * cannot be priced.
 */
export async function resolveBeneficiary(
  config: WebWalletConfig,
  preferred: number,
): Promise<Address> {
  const client = l1PublicClient(config)
  const source = await scheduleSource(config, client)
  const read = (fn: "beneficiaries" | "nextBeneficiaryId", args?: readonly [bigint]) =>
    client.readContract({
      address: source,
      abi: BENEFICIARY_ABI,
      functionName: fn,
      args: args as never,
    })
  const at = (await read("beneficiaries", [BigInt(preferred)])) as Address
  if (at && at !== zeroAddress) return at
  const next = (await read("nextBeneficiaryId")) as bigint
  if (next > 0n) {
    const newest = (await read("beneficiaries", [next - 1n])) as Address
    if (newest && newest !== zeroAddress) return newest
  }
  throw new WalletError("registration.noBeneficiary")
}

/** The deployment's on-chain default schedule, the amounts a terms-less deposit must cover. */
export async function readRegistrationSchedule(
  config: WebWalletConfig,
): Promise<RegistrationSchedule> {
  const client = l1PublicClient(config)
  const address = await scheduleSource(config, client)
  const [min, fee] = await Promise.all([
    client.readContract({ address, abi: REGISTRY_PARAMS_ABI, functionName: "REGISTRATION_MIN" }),
    client.readContract({ address, abi: REGISTRY_PARAMS_ABI, functionName: "REGISTRATION_FEE" }),
  ])
  return { min, fee }
}

/** What a registration deposit is worth, once the figures that price it are known. */
export interface RegistrationDepositCredit {
  /** What the sweep leaves after the registration fee. Set only for a deposit the chain would
   *  accept. */
  credit?: bigint
  /** True for a deposit under the floor: nothing is credited and the gross is all there is. False
   *  covers both a credited deposit and one nothing has priced yet, which `credit` tells apart. */
  short: boolean
}

/**
 * Projected L2 credit for a registration deposit. A short deposit names no credit but is a settled
 * verdict, which is what lets a row show the gross instead of waiting on a read. Neither figure is
 * decided while an input is unread.
 */
export function registrationDepositCredit(input: {
  gross?: bigint
  floor: bigint | undefined
  feeOwed: bigint | undefined
}): RegistrationDepositCredit {
  const { gross, floor, feeOwed } = input
  if (gross === undefined || floor === undefined || feeOwed === undefined) return { short: false }
  if (gross < floor) return { short: true }
  return { credit: gross > feeOwed ? gross - feeOwed : 0n, short: false }
}

/** "3 days", "5 hours", "40 minutes" left until `deadlineMs`, or "" once it has passed. */
export function formatRemaining(deadlineMs: number, nowMs: number): string {
  const left = deadlineMs - nowMs
  if (left <= 0) return ""
  const minutes = Math.ceil(left / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.round(left / 3_600_000)
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`
  const days = Math.round(left / 86_400_000)
  return `${days} day${days === 1 ? "" : "s"}`
}
