import { useEffect, useState } from "react"
import type { Address } from "viem"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import { readFundingTransfers } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"

export interface RegistrationFunding {
  from: Address
  txHash: string
  /** Total funded across every transfer in, base units. `from`/`txHash` pin the first (the funder). */
  amount: bigint
}

/**
 * Who funded the SIPA, with which tx and how much, read from the token's Transfer logs: the record
 * only stamps the hash, and only once a tick has seen the deposit. `amount` sums every transfer in
 * so a topped-up deposit reports its full gross, matching the registration machine's own funding
 * sum; `from`/`txHash` name the first (originating) transfer.
 *
 * Undefined while the read is out or has failed, so a gross priced off it waits rather than
 * reading as nothing funded; null once the read lands on an address nothing has reached.
 * `refreshKey` is the caller's way back to a read that failed: bump it and the read runs again.
 */
export function useFundingTransfer(record: PendingRegistrationRecord | null, refreshKey = 0) {
  // The answer is held with the address it was read for, so a record swap reads afresh.
  const [read, setRead] = useState<{ sipa: string; funding: RegistrationFunding | null }>()
  const token = record?.depositToken
  const sipa = record?.sipaAddress
  const funding = read !== undefined && read.sipa === sipa ? read.funding : undefined
  useEffect(() => {
    // An answer already read is not read again on a retry bump; null is an answer too.
    if (!token || !sipa || funding !== undefined) return
    let live = true
    readFundingTransfers(l1PublicClient(getConfig()), token as Address, sipa as Address)
      .then((transfers) => {
        if (!live) return
        const first = transfers[0]
        const total = transfers.reduce((sum, t) => sum + t.amount, 0n)
        setRead({
          sipa,
          funding: first ? { from: first.from, txHash: first.txHash, amount: total } : null,
        })
      })
      .catch((err) => console.warn("funding transfer read failed", err))
    return () => {
      live = false
    }
  }, [token, sipa, refreshKey, funding])
  return funding
}
