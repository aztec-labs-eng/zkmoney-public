import { useState, type ComponentProps } from "react"
import { formatUnits, type Address } from "viem"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import {
  currentRegistration,
  selectSipaDeposit,
  useStore,
  depositOwed,
  fundsIn,
  isUnfundedSipaDeposit,
  registrationAt,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import type { RegistrationDepositDetailModal } from "./RegistrationDepositDetailModal/RegistrationDepositDetailModal"
import { useFundingTransfer } from "../registration/registrationFunding"
import { useSession, type Session } from "../../session/session"
import { usdFigure } from "../../ui/format"
import { DETECTING_AMOUNT } from "../../ui/screens/activityView"
import { useDepositAdmission, useDepositShown } from "../registration/admission"
import {
  quotedRegistrationKind,
  registrationDepositCredit,
  registrationDepositGross,
  registrationQuote,
  scheduleForRecord,
  signedWithoutSchedule,
  useRegistrationTerms,
} from "../registration/registrationTerms"
import { useRegistrationPricing } from "../registration/registrationPricing"
import { formatTokenAmount } from "../deposit/DepositTermsRows/DepositTermsRows"
import { useDepositWatch } from "../sipa/useDepositWatch"
import { loadedRegistrations } from "../registration/webRegistration"
import { useRegistrationStage } from "../registration/openRegistration"

/** The feed's placeholder, re-exported: the registration surfaces speak the same words as the rail. */
export { DETECTING_AMOUNT }

/** What the feed's registration reads: the session's records and deposits. */
type FeedReads = Pick<Session, "registrations" | "sipaDeposits" | "identity">

const depositOf = (own: FeedReads, sipa: string) =>
  selectSipaDeposit(own.sipaDeposits.view.get(), sipa)

/**
 * The tag a SIPA deposit registered, when the address is one of this wallet's registration SIPAs —
 * the rail's own row and detail then keep the registration identity instead of morphing into an
 * anonymous deposit once they take over.
 */
export function registrationTagForSipa(own: FeedReads, sipaAddress: string): string | undefined {
  const pending = registrationAt(loadedRegistrations(own.registrations), sipaAddress)
  if (pending) return pending.tag
  // Discovered from the note on another device: no registration record, but the rail's record
  // carries the intent, and the name a registration SIPA registered is this wallet's own.
  const record = depositOf(own, sipaAddress)
  return record?.intent === "registration" ? own.identity.get().value?.handle : undefined
}

/** The tag a deposit row wears: none once the deposit went back and left the name unpaid. */
export function registrationTagForDeposit(own: FeedReads, sipaAddress: string): string | undefined {
  const pending = registrationAt(loadedRegistrations(own.registrations), sipaAddress)
  return pending && refundedAwaitingPayment(own, pending)
    ? undefined
    : registrationTagForSipa(own, sipaAddress)
}

/**
 * The deposit was recovered and the registration is waiting for payment again, so the feed shows
 * the returned funds and the registration as two rows.
 */
function refundedAwaitingPayment(own: FeedReads, record: PendingRegistrationRecord): boolean {
  const deposit = depositOf(own, record.sipaAddress)
  return (
    deposit?.phase === "recovered" &&
    record.phase === "awaiting_deposit" &&
    record.fundedAt === undefined
  )
}

/**
 * The active wallet's registration the feed should still speak for: the open one, else the latest
 * confirmed one — unless the SIPA rail has taken the deposit over (its record holds the funds; from
 * there the rail's own deposit row and detail show, as for any deposit, instead of a duplicate).
 * A registration whose deposit was recovered speaks again while it waits for payment.
 */
export function registrationForFeed(own: FeedReads): PendingRegistrationRecord | null {
  const identity = own.identity.get().value
  if (!identity) return null
  const mine = (r: PendingRegistrationRecord) =>
    r.l2Address.toLowerCase() === identity.address.toLowerCase()
  const records = loadedRegistrations(own.registrations)
  const speaking =
    currentRegistration(records, identity.address) ??
    [...records]
      .sort((a, b) => b.startTime - a.startTime)
      .find((r) => r.phase === "confirmed" && mine(r)) ??
    null
  if (!speaking) return null
  const deposit = depositOf(own, speaking.sipaAddress)
  return !deposit || isUnfundedSipaDeposit(deposit) || refundedAwaitingPayment(own, speaking)
    ? speaking
    : null
}

export interface RegistrationDepositEntry {
  ts: number
  /** The registration's address, so the feed can tell a burn from this wallet funded it. */
  sipaAddress: string
  tag: string
  /** The row's figure. */
  amount: string
  open(): void
  /** The detail the row opened, while it is open; hosted with the feed's other modals. */
  detail: ComponentProps<typeof RegistrationDepositDetailModal> | null
}

/**
 * The registration deposit as a pending row in the activity feed, read from the registration
 * record: once a deposit has been seen at the address, a "Registration deposit" row opens its
 * detail (pay QR + address inline while the address still needs funds), and stays after the name
 * confirms until the SIPA rail's own deposit row takes over.
 */
export function useRegistrationDepositEntry(): RegistrationDepositEntry | null {
  const session = useSession()
  const { config } = session.page
  useStore(session.registrations.view)
  useStore(session.sipaDeposits.view)
  useStore(session.identity)
  const record = registrationForFeed(session)
  const stage = useRegistrationStage(record)
  const depositAdmitted = useDepositAdmission(record)
  const shown = useDepositShown(record)
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const unsignedFallback = signedWithoutSchedule(terms)
  // The detail this row opens is priced off the same reads, so they are held here and handed down.
  const { sweepFee, schedule: chainAmounts } = useRegistrationPricing(
    record !== null,
    unsignedFallback,
  )
  // Before the sweep the address still holds the deposit; after it, the SIPA record or the funding
  // transfer do.
  const watch = useDepositWatch(
    record && stage != null && depositOwed(stage) ? (record.sipaAddress as never) : null,
  )
  const live = watch.balance
  const funding = useFundingTransfer(record)
  const [open, setOpen] = useState(false)
  // Unknown while the withdrawals load: the row waits.
  if (!record || stage == null) return null
  const gross = registrationDepositGross(
    live,
    funding === undefined ? undefined : funding?.normalized ?? 0n,
    shown,
  )
  const returned = refundedAwaitingPayment(session, record)
  const seen =
    returned || depositAdmitted || stage === "registered" || fundsIn(stage) || (gross ?? 0n) > 0n
  if (!seen) return null
  const decimals = tokenDecimalsForNetwork(config.network)
  const committedFee = record.fee !== undefined ? BigInt(record.fee) : undefined
  const amounts = unsignedFallback ? chainAmounts ?? undefined : undefined
  // A schedule prices this record only while it names the fee the address committed to. Committed
  // fee on the record wins; the schedule is only for pre-intent records. A waived tag still owes
  // that fee (the relayer's cut).
  const schedule = scheduleForRecord(terms, amounts, committedFee)
  // Nothing prices this record and no read is outstanding, so no placeholder will be replaced. The
  // row names what was deposited instead.
  const scheduleUnavailable =
    schedule === undefined && !(unsignedFallback && chainAmounts === undefined)
  const feeOwed = committedFee ?? schedule?.fee
  // The floor decides whether the deposit is taken; the asked total is what a row still waiting for
  // one quotes.
  const kind = quotedRegistrationKind(terms?.feeWaived, schedule)
  const quote = registrationQuote(schedule, kind)
  const { credit, short } = registrationDepositCredit({ gross, floor: quote.floor, feeOwed })
  // A short deposit credits nothing, so the row names what was deposited, unsigned, the way the
  // rail's own rows name a deposit no sweep will move. An unpriceable one names it the same way.
  const amountLabel = returned
    ? ""
    : credit !== undefined
    ? credit > 0n
      ? `+${usdFigure(formatUnits(credit, decimals))}`
      : ""
    : (short || scheduleUnavailable) && gross !== undefined && gross > 0n
    ? usdFigure(formatUnits(gross, decimals))
    : undefined
  const ts = record.fundedAt ?? record.startTime
  // Only a deposit the machine has not credited yet still needs the pay QR + address; once funded
  // the modal's facts take over.
  const pay =
    // A deployment that prices no registration a sweep could take has nothing to ask for.
    !(unsignedFallback && chainAmounts === null) && depositOwed(stage) && !depositAdmitted
      ? {
          token: record.depositToken as Address,
          chainId: record.l1ChainId,
          total: quote.total,
          tokenSymbol: WALLET_TOKEN_SYMBOL,
          kind,
          heldToken: live > 0n ? watch.token : undefined,
          terms:
            live > 0n
              ? undefined
              : {
                  total: quote.total,
                  fee: feeOwed,
                  sweepFee,
                  tokenSymbol: WALLET_TOKEN_SYMBOL,
                  tokenDecimals: decimals,
                  kind,
                  scheduleUnavailable,
                },
        }
      : undefined
  return {
    ts,
    sipaAddress: record.sipaAddress,
    tag: record.tag,
    amount: amountLabel ?? (scheduleUnavailable ? "" : DETECTING_AMOUNT),
    open: () => setOpen(true),
    detail: open
      ? {
          record,
          terms,
          funding,
          sweepFee,
          amount: amountLabel,
          deposited: funding
            ? formatTokenAmount(funding.amount, funding.token.decimals, funding.token.symbol)
            : gross !== undefined && gross > 0n
            ? formatTokenAmount(gross, decimals, WALLET_TOKEN_SYMBOL)
            : undefined,
          fee:
            feeOwed === undefined
              ? undefined
              : formatTokenAmount(feeOwed, decimals, WALLET_TOKEN_SYMBOL),
          feeWaived: terms?.feeWaived,
          pay,
          onClose: () => setOpen(false),
        }
      : null,
  }
}
