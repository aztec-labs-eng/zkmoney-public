import { useEffect, useState } from "react"
import type { Address } from "viem"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import {
  feeScale,
  type PendingRegistrationRecord,
  type SipaFundingToken,
} from "@obsidion/front-core"
import { readFundingTransfers, type SipaFundingTransfer } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { sipaFundingTokens } from "../deposit/loadDepositFacts"

export interface RegistrationFunding {
  from: Address
  txHash: string
  /** The token the first transfer in carried; `from`/`txHash` pin that transfer (the funder). */
  token: SipaFundingToken
  /** Total funded in `token`, its base units. */
  amount: bigint
  /** Total funded across every accepted token, in fee-token units: what the credit maths price. */
  normalized: bigint
}

/**
 * Funding from every accepted token's Transfer logs, `tokens[0]` the fee token: the earliest
 * transfer names the funder and the token, each token's transfers are summed, and the sums are
 * scaled into fee-token units (mainnet stables swap ~1:1). Null when nothing has reached the address.
 */
export function registrationFunding(
  tokens: readonly SipaFundingToken[],
  perToken: readonly (readonly SipaFundingTransfer[])[],
): RegistrationFunding | null {
  let first: SipaFundingTransfer | undefined
  let at = 0
  for (let i = 0; i < perToken.length; i++) {
    const head = perToken[i][0]
    // List order breaks a tie on block number.
    if (head && (!first || head.blockNumber < first.blockNumber)) {
      first = head
      at = i
    }
  }
  if (!first) return null
  const totals = perToken.map((ts) => ts.reduce((sum, t) => sum + t.amount, 0n))
  return {
    from: first.from,
    txHash: first.txHash,
    token: tokens[at],
    amount: totals[at],
    normalized: totals.reduce((sum, total, i) => sum + total * feeScale(tokens[0], tokens[i]), 0n),
  }
}

/**
 * Who funded the SIPA, with which token and tx and how much, read from the accepted tokens'
 * Transfer logs: the record only stamps the hash, and only once a tick has seen the deposit.
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
    const config = getConfig()
    const tokens = sipaFundingTokens(config.network, {
      address: token as Address,
      symbol: WALLET_TOKEN_SYMBOL,
      decimals: tokenDecimalsForNetwork(config.network),
    })
    const client = l1PublicClient(config)
    Promise.all(tokens.map((t) => readFundingTransfers(client, t.address, sipa as Address)))
      .then((perToken) => {
        if (live) setRead({ sipa, funding: registrationFunding(tokens, perToken) })
      })
      .catch((err) => console.warn("funding transfer read failed", err))
    return () => {
      live = false
    }
  }, [token, sipa, refreshKey, funding])
  return funding
}
