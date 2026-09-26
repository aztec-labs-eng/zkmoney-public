import { formatUnits, parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { WithdrawalRecord } from "./types"

/**
 * Gross / fee / net for an L2→L1 withdrawal, in exact base units plus display strings.
 *
 * Gross is what the burn removed from the L2 balance and what the row shows; net is what reaches
 * the recipient on L1. The fee is everything the recipient does not receive: the prover tip where
 * the burn offered one, the portal's funding cut, which it caps at what the prover tip leaves, and
 * the relayer tip the plain withdrawal executor pays out of the rest.
 *
 * Encoding is per-field: `amount` is a human-decimal string, `rawAmount`, `relayerTip`,
 * `proverTip` and `fpcFundingCut` are raw base-unit strings.
 */
export interface WithdrawalAmounts {
  grossAtomic: bigint
  /** Relayer tip, 0 where the record does not carry one. */
  tipAtomic: bigint
  /** Prover tip, 0 where the burn offered none. */
  proverTipAtomic: bigint
  /** The portal's funding cut as recorded, before the cap the portal applies. */
  cutAtomic: bigint
  /** Both tips plus the capped cut — the whole deduction. */
  feeAtomic: bigint
  netAtomic: bigint
  /** False on records written without a tip or a cut — hide the breakdown. */
  feeKnown: boolean
  grossDisplay: string
  feeDisplay: string
  netDisplay: string
}

type WithdrawalAmountFields = Pick<
  WithdrawalRecord,
  "amount" | "rawAmount" | "relayerTip" | "proverTip" | "fpcFundingCut"
>

export function withdrawalAmounts(record: WithdrawalAmountFields): WithdrawalAmounts {
  const feeKnown = record.relayerTip != null && record.fpcFundingCut != null
  const tipAtomic = feeKnown ? BigInt(record.relayerTip as string) : 0n
  const proverTipAtomic = feeKnown && record.proverTip != null ? BigInt(record.proverTip) : 0n
  const cutAtomic = feeKnown ? BigInt(record.fpcFundingCut as string) : 0n

  const grossAtomic =
    record.rawAmount != null ? BigInt(record.rawAmount) : parseAmount(record.amount)

  // The portal takes the prover tip, then its cut from what is left; the executor pays the relayer
  // tip out of the rest.
  const afterProverTip = grossAtomic - proverTipAtomic
  const room = afterProverTip > 0n ? afterProverTip : 0n
  const feeAtomic = proverTipAtomic + (cutAtomic < room ? cutAtomic : room) + tipAtomic
  const diff = grossAtomic - feeAtomic
  const netAtomic = diff > 0n ? diff : 0n

  return {
    grossAtomic,
    tipAtomic,
    proverTipAtomic,
    cutAtomic,
    feeAtomic,
    netAtomic,
    feeKnown,
    grossDisplay: formatUnits(grossAtomic, DEFAULT_DECIMALS),
    feeDisplay: formatUnits(feeAtomic, DEFAULT_DECIMALS),
    netDisplay: formatUnits(netAtomic, DEFAULT_DECIMALS),
  }
}

/** Swap-on-withdraw view of a record: the DAI deductions ahead of the swap, the escrow's swap
 *  input, and the submit-time output estimate where recorded. The direct deductions come through
 *  {@link withdrawalAmounts}, so the portal's cut stays capped at what the prover tip leaves. */
export interface SwapWithdrawalAmounts {
  grossAtomic: bigint
  /** All DAI deductions ahead of the swap. */
  feeAtomic: bigint
  /** False until every deduction is on the record — hide the fee/estimate breakdown before that. */
  feeKnown: boolean
  /** `gross - fee`, clamped at zero — the escrow's swap input. */
  swapInputAtomic: bigint
  grossDisplay: string
  feeDisplay: string
  /** Absent when the record carries no quote, the fee is unknown, or nothing is left to swap. */
  estimate?: {
    outAtomic: bigint
    outDecimals: number
    outDisplay: string
    /** Output units per 1 DAI: the quote over the swap input. */
    rate: number
  }
}

type SwapWithdrawalAmountFields = WithdrawalAmountFields &
  Pick<
    WithdrawalRecord,
    "swapOutput" | "swapRelayerTip" | "swapEstimatedOut" | "swapOutputDecimals"
  >

/** Undefined for a direct withdrawal — `withdrawalAmounts` is the whole story there. */
export function swapWithdrawalAmounts(
  record: SwapWithdrawalAmountFields,
): SwapWithdrawalAmounts | undefined {
  if (record.swapOutput == null) return undefined
  const { grossAtomic, feeAtomic: directFeeAtomic } = withdrawalAmounts(record)

  const feeAtomic =
    directFeeAtomic + (record.swapRelayerTip != null ? BigInt(record.swapRelayerTip) : 0n)
  const feeKnown = record.relayerTip != null && record.fpcFundingCut != null
  const diff = grossAtomic - feeAtomic
  const swapInputAtomic = diff > 0n ? diff : 0n

  let estimate: SwapWithdrawalAmounts["estimate"]
  if (
    feeKnown &&
    swapInputAtomic > 0n &&
    record.swapEstimatedOut != null &&
    record.swapOutputDecimals != null
  ) {
    const outAtomic = BigInt(record.swapEstimatedOut)
    const outDisplay = formatUnits(outAtomic, record.swapOutputDecimals)
    estimate = {
      outAtomic,
      outDecimals: record.swapOutputDecimals,
      outDisplay,
      rate: Number(outDisplay) / Number(formatUnits(swapInputAtomic, DEFAULT_DECIMALS)),
    }
  }

  return {
    grossAtomic,
    feeAtomic,
    feeKnown,
    swapInputAtomic,
    grossDisplay: formatUnits(grossAtomic, DEFAULT_DECIMALS),
    feeDisplay: formatUnits(feeAtomic, DEFAULT_DECIMALS),
    estimate,
  }
}

// A corrupt/legacy `amount` must not crash the detail sheet — mirror the degrade-to-zero posture
// of the deposit amounts helper.
function parseAmount(amount: string): bigint {
  try {
    return parseUnits(amount, DEFAULT_DECIMALS)
  } catch {
    return 0n
  }
}
