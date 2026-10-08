/**
 * The wallet's read of where a registration stands: front-core's `registrationStage` over the
 * wallet's own stores. Surfaces that decide whether to ask for the deposit, show progress or step
 * aside read it here, and combine it with the facts a stage does not cover.
 */
import { useSyncExternalStore } from "react"
import type { Address } from "viem"
import {
  depositOwed,
  registrationStage,
  SIPADepositStore,
  WithdrawalStorage,
  type FundingBurn,
  type PendingRegistrationRecord,
  type RegistrationStage,
} from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { getPendingStore } from "./webRegistration"

export function readRegistrationStage(
  record: PendingRegistrationRecord,
  burns: readonly FundingBurn[] = WithdrawalStorage.get(webStorage).list(),
): RegistrationStage {
  return registrationStage(record, {
    deposit: SIPADepositStore.get(webStorage).get(record.sipaAddress as Address),
    burns,
  })
}

export interface OpenRegistration {
  record: PendingRegistrationRecord
  stage: RegistrationStage
}

/** The registration behind the tag the active wallet still presents as pending. */
export function openRegistration(): OpenRegistration | null {
  const identity = loadWalletIdentity()
  const record = getPendingStore().current()
  if (!identity?.pending || !record) return null
  if (record.l2Address.toLowerCase() !== identity.address.toLowerCase()) return null
  return { record, stage: readRegistrationStage(record) }
}

/** Every store a stage reads. */
export function subscribeRegistrationStage(onChange: () => void): () => void {
  const offs = [
    getPendingStore().onListChanged(onChange),
    SIPADepositStore.get(webStorage).onListChanged(onChange),
    WithdrawalStorage.get(webStorage).onListChanged(onChange),
  ]
  return () => offs.forEach((off) => off())
}

/**
 * A primitive snapshot of `openRegistration`: the store hands out fresh objects, which would never
 * settle. The record fields are the ones a surface reads beside the stage.
 */
function openRegistrationKey(): string | null {
  const open = openRegistration()
  if (!open) return null
  const { record, stage } = open
  return [stage, record.account, record.phase, record.broadcast, record.fundedAt, record.sweptAt]
    .map((v) => v ?? "")
    .join(":")
}

/** Whether the active wallet owes its registration deposit: the gate that sends an action to the
 *  activation prompt instead. */
export function useRegistrationDepositOwed(): boolean {
  return useSyncExternalStore(subscribeRegistrationStage, () => {
    const open = openRegistration()
    return open !== null && depositOwed(open.stage)
  })
}

/** `readRegistrationStage` for one record, kept current. Null without a record. */
export function useRegistrationStage(record: PendingRegistrationRecord): RegistrationStage
export function useRegistrationStage(
  record: PendingRegistrationRecord | null,
): RegistrationStage | null
export function useRegistrationStage(
  record: PendingRegistrationRecord | null,
): RegistrationStage | null {
  return useSyncExternalStore(subscribeRegistrationStage, () =>
    record ? readRegistrationStage(record) : null,
  )
}

/** `openRegistration`, kept current. */
export function useOpenRegistration(): OpenRegistration | null {
  const key = useSyncExternalStore(subscribeRegistrationStage, openRegistrationKey)
  return key === null ? null : openRegistration()
}
