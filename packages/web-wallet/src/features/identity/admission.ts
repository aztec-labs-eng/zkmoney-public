// Whether a registration's deposit buys entry to the wallet. A receipt pins the entry to the record
// it was read for, so a refund or a new registration does not inherit it.

import { registrationFloor } from "@obsidion/core/constants"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import type { Hex } from "viem"
import { useSyncExternalStore } from "react"
import { walletStorage } from "../../platform/storage/walletStorage"
import { askedTotal, signedSchedule } from "../onboarding/registrationAsk"
import { loadRegistrationTerms } from "../onboarding/registrationTerms"

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
 */
export function admissionFloor(record: Pick<PendingRegistrationRecord, "account" | "tag">): bigint {
  const ask = askedTotal("earned_tag")
  const signed = signedSchedule(loadRegistrationTerms(record.account, record.tag))
  // Without a usable signed schedule the ask stands.
  if (signed === undefined) return ask
  const floor = registrationFloor(signed)
  return floor < ask ? floor : ask
}

/** Records pending wallet access after an L1 read, without changing sweep readiness or pricing. */
export function recordDepositAdmission(record: DepositEntryRecord, observed: bigint): boolean {
  if (observed < admissionFloor(record)) return false
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
): PendingRegistrationRecord["refundedEntry"] {
  if (refund.amount < admissionFloor(record)) return undefined
  return {
    sipaAddress: record.sipaAddress,
    recoveryTxHash: refund.txHash,
    amount: refund.amount.toString(),
  }
}

/** The receipt vouches for funds at one address; a refund that emptied it takes the receipt with it. */
export function forgetDepositAdmission(record: PendingRegistrationRecord): void {
  if (!hasDepositAdmission(record)) return
  walletStorage.removeItem(DEPOSIT_ENTRY_KEY)
  window.dispatchEvent(new Event(DEPOSIT_ENTRY_CHANGED))
}

export function clearAdmission(): void {
  walletStorage.removeItem(DEPOSIT_ENTRY_KEY)
  window.dispatchEvent(new Event(DEPOSIT_ENTRY_CHANGED))
}
