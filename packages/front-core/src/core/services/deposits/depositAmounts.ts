import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { parseEscrowAmount } from "../../../utils/escrowAmount"
import type { SIPADepositRecord } from "./SIPADepositStore"

/**
 * Gross / net / fee for a SIPA deposit, in exact base units plus 2dp-safe
 * display strings. The fee is everything the deposit does not credit; the
 * record's `fpcFundingCut` is the portal's part of it and is not summed again
 * here. Net is what credits the L2 balance (gross − fee); the entry screen
 * shows the send amount (gross) while the detail/list show net.
 *
 * Encoding is per-field: `amount` is a human-decimal string (parseUnits),
 * `netAmount`/`fee` are raw base-unit strings (BigInt). `amount` is gross until
 * a sweep is seen and net after, so gross comes from the authoritative
 * `netAmount + fee` once the sweep is known and from `amount` only before it.
 */
export interface DepositAmounts {
  grossAtomic: bigint
  netAtomic: bigint
  feeAtomic: bigint
  /** False for legacy/pre-sweep records with no persisted fee — hide the breakdown. */
  feeKnown: boolean
  grossDisplay: string
  netDisplay: string
  feeDisplay: string
}

type DepositAmountFields = Pick<SIPADepositRecord, "amount" | "netAmount" | "fee">

export function depositAmounts(record: DepositAmountFields): DepositAmounts {
  const feeKnown = record.fee != null
  const feeAtomic = feeKnown ? BigInt(record.fee as string) : 0n

  const grossAtomic =
    record.netAmount != null ? BigInt(record.netAmount) + feeAtomic : parseAmount(record.amount)

  const diff = grossAtomic - feeAtomic
  const netAtomic = record.netAmount != null ? BigInt(record.netAmount) : diff > 0n ? diff : 0n

  return {
    grossAtomic,
    netAtomic,
    feeAtomic,
    feeKnown,
    grossDisplay: formatUnits(grossAtomic, DEFAULT_DECIMALS),
    netDisplay: formatUnits(netAtomic, DEFAULT_DECIMALS),
    feeDisplay: formatUnits(feeAtomic, DEFAULT_DECIMALS),
  }
}

// A corrupt/legacy `amount` must not crash the feed or detail — mirror the
// existing degrade-to-zero posture in the activity transforms.
function parseAmount(amount: string): bigint {
  try {
    return parseEscrowAmount(amount, DEFAULT_DECIMALS).atomic
  } catch {
    return 0n
  }
}
