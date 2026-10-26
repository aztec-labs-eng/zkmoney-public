import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { Address } from "viem"
import { SIPADepositStore, useCachedRecords } from "@obsidion/front-core"
import type { SIPADepositRecord } from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { lastPassAt, observeNow, subscribePasses, watchDeposits } from "../deposit/depositPasses"

/** What the address holds, in fee-token units, and the token holding it once there is one. */
export interface DepositWatch {
  balance: bigint
  token?: Address
  /** The address's rail record, once it has one. */
  record?: SIPADepositRecord
  /** When the rail last read the address, unix ms. */
  readAt?: number
  /** Observes now, ahead of the cadence. Settles once the pass lands or fails. */
  read: () => Promise<void>
}

/** The address's rail record as it changes, without speeding the rail up. */
export function useSipaRecord(address: string | null): SIPADepositRecord | undefined {
  const store = useMemo(() => SIPADepositStore.get(webStorage), [])
  const { records } = useCachedRecords(store)
  const key = address?.toLowerCase()
  return key ? records.find((r) => r.sipaAddress.toLowerCase() === key) : undefined
}

/**
 * The deposit address's balance as its rail record holds it. While watched, the deposit loop
 * observes L1 on the watch cadence, so the screen says "received" within a few seconds of the block.
 */
export function useDepositWatch(address: Address | null): DepositWatch {
  const record = useSipaRecord(address)
  const passAt = useSyncExternalStore(subscribePasses, lastPassAt)
  useEffect(() => (address ? watchDeposits() : undefined), [address])
  const balance = BigInt(record?.heldBalance ?? 0)
  return {
    balance,
    token: balance > 0n ? (record?.tokenAddress as Address | undefined) : undefined,
    record,
    // A record the rail has not read yet has no time to show.
    readAt: record?.observedFrom ? passAt : undefined,
    read: observeNow,
  }
}
