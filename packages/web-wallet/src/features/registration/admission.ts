// Whether a registration's deposit buys entry to the wallet: what its address holds, or what a
// sweep took from it, against the admission floor. It follows the funds, so a refund that empties the
// address ends it, and a sign-out does not.

import { registrationFloor } from "@obsidion/core/constants"
import {
  selectSipaDeposit,
  useStore,
  type PendingRegistrationRecord,
  type RecordSet,
  type SIPASweep,
  type SipaDeposit,
  type SipaDeposits,
} from "@obsidion/front-core"
import { formatUnits, parseUnits, type Hex } from "viem"
import { useSession } from "../../session/session"
import { askedTotal, signedSchedule } from "./registrationAsk"

/**
 * What a deposit must reach to buy entry to the wallet: the lower of this registration's own
 * signed floor and what an earned tag is asked to deposit. A deposit the sweep would take admits,
 * and so does one at the figure the campaign asked for, whatever the signed schedule prices.
 */
export function admissionFloor(record: Pick<PendingRegistrationRecord, "terms">): bigint {
  const ask = askedTotal("earned_tag")
  const signed = signedSchedule(record.terms)
  // Without a usable signed schedule the ask stands.
  if (signed === undefined) return ask
  const floor = registrationFloor(signed)
  return floor < ask ? floor : ask
}

/** What a sweep took, in the units of the row it settled on, which `heldBalance` and the floor use. */
function sweptInRowUnits(sweep: SIPASweep): bigint {
  const { grossAmount, fundingTokenDecimals, tokenDecimals } = sweep
  if (
    grossAmount === undefined ||
    fundingTokenDecimals === undefined ||
    tokenDecimals === undefined
  )
    return BigInt(sweep.netAmount) + BigInt(sweep.fee ?? 0)
  return parseUnits(formatUnits(BigInt(grossAmount), fundingTokenDecimals), tokenDecimals)
}

/** The most the address showed: its held balance, or what one of its sweeps took. */
export function depositShown(deposit: SipaDeposit | undefined): bigint {
  if (!deposit) return 0n
  const amounts = [
    BigInt(deposit.heldBalance ?? 0),
    ...(deposit.sweeps ?? []).map(sweptInRowUnits),
    // A sweep seen and not yet claimed holds its credit and fee in the row's units already.
    ...(deposit.pendingSweeps ?? []).map((sweep) => BigInt(sweep.amount) + BigInt(sweep.fee ?? 0)),
  ]
  return amounts.reduce((max, amount) => (amount > max ? amount : max), 0n)
}

/** The registration is at the earned price: its quote expects it, or its tag was not bought. */
export function expectsEarned(record: Pick<PendingRegistrationRecord, "terms" | "route">): boolean {
  if (record.terms?.earnedExpected === true) return true
  return record.route !== undefined && record.route !== "paid"
}

/** Only a registration at the earned price is admitted at the earned ask. */
export function depositAdmitted(
  record: Pick<PendingRegistrationRecord, "terms" | "route">,
  deposit: SipaDeposit | undefined,
): boolean {
  return (
    deposit !== undefined &&
    expectsEarned(record) &&
    depositShown(deposit) >= admissionFloor(record)
  )
}

/** False until the session's deposits load, so a loaded view never takes an entry back. */
function admittedIn(
  view: RecordSet<SipaDeposit>,
  record: PendingRegistrationRecord | null,
): boolean {
  if (!record || !view.loaded) return false
  const key = record.sipaAddress.toLowerCase()
  return depositAdmitted(
    record,
    view.records.find((r) => r.sipaAddress.toLowerCase() === key),
  )
}

export const useDepositAdmission = (record: PendingRegistrationRecord | null): boolean =>
  useStore(useSession().sipaDeposits.view, (view) => admittedIn(view, record))

/** What the record's address showed, as the session's deposits hold it. */
export const useDepositShown = (record: Pick<PendingRegistrationRecord, "sipaAddress"> | null) =>
  useStore(useSession().sipaDeposits.view, (view) =>
    depositShown(record ? selectSipaDeposit(view, record.sipaAddress) : undefined),
  )

export const hasDepositAdmission = (
  deposits: Pick<SipaDeposits, "view">,
  record: PendingRegistrationRecord,
): boolean => admittedIn(deposits.view.get(), record)

/**
 * The entry a verified refund carries onto the replacement record, where it outlives sign-outs.
 * The refunded address can never show the deposit again, so the amount is checked here: a refund
 * short of the admission floor restarts the registration but buys no entry.
 */
export function refundedEntry(
  record: Pick<PendingRegistrationRecord, "terms" | "sipaAddress">,
  refund: { amount: bigint; txHash: Hex },
): PendingRegistrationRecord["refundedEntry"] {
  if (refund.amount < admissionFloor(record)) return undefined
  return {
    sipaAddress: record.sipaAddress,
    recoveryTxHash: refund.txHash,
    amount: refund.amount.toString(),
  }
}
