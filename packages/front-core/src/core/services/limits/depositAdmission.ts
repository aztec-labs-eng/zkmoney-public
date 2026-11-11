/**
 * Whether the portal may take a deposit, for every route that funds a deposit address. The sweep
 * credits what lands less the row's fee, in the row's settlement token, against `TX_AMOUNT_CAP`
 * and shared capacity; a route only sets what lands and what the user sends for it.
 */
import type { RequiredCredit } from "../../../oxide/portalCapacityEligibility"
import {
  checkProtocolCeiling,
  checkPublicLimit,
  publicLimitAtomic,
  type UsdValuation,
} from "./amountLimits"

/** The row the sweep deposits into, whichever route funds it. */
export interface DepositLanding {
  /** The coin that lands; `swapped` when the sweep converts it before the portal credits it. */
  token: { symbol: string; decimals: number; settlesIn: string; swapped: boolean }
  /** What the sweep keeps from what lands, base units of `token`. */
  depositFeeAtomic: bigint
  /** The row's `TX_AMOUNT_CAP()`, in settlement-token units; undefined until read. */
  txAmountCap?: bigint
  /** The least that may reach the private balance, base units of `token`. */
  minimumAtomic: bigint
}

/** What a route proposes: the most it lands, and what the user sends for it. */
export interface DepositAsk {
  /** Base units of the landing token. */
  landedAtomic: bigint
  /** What leaves the user's wallet, fees included, in the coin sent: the published limit counts it. */
  gross: { atomic: bigint; decimals: number; valuation?: UsdValuation }
}

export type DepositProblem = "minimum" | "public" | "protocol" | "valuation"

declare const admitted: unique symbol

/** The portal's answer for one ask. Only `admitDeposit` makes one. */
export interface DepositAdmission {
  /** What the portal credits; undefined when the sweep swaps first. */
  creditAtomic?: bigint
  /** The capacity meter's input. */
  required: RequiredCredit
  problem?: DepositProblem
  /** The most that may land within the published limit and the cap; undefined without a valuation. */
  maxLandedAtomic?: bigint
  readonly [admitted]: true
}

export function admitDeposit(landing: DepositLanding, ask: DepositAsk): DepositAdmission {
  const { token, depositFeeAtomic: fee, txAmountCap, minimumAtomic } = landing
  const { landedAtomic: landed, gross } = ask
  const receive = landed > fee ? landed - fee : 0n
  const creditAtomic = token.swapped ? undefined : receive
  const required: RequiredCredit =
    creditAtomic === undefined
      ? { status: "unknown" }
      : { status: "known", atomic: creditAtomic, token: token.settlesIn, decimals: token.decimals }
  const publicLimit = checkPublicLimit(gross.atomic, gross.decimals, gross.valuation)
  const problem =
    publicLimit === "valuation-unavailable"
      ? "valuation"
      : publicLimit === "over"
      ? "public"
      : checkProtocolCeiling(creditAtomic, txAmountCap) === "over"
      ? "protocol"
      : receive < minimumAtomic
      ? "minimum"
      : undefined
  // The published limit in landing units, at this ask's own ratio of what lands to what is sent.
  const limit = publicLimitAtomic(gross.decimals, gross.valuation)
  const byPublic =
    limit === undefined
      ? undefined
      : gross.atomic === landed
      ? limit
      : gross.atomic > 0n
      ? (limit * landed) / gross.atomic
      : undefined
  const byCap =
    creditAtomic !== undefined && txAmountCap !== undefined ? txAmountCap + fee : undefined
  const maxLandedAtomic =
    byPublic !== undefined && byCap !== undefined && byCap < byPublic ? byCap : byPublic
  return {
    ...(creditAtomic !== undefined && { creditAtomic }),
    required,
    ...(problem && { problem }),
    ...(maxLandedAtomic !== undefined && { maxLandedAtomic }),
  } as DepositAdmission
}
