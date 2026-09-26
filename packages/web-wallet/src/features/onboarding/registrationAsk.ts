/**
 * The two prices of one registration. The ask is the deposit the wallets present: a build-time
 * figure, there before any read. The schedule is what the chain enforces, and
 * `registrationFloor` in `@obsidion/core/constants` is the rule that turns it into the least
 * deposit the chain takes.
 *
 * A schedule reaching these functions is either the figures or undefined: none signed, or the read
 * still out. `useRegistrationSchedule` adds a third state, null, for a deployment that prices no
 * registration at all. `registrationScheduleForSipa` answers the SIPA deposit lane with its own
 * states, named on `RegistrationScheduleAnswer`.
 *
 * A leaf: no React, no viem, no sdk, so the quote rules are reachable from anywhere that prices a
 * registration without dragging a wallet runtime in behind them.
 */
import { REGISTRATION_ASK_DEPOSIT_TOTAL, registrationFloor } from "@obsidion/core/constants"
import type { RegistrationKind, RegistrationSchedule } from "@obsidion/core/types"

/** The shape both a fresh NameClaim and the stored terms share: the signed schedule, or nothing. */
type ClaimTerms = { fee?: string; minDeposit?: string } | null | undefined

/**
 * A signed quote that prices the tag at nothing. That is a claim server running without a
 * schedule configured, not a free registration, so neither its amounts nor its waiver are usable.
 */
export function termsUnpriced(terms: ClaimTerms): boolean {
  if (terms?.fee === undefined || terms.minDeposit === undefined) return false
  return BigInt(terms.fee) === 0n && BigInt(terms.minDeposit) === 0n
}

/**
 * What the claim committed to, when it committed to anything usable. Signed amounts outrank the
 * deployment's own schedule, so an unpriced quote has to fall through rather than win at zero.
 */
export function signedSchedule(terms: ClaimTerms): RegistrationSchedule | undefined {
  if (terms?.fee === undefined || terms.minDeposit === undefined) return undefined
  if (termsUnpriced(terms)) return undefined
  return { min: BigInt(terms.minDeposit), fee: BigInt(terms.fee) }
}

/**
 * The schedule that prices one registration: the signed one, else the deployment's, and only while
 * it names the fee the address commits to. A schedule priced otherwise cannot register that
 * address, so it prices nothing here and the surface falls back to the committed fee alone.
 */
export function scheduleForRecord(
  terms: ClaimTerms,
  chainAmounts: RegistrationSchedule | undefined,
  committedFee: bigint | undefined,
): RegistrationSchedule | undefined {
  const names = (schedule: RegistrationSchedule | undefined) =>
    schedule !== undefined && (committedFee === undefined || schedule.fee === committedFee)
      ? schedule
      : undefined
  return names(signedSchedule(terms)) ?? names(chainAmounts)
}

/**
 * The deployment's immutable schedule prices a registration only here: the account service signed
 * a claim for it (its deadline is on the record) and that claim carried no usable schedule. With
 * no claim, and after a sign that failed, the registration has no price to show at all.
 */
export function signedWithoutSchedule(
  terms: { deadline?: number; fee?: string; minDeposit?: string } | null | undefined,
): boolean {
  if (!terms?.deadline) return false
  return signedSchedule(terms) === undefined
}

function bigintEnv(raw: string | undefined, fallback: bigint): bigint {
  if (!raw) return fallback
  try {
    return BigInt(raw)
  } catch {
    return fallback
  }
}

/** A kind no branch here prices. Unreachable while every switch below stays exhaustive. */
function unpricedKind(kind: never): never {
  throw new Error(`no registration ask is defined for kind ${String(kind)}`)
}

/** Name of the env var that overrides one kind's asked total, for the misconfiguration report. */
function askOverrideName(kind: RegistrationKind): string {
  switch (kind) {
    case "earned_tag":
      return "VITE_REGISTRATION_EARNED_ASK_DEPOSIT_TOTAL"
    case "standard":
      return "VITE_REGISTRATION_ASK_DEPOSIT_TOTAL"
    default:
      return unpricedKind(kind)
  }
}

// Read as literals: Vite substitutes `import.meta.env.X` at build time, and a computed key is not
// substituted at all.
function askOverride(kind: RegistrationKind): string | undefined {
  switch (kind) {
    case "earned_tag":
      return import.meta.env.VITE_REGISTRATION_EARNED_ASK_DEPOSIT_TOTAL
    case "standard":
      return import.meta.env.VITE_REGISTRATION_ASK_DEPOSIT_TOTAL
    default:
      return unpricedKind(kind)
  }
}

/**
 * What a registration of `kind` is asked to deposit here, in base units:
 * `VITE_REGISTRATION_ASK_DEPOSIT_TOTAL` / `VITE_REGISTRATION_EARNED_ASK_DEPOSIT_TOTAL` else the
 * core constant. A build-time figure, so every prompt has it before any read lands.
 */
export function askedTotal(kind: RegistrationKind): bigint {
  return bigintEnv(askOverride(kind), REGISTRATION_ASK_DEPOSIT_TOTAL[kind])
}

/**
 * The one place the earned schedule's two other names become the kind: `reduced` on the claim
 * server's wire terms, `feeWaived` on the stored record.
 */
export function registrationKind(earned: boolean | undefined): RegistrationKind {
  return earned === true ? "earned_tag" : "standard"
}

/**
 * A signed schedule whose floor outgrew what its kind is asked to deposit. Nothing here can quote
 * it: the prompt would name a figure the registry refuses. Undefined until the cut lands, since
 * the floor is priced against it.
 */
export function floorExceedsAsk(
  schedule: RegistrationSchedule,
  kind: RegistrationKind,
  fpcFundingCut: bigint | undefined,
): boolean | undefined {
  if (fpcFundingCut === undefined) return undefined
  return registrationFloor(schedule, fpcFundingCut) > askedTotal(kind)
}

/**
 * The kind one registration is quoted as, decided once for every surface that prices it. A waived
 * tag whose floor outgrew the earned ask is quoted on the standard schedule, since the registry
 * would refuse the earned one. With no schedule at all the hint stands, since the ask needs none.
 * Undefined while a signed waiver's floor cannot be priced against the cut: the kind decides the
 * figure asked for, and naming the wrong one sends the wrong deposit.
 */
export function quotedRegistrationKind(
  feeWaived: boolean | undefined,
  schedule: RegistrationSchedule | undefined,
  fpcFundingCut: bigint | undefined,
): RegistrationKind | undefined {
  if (feeWaived !== true) return "standard"
  if (schedule === undefined) return "earned_tag"
  const exceeds = floorExceedsAsk(schedule, "earned_tag", fpcFundingCut)
  if (exceeds === undefined) return undefined
  return exceeds ? "standard" : "earned_tag"
}

/** The figures a registration prompt needs, priced apart. */
export interface RegistrationQuote {
  /** The deposit to ask for. Always known. */
  total: bigint
  /** The tag price the deposit covers, or for a waived tag the relayer's cut. Needs a schedule. */
  fee?: bigint
  /** The least the chain accepts. Needs both the schedule and the portal's funding cut. */
  floor?: bigint
}

const reportedQuotes = new Set<string>()

/** A deployment misconfiguration says itself once; a render path must not repeat it per frame. */
function reportOnce(message: string): void {
  if (reportedQuotes.has(message)) return
  reportedQuotes.add(message)
  console.error(message)
}

/**
 * What to show for one registration of `kind`: the total its kind is asked for, and the schedule's
 * own figures once they are known. Anything the total carries above `fee` plus the portal's funding
 * cut lands in the opening balance.
 *
 * A deployment whose floor outgrew the asked total is a configuration error. Renders call this, so
 * it reports rather than throws, and quotes the floor rather than a figure the registry refuses.
 */
export function registrationQuote(
  schedule: RegistrationSchedule | undefined,
  kind: RegistrationKind = "standard",
  fpcFundingCut?: bigint,
): RegistrationQuote {
  const total = askedTotal(kind)
  if (schedule === undefined) return { total }
  if (fpcFundingCut === undefined) return { total, fee: schedule.fee }
  const floor = registrationFloor(schedule, fpcFundingCut)
  if (floor > total) {
    const envName = askOverrideName(kind)
    reportOnce(
      `the ${kind} registration deposit this build asks for (${total}) does not cover this ` +
        `deployment's floor (${floor}); raise ${envName}`,
    )
    return { total: floor, fee: schedule.fee, floor }
  }
  return { total, fee: schedule.fee, floor }
}

/**
 * What funds one registration. An external deposit at its kind's ask, or the paylink whose golden
 * ticket bought it. Read before any price is quoted: a ticket has a burn, not an ask, and a reduced
 * flag alone cannot tell the two apart.
 */
export type RegistrationOffer =
  | { kind: RegistrationKind; funding: "external_deposit" }
  | {
      kind: "golden_ticket"
      funding: "paylink"
      /** The link, secret-free, as `linkIdentity` names it. */
      paylinkId: string
      /** The last re-sign quoted terms the link cannot pay; nothing claims it until renewed. */
      blocked: boolean
    }

/** The stored terms' funding. The ticket binding outranks the reduced flag. */
export function registrationOffer(
  terms:
    | {
        fee?: string
        minDeposit?: string
        feeWaived?: boolean
        paylinkFunded?: boolean
        paylinkId?: string
        paylinkBlocked?: boolean
      }
    | null
    | undefined,
): RegistrationOffer {
  if (terms?.paylinkFunded === true && terms.paylinkId) {
    return {
      kind: "golden_ticket",
      funding: "paylink",
      paylinkId: terms.paylinkId,
      blocked: terms.paylinkBlocked === true,
    }
  }
  const waived = !termsUnpriced(terms) && terms?.feeWaived === true
  return { kind: registrationKind(waived), funding: "external_deposit" }
}

/**
 * Wire terms a paylink can pay for: the signer marked them a ticket and they price a sweep. A zero
 * fee never sweeps, and a reduced flag alone is an earned tag, not a ticket.
 */
export function wireTermsFundTicket(
  terms:
    | { fee?: string; minDeposit?: string; reduced?: boolean; ticket?: boolean }
    | null
    | undefined,
): boolean {
  if (terms?.ticket !== true || terms.fee === undefined) return false
  return !termsUnpriced(terms) && BigInt(terms.fee) > 0n
}

/**
 * What a ticket's signed fee charges for the tag itself: the part above the live sweep fee.
 * Waived means exactly the sweep fee. Undefined until that fee is read, so an unread figure is
 * never shown as free.
 */
export function ticketTagCharge(
  schedule: RegistrationSchedule,
  sweepFee: bigint | undefined,
): bigint | undefined {
  if (sweepFee === undefined) return undefined
  return schedule.fee > sweepFee ? schedule.fee - sweepFee : 0n
}
