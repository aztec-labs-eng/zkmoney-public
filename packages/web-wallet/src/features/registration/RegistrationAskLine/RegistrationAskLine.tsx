import type { Address } from "viem"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { isTicketSignup } from "@obsidion/front-core"
import { useOpenRegistration } from "../openRegistration"
import {
  quoteExpired,
  quotedRegistrationKind,
  registrationQuote,
  scheduleForRecord,
  signedWithoutSchedule,
  termsUnpriced,
  useRegistrationTerms,
} from "../registrationTerms"
import { useRegistrationPricing } from "../registrationPricing"
import { formatDepositDue, formatDepositSeen } from "../depositAmounts"
import { useDepositWatch } from "../../sipa/useDepositWatch"
import { useDepositShown } from "../admission"
import { useRegistrationPublishStalled } from "../webRegistration"
import { fmt } from "../../../lib/fmt"
import { useSession } from "../../../session/session"
import copy from "./RegistrationAskLine.copy"

export interface RegistrationAsk {
  /** The asked total, undefined while it is read. */
  total?: bigint
  /** The least the registration's sweep accepts, undefined while it is read. */
  floor?: bigint
  /** What the sweep takes before crediting: the registration fee. */
  spent?: bigint
  /** Already at the address. */
  seen: bigint
  /** What is left to send, once part of the total is at the address. */
  remaining?: bigint
}

/**
 * The open registration's ask, priced as the registration sheet prices it, and what its address
 * already holds. Null where the deposit surfaces send the user elsewhere.
 */
export function useRegistrationAsk(): RegistrationAsk | null {
  const record = useOpenRegistration()?.record ?? null
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const unsignedFallback = signedWithoutSchedule(terms)
  const feeWaived = !termsUnpriced(terms) && terms?.feeWaived === true
  const readSchedule = record !== null && unsignedFallback
  const chainAmounts = useRegistrationPricing(readSchedule, readSchedule).schedule
  const watch = useDepositWatch(record ? (record.sipaAddress as Address) : null)
  const stalled = useRegistrationPublishStalled(record)
  const recorded = useDepositShown(record)
  if (!record || stalled) return null
  if (quoteExpired(terms, Date.now()) || (unsignedFallback && chainAmounts === null)) return null
  // A link's claim funds a ticket signup: no deposit is asked of the user.
  if (isTicketSignup(terms ?? undefined)) return null
  const schedule = scheduleForRecord(
    terms,
    unsignedFallback ? chainAmounts ?? undefined : undefined,
    record.fee !== undefined ? BigInt(record.fee) : undefined,
  )
  const kind = quotedRegistrationKind(feeWaived, schedule)
  const quote = kind && registrationQuote(schedule, kind)
  const total = quote?.total
  const floor = quote?.floor
  const seen = watch.balance > recorded ? watch.balance : recorded
  const remaining = total !== undefined && seen > 0n && seen < total ? total - seen : undefined
  const feeOwed = record.fee !== undefined ? BigInt(record.fee) : schedule?.fee
  return { total, floor, spent: feeOwed, seen, remaining }
}

/** The registration's ask on the deposit screen, less what its address already holds. */
export function RegistrationAskLine() {
  const ask = useRegistrationAsk()
  const decimals = tokenDecimalsForNetwork(useSession().page.config.network)
  if (!ask) return null
  return (
    <p className="ww-deposit__ask" data-testid="deposit-registration-ask">
      {ask.total === undefined ? (
        copy.checking
      ) : ask.remaining !== undefined ? (
        <>
          {fmt(copy.partial.lead, {
            seen: formatDepositSeen(ask.seen, decimals),
            total: formatDepositDue(ask.total, decimals),
          })}
          <strong>{formatDepositDue(ask.remaining, decimals)}</strong>
          {copy.partial.tail}
        </>
      ) : (
        <>
          {copy.full.lead}
          <strong>{formatDepositDue(ask.total, decimals)}</strong>
          {copy.full.tail}
        </>
      )}
    </p>
  )
}
