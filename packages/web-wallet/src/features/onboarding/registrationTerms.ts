import { useEffect, useState, useSyncExternalStore } from "react"
import { parseAbi, zeroAddress, type Address, type PublicClient } from "viem"
import { Network } from "@obsidion/core/constants"
import { walletStorage } from "../../platform/storage/walletStorage"
import type { WebWalletConfig } from "../../config/env"
import { readDepositFee } from "@obsidion/sdk"
import { registrationSipaImplementation } from "@obsidion/front-core"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { fpcFundingCut } from "../fees/fpcFundingCut"
import type { NameClaimResponse, RegistrationSchedule } from "@obsidion/core/types"

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
  wireTermsFundTicket,
  type RegistrationOffer,
  type RegistrationQuote,
} from "./registrationAsk"
import { registrationOffer, wireTermsFundTicket } from "./registrationAsk"

/** Why a ticket signup cannot go on: its renewed quote is not one the link can pay. */
export const PAYLINK_TICKET_REFUSED_MESSAGE =
  "this payment's ticket did not waive the tag price, so the deposit is still the paid schedule"

/** A ticket signup that goes on without its ticket: the network paused them before it was redeemed. */
export const PAYLINK_TICKET_PAUSED_MESSAGE =
  "paylink tickets are paused right now, so the tag is at its usual price. Your payment is claimed once you enter the wallet."

/**
 * What a fresh NameClaim told the user about their reservation: the deadline and the signed
 * schedule. The claim itself is never persisted (it is re-requestable), but these facts drive copy
 * and the floor after a reload — the pending step's deadline, the deposit rows, the in-wallet
 * reminder — so they live under their own key, one per registration account.
 */
export interface RegistrationTerms {
  /** The registration's L1 account (the pending-record key). */
  account: string
  tag: string
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
  /** Campaign expectation, distinct from the signer's authoritative waiver. Survives reopening. */
  earnedExpected?: boolean
  /** The deposit seen at the SIPA, base units as a decimal string; the sweep empties the address
   *  so the feed keeps the number from here. */
  depositAmount?: string
}

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

/** Prefix of every per-registration terms key; the account and tag follow. */
const TERMS_KEY_PREFIX = "webwallet.registration.terms"
/** Terms written before the per-registration keys existed. Read as a fallback, migrated on write. */
const LEGACY_TERMS_KEY = "webwallet.registration.terms"
const listeners = new Set<() => void>()

/** One key per registration, so a second one on the same device cannot evict the first's schedule. */
function termsKey(account: string, tag: string): string {
  return `${TERMS_KEY_PREFIX}:${account.toLowerCase()}:${tag.toLowerCase()}`
}

function readTerms(key: string): RegistrationTerms | null {
  const raw = walletStorage.getItem(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as RegistrationTerms
  } catch {
    return null
  }
}

/** The legacy entry, while it names this registration. */
function legacyTerms(account: string, tag?: string): RegistrationTerms | null {
  const terms = readTerms(LEGACY_TERMS_KEY)
  if (!terms?.account || terms.account.toLowerCase() !== account.toLowerCase()) return null
  if (tag !== undefined && terms.tag?.toLowerCase() !== tag.toLowerCase()) return null
  return terms
}

/**
 * The ticket binding one write carries forward. A write that does not name the funding keeps
 * what the registration had; `paylinkFunded: false` is the one lifecycle transition that drops
 * it. `paylinkBlocked` is kept unless the write says true or false.
 */
function ticketBinding(
  previous: RegistrationTerms | null,
  terms: RegistrationTerms,
): Pick<
  RegistrationTerms,
  "paylinkFunded" | "paylinkId" | "paylinkBlocked" | "proverTip" | "speed"
> {
  if (terms.paylinkFunded === false) return {}
  const funded = terms.paylinkFunded === true || previous?.paylinkFunded === true
  if (!funded) return {}
  const blocked = terms.paylinkBlocked ?? previous?.paylinkBlocked
  const proverTip = terms.proverTip ?? previous?.proverTip
  const speed = terms.speed ?? previous?.speed
  return {
    paylinkFunded: true,
    paylinkId: terms.paylinkId ?? previous?.paylinkId,
    ...(blocked === true ? { paylinkBlocked: true } : {}),
    ...(proverTip !== undefined ? { proverTip } : {}),
    ...(speed !== undefined ? { speed } : {}),
  }
}

/** Readable at once; resolves once saved, for a caller that must not move on before then. */
export function saveRegistrationTerms(terms: RegistrationTerms): Promise<void> {
  const previous = loadRegistrationTerms(terms.account, terms.tag)
  const { paylinkFunded, paylinkId, paylinkBlocked, proverTip, speed, ...rest } = terms
  void paylinkFunded
  void paylinkId
  void paylinkBlocked
  void proverTip
  void speed
  const saved = walletStorage.batch(() => {
    walletStorage.setItem(
      termsKey(terms.account, terms.tag),
      JSON.stringify({
        ...rest,
        ...(previous?.earnedExpected || terms.earnedExpected ? { earnedExpected: true } : {}),
        ...ticketBinding(previous, terms),
      }),
    )
    if (legacyTerms(terms.account, terms.tag)) walletStorage.removeItem(LEGACY_TERMS_KEY)
  })
  saved.catch((e: unknown) => console.error("[registrationTerms] save failed:", e))
  listeners.forEach((fn) => fn())
  return saved
}

/**
 * The stored quote for one claim, identified by both halves of what it priced. The account alone
 * does not identify it: an OxideAccount is CREATE2-derived from the passkey, so every claim from
 * one device shares an account, and matching on that hands the previous tag's quote to the next
 * tag. A caller that cannot name both gets nothing.
 *
 * A caller naming only the account gets the first per-registration entry under it, else the
 * legacy one.
 */
export function loadRegistrationTerms(
  account: string | undefined,
  tag?: string,
): RegistrationTerms | null {
  if (account === undefined) return null
  if (tag !== undefined) {
    return readTerms(termsKey(account, tag)) ?? legacyTerms(account, tag)
  }
  const prefix = `${TERMS_KEY_PREFIX}:${account.toLowerCase()}:`
  for (const key of walletStorage.keys()) {
    if (key.startsWith(prefix)) return readTerms(key)
  }
  return legacyTerms(account)
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
  record: { account: string; tag: string; fee?: string },
  claim: Pick<NameClaimResponse, "hold" | "terms">,
): { ticketRefused: boolean } {
  const stored = loadRegistrationTerms(record.account, record.tag)
  const funded = registrationOffer(stored).funding === "paylink"
  const fundable = wireTermsFundTicket(claim.terms)
  if (record.fee !== undefined && claim.terms && BigInt(claim.terms.fee) !== BigInt(record.fee)) {
    // Terms priced for another fee cannot register this address, so the stored quote stands; a
    // link-funded registration is blocked on them all the same, since its link cannot pay them.
    if (funded && stored && !stored.paylinkBlocked) {
      saveRegistrationTerms({ ...stored, paylinkBlocked: true })
    }
    return { ticketRefused: funded }
  }
  saveRegistrationTerms({
    account: record.account,
    tag: record.tag,
    ...(claim.terms
      ? {}
      : { fee: stored?.fee, minDeposit: stored?.minDeposit, feeWaived: stored?.feeWaived }),
    ...claimTerms(claim),
    depositAmount: stored?.depositAmount,
    ...(funded && claim.terms ? { paylinkBlocked: !fundable } : {}),
  })
  return { ticketRefused: funded && claim.terms !== undefined && !fundable }
}

/** The prover tip a ticket registration's burn carries: the committed one, else none. */
export function committedProverTip(terms: RegistrationTerms | null | undefined): bigint {
  return terms?.proverTip === undefined ? 0n : BigInt(terms.proverTip)
}

/** Commits the speed and prover tip a review showed to the registration's stored terms. */
export function commitRegistrationProverTip(
  account: string,
  tag: string,
  tip: bigint,
  speed: "standard" | "faster",
): void {
  const terms = loadRegistrationTerms(account, tag)
  if (!terms || (terms.proverTip === tip.toString() && terms.speed === speed)) return
  void saveRegistrationTerms({ ...terms, proverTip: tip.toString(), speed })
}

/** Stamp the deposit the L1 watcher saw onto the account's terms (a missing terms record gets a bare one). */
export function recordRegistrationDeposit(account: string, tag: string, amount: bigint): void {
  const terms = loadRegistrationTerms(account, tag) ?? { account, tag, deadline: 0 }
  if (terms.depositAmount === amount.toString()) return
  saveRegistrationTerms({ ...terms, depositAmount: amount.toString() })
}

/** Drops one registration's stored quote, the legacy entry it may still live under included. */
export function clearRegistrationTerms(account: string, tag: string): void {
  walletStorage.removeItem(termsKey(account, tag))
  if (legacyTerms(account, tag)) walletStorage.removeItem(LEGACY_TERMS_KEY)
  listeners.forEach((fn) => fn())
}

const subscribeTerms = (onChange: () => void) => {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function useRegistrationTerms(
  account: string | undefined,
  tag?: string,
): RegistrationTerms | null {
  // Serialized so the snapshot is a primitive; the store hands out a fresh object per read.
  const raw = useSyncExternalStore(subscribeTerms, () =>
    JSON.stringify(loadRegistrationTerms(account, tag)),
  )
  return JSON.parse(raw) as RegistrationTerms | null
}

/**
 * The gross a registration deposit is credited against: the live balance while the address still
 * holds it, else the summed on-chain funding (all tranches), with the stamped terms amount only as
 * the pre-read fallback. A single funding tranche must never stand in for a topped-up total — the
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
  throw new Error(
    "the registration controller allowlists no fee beneficiary, so a registration cannot be priced",
  )
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

/** Waits between the three attempts a one-shot read makes before it waits for its next trigger. */
const READ_RETRY_MS = [500, 1_000]

async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (err) {
      if (attempt >= READ_RETRY_MS.length) throw err
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS[attempt]))
    }
  }
}

/** Retries a surface asks for while its reads stay unread. The count restarts each time they
 *  become unread again. */
export const CHAIN_READ_RETRIES = 5

/** Gap between those retries. Long enough that a struggling RPC is left alone between attempts. */
export const CHAIN_READ_RETRY_MS = 24_000

/**
 * A refresh key for the one-shot reads below. They make three attempts and then wait for a trigger;
 * a surface with no Check pill has none, so this supplies one: the key bumps on a slow cadence
 * while `pending` says something is still unread, and stops once nothing is. Each time `pending`
 * turns true again the budget starts over, so the bound is per spell of unread figures.
 */
export function useChainReadRetry(pending: boolean, retry: () => void): void {
  const [attempts, setAttempts] = useState(0)
  useEffect(() => {
    if (pending) setAttempts(0)
  }, [pending])
  useEffect(() => {
    if (!pending || attempts >= CHAIN_READ_RETRIES) return
    const timer = setTimeout(() => {
      setAttempts((n) => n + 1)
      retry()
    }, CHAIN_READ_RETRY_MS)
    return () => clearTimeout(timer)
  }, [pending, attempts, retry])
}

/**
 * The deployment's schedule, in three states: undefined while the read is outstanding or has
 * failed, so nothing prices a registration against a guess and the caller keeps retrying; null when
 * this deployment cannot take a registration by deposit at all, because it answers zero or because
 * its fee sits under `sweepFee` and no balance at the address would fund the sweep; else the
 * amounts. A zero-priced deployment is null without `sweepFee`; any other schedule stays undefined
 * until that cut lands. `refreshKey` is the caller's way back to a read that gave up: bump it and
 * the read runs again.
 */
export function useRegistrationSchedule(
  config: WebWalletConfig,
  enabled = true,
  refreshKey = 0,
  sweepFee?: bigint,
): RegistrationSchedule | null | undefined {
  const [schedule, setSchedule] = useState<RegistrationSchedule | null>()
  useEffect(() => {
    // An immutable already read is not read again on a retry bump; null is an answer too.
    if (!enabled || schedule !== undefined) return
    let live = true
    readWithRetry(() => readRegistrationSchedule(config))
      .then((read) => {
        if (live) setSchedule(read.min === 0n && read.fee === 0n ? null : read)
      })
      .catch((err) => console.warn("registration schedule read failed", err))
    return () => {
      live = false
    }
    // Keyed on the deployment, not the config object: callers may build it per render.
  }, [enabled, refreshKey, schedule, config.network, config.l1RpcUrl])
  if (schedule == null) return schedule
  if (sweepFee === undefined) return undefined
  return schedule.fee < sweepFee ? null : schedule
}

/** Sweep costs besides the registration fee. */
export interface SweepDeductions {
  /** `OxidePortal.FPC_FUNDING_CUT` taken off every credited deposit. */
  fpcCut: bigint
}

/** What a registration deposit is worth, once the figures that price it are known. */
export interface RegistrationDepositCredit {
  /** What the sweep leaves after the registration fee and the portal's cut. Set only for a deposit
   *  the chain would accept. */
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
  fpcCut: bigint | undefined
}): RegistrationDepositCredit {
  const { gross, floor, feeOwed, fpcCut } = input
  if (gross === undefined || floor === undefined || feeOwed === undefined || fpcCut === undefined)
    return { short: false }
  if (gross < floor) return { short: true }
  const spent = feeOwed + fpcCut
  return { credit: gross > spent ? gross - spent : 0n, short: false }
}

/**
 * The relayer's cut on a registration sweep, read off the RegistrationSIPA implementation this
 * generation blesses. It is paid out of the registration fee, which the controller refuses to sign
 * below it, so it is what a free tag still costs. Undefined until the read lands, so a failed read
 * never reads as a zero cut. `refreshKey` re-runs a read that gave up.
 */
export function useDepositSkim(
  config: WebWalletConfig,
  enabled = true,
  refreshKey = 0,
): bigint | undefined {
  const [skim, setSkim] = useState<bigint>()
  useEffect(() => {
    // An immutable already read is not read again on a retry bump.
    if (!enabled || skim !== undefined) return
    let live = true
    const publicClient = l1PublicClient(config)
    readWithRetry(async () => {
      const tuple = await getOxideTuple(config)
      const implementation = await registrationSipaImplementation(
        publicClient,
        requireTupleField(tuple, "sipaFactory") as Address,
        requireTupleField(tuple, "portal") as Address,
      )
      return readDepositFee(publicClient, implementation)
    })
      .then((fee) => {
        if (live) setSkim(fee)
      })
      .catch((err) => console.warn("deposit skim read failed", err))
    return () => {
      live = false
    }
  }, [enabled, refreshKey, skim, config.network, config.l1RpcUrl])
  return skim
}

/**
 * The portal's funding cut for this deployment, the deduction every registration floor is priced
 * against. Undefined until the read lands. The same cut yields the same object, so an effect that
 * depends on it does not re-run on a re-read. `refreshKey` re-runs a read that gave up.
 */
export function useSweepDeductions(
  config: WebWalletConfig,
  token: string | undefined,
  enabled = Boolean(token),
  refreshKey = 0,
): SweepDeductions | undefined {
  const [deductions, setDeductions] = useState<SweepDeductions>()
  useEffect(() => {
    // An immutable already read is not read again on a retry bump.
    if (!enabled || deductions !== undefined) return
    let live = true
    const publicClient = l1PublicClient(config)
    readWithRetry(async () => {
      const tuple = await getOxideTuple(config)
      return fpcFundingCut(publicClient, requireTupleField(tuple, "portal") as Address)
    })
      .then((fpcCut) => {
        if (live) setDeductions((prev) => (prev?.fpcCut === fpcCut ? prev : { fpcCut }))
      })
      .catch((err) => console.warn("portal funding cut read failed", err))
    return () => {
      live = false
    }
  }, [enabled, token, refreshKey, deductions, config.network, config.l1RpcUrl])
  return deductions
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
