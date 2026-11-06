import { useEffect } from "react"
import type { Address } from "viem"
import { memoryStore, useStore, type SipaDeposit } from "@obsidion/front-core"
import { useSession } from "../../session/session"

const NEVER_READ = memoryStore<number | undefined>(undefined).readonly

/** What the address holds, in fee-token units, and the token holding it once there is one. */
export interface DepositWatch {
  balance: bigint
  token?: Address
  /** The address's rail record, once it has one. */
  record?: SipaDeposit
  /** When the rail last read the address, unix ms. */
  readAt?: number
  /** Reads L1 now, ahead of the cadence. Settles once the pass lands or fails. */
  read: () => Promise<void>
}

/** The address's rail record as it changes, without speeding the rail up. */
export function useSipaRecord(address: string | null): SipaDeposit | undefined {
  const key = address?.toLowerCase()
  return useStore(useSession().sipaDeposits.view, ({ records }) =>
    key ? records.find((r) => r.sipaAddress.toLowerCase() === key) : undefined,
  )
}

/**
 * The deposit address's balance as its rail record holds it. While watched, `sipaCheck` reads L1
 * every few seconds, so the screen says "received" within a few seconds of the block.
 */
export function useDepositWatch(address: Address | null): DepositWatch {
  const record = useSipaRecord(address)
  const { sipaPipeline, tasks, wake } = useSession()
  const passAt = useStore(sipaPipeline?.observedAt ?? NEVER_READ)
  const read = tasks.sipaCheck
  useEffect(
    () => (address && sipaPipeline ? sipaPipeline.watch() : undefined),
    [address, sipaPipeline],
  )
  const balance = BigInt(record?.heldBalance ?? 0)
  return {
    balance,
    token: balance > 0n ? (record?.tokenAddress as Address | undefined) : undefined,
    record,
    // A record the rail has not read yet has no time to show.
    readAt: record?.observedFrom ? passAt : undefined,
    read: () => (read ? wake(read) : Promise.resolve()),
  }
}
