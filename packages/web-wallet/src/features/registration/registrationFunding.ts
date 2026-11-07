import { useEffect } from "react"
import type { Address } from "viem"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import {
  inRowUnits,
  resource,
  selectSipaDeposit,
  useResource,
  type PendingRegistrationRecord,
  type Resource,
  type SipaDeposits,
  type SipaFundingToken,
} from "@obsidion/front-core"
import { readFundingTransfers, type SipaFundingTransfer } from "@obsidion/sdk"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { useSession } from "../../session/session"
import { sipaFundingTokens } from "../sipa/loadDepositFacts"

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
    normalized: totals.reduce((sum, total, i) => sum + inRowUnits(total, tokens[i], tokens[0]), 0n),
  }
}

/** A failed read retries 24 s later, doubling to 5 minutes, until it lands. */
const FUNDING_BACKOFF = { baseMs: 24_000, maxMs: 300_000 }

type FundingRead = (token: Address, sipa: Address) => Promise<RegistrationFunding | null>

/**
 * The session's funding reads, one per registration address, each built on its first demand and
 * retried on `FUNDING_BACKOFF`. A rise in the address's held amount reads again: a top-up adds to
 * the total.
 */
export function fundingTransfers(read: FundingRead, deposits: Pick<SipaDeposits, "view">) {
  const reads = new Map<string, Resource<RegistrationFunding | null>>()
  const heldAt = (sipa: string) =>
    BigInt(selectSipaDeposit(deposits.view.get(), sipa)?.heldBalance ?? 0)
  return {
    of(record: Pick<PendingRegistrationRecord, "depositToken" | "sipaAddress">) {
      const sipa = record.sipaAddress.toLowerCase()
      let r = reads.get(sipa)
      if (r) return r
      r = resource(
        "fundingTransfer",
        {
          from: [],
          lazy: true,
          backoff: FUNDING_BACKOFF,
          changes(onChange) {
            let held = heldAt(sipa)
            return deposits.view.subscribe(() => {
              const now = heldAt(sipa)
              const rose = now > held
              held = now
              if (rose) onChange()
            })
          },
        },
        () => read(record.depositToken as Address, record.sipaAddress as Address),
      )
      reads.set(sipa, r)
      return r
    },
    close() {
      for (const r of reads.values()) r.close()
    },
  }
}

/** Reads the address's funding from every accepted token's Transfer logs. */
export const chainFunding =
  (config: () => WebWalletConfig): FundingRead =>
  async (token, sipa) => {
    const c = config()
    const client = l1PublicClient(c)
    const tokens = await sipaFundingTokens(
      c,
      { address: token, symbol: WALLET_TOKEN_SYMBOL, decimals: tokenDecimalsForNetwork(c.network) },
      "registration",
    )
    const perToken = await Promise.all(
      tokens.map((t) => readFundingTransfers(client, t.address, sipa)),
    )
    return registrationFunding(tokens, perToken)
  }

/**
 * Who funded the SIPA, with which token and tx and how much, read from the accepted tokens'
 * Transfer logs: the record only stamps the hash, and only once a tick has seen the deposit.
 *
 * Undefined while the read is out or has failed, so a gross priced off it waits rather than
 * reading as nothing funded; null once the read lands on an address nothing has reached.
 */
export function useFundingTransfer(record: PendingRegistrationRecord | null) {
  const { fundingTransfers } = useSession()
  const read = record ? fundingTransfers.of(record) : null
  useEffect(() => read?.demand(), [read])
  return useResource(read)
}
