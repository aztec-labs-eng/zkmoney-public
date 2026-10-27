import { PUBLIC_TX_LIMIT_USD } from "@obsidion/core/constants"
import { AMOUNT_MAX_DECIMALS } from "../../../utils/validate"

/**
 * Per-operation amount limits. Two checks stay separate: the published USD limit on the gross
 * amount (product policy) and the portal's `TX_AMOUNT_CAP()` on settlement-token units, which the
 * caller reads off the portal and passes as `txAmountCap`, undefined until read. Neither depends on
 * shared deposit capacity.
 */

/** A token's USD price as an exact fraction per whole token, and where it came from. */
export interface UsdValuation {
  source: string
  usdPerToken: { numerator: bigint; denominator: bigint }
}

/**
 * Product policy values every token the deployment accepts as a deposit at a fixed $1 per token for the published
 * limit. It is a stated basis, not a market price, and says nothing about what a swap credits.
 */
export const NOMINAL_USD_VALUATION: UsdValuation = {
  source: "nominal-1-usd-per-token",
  usdPerToken: { numerator: 1n, denominator: 1n },
}

/**
 * The nominal rate for a token Main's rows of the pinned table accept as a deposit (`mainDepositTokenRoutes`), matched
 * by address.
 * Undefined for any other token.
 */
export function depositTokenValuation(input: {
  accepted: readonly string[]
  token: string
}): UsdValuation | undefined {
  const token = input.token.toLowerCase()
  return input.accepted.some((accepted) => accepted.toLowerCase() === token)
    ? NOMINAL_USD_VALUATION
    : undefined
}

/** `valuation-unavailable`: no USD price, so the published limit cannot be checked either way. */
export type PublicLimitCheck = "within" | "over" | "valuation-unavailable"

/** `credit-unknown`: the route swaps before crediting, so the credit is not known before sending. */
export type ProtocolCeilingCheck = "within" | "over" | "credit-unknown"

/** Rounds down to the smallest amount a user can type. */
export function floorToTypeable(atomic: bigint, decimals: number): bigint {
  if (decimals <= AMOUNT_MAX_DECIMALS) return atomic
  const step = 10n ** BigInt(decimals - AMOUNT_MAX_DECIMALS)
  return atomic - (atomic % step)
}

function validValuation(valuation: UsdValuation | undefined): valuation is UsdValuation {
  return (
    !!valuation && valuation.usdPerToken.numerator > 0n && valuation.usdPerToken.denominator > 0n
  )
}

/** The largest typeable token amount worth at most the published limit. */
export function publicLimitAtomic(
  decimals: number,
  valuation: UsdValuation | undefined,
): bigint | undefined {
  if (!validValuation(valuation)) return undefined
  const { numerator, denominator } = valuation.usdPerToken
  const limit = (BigInt(PUBLIC_TX_LIMIT_USD) * denominator * 10n ** BigInt(decimals)) / numerator
  return floorToTypeable(limit, decimals)
}

/** Exact, so a price that does not divide evenly still passes an amount worth exactly the limit. */
export function checkPublicLimit(
  grossAtomic: bigint,
  decimals: number,
  valuation: UsdValuation | undefined,
): PublicLimitCheck {
  if (!validValuation(valuation)) return "valuation-unavailable"
  const { numerator, denominator } = valuation.usdPerToken
  const worth = grossAtomic * numerator
  const limit = BigInt(PUBLIC_TX_LIMIT_USD) * denominator * 10n ** BigInt(decimals)
  return worth > limit ? "over" : "within"
}

/**
 * `creditAtomic` is in settlement-token base units, the units `txAmountCap` counts. Either one
 * unknown leaves the check undecided.
 */
export function checkProtocolCeiling(
  creditAtomic: bigint | undefined,
  txAmountCap: bigint | undefined,
): ProtocolCeilingCheck {
  if (creditAtomic === undefined || txAmountCap === undefined) return "credit-unknown"
  return creditAtomic > txAmountCap ? "over" : "within"
}

export interface DepositLimits {
  /** What the wallet sends: the amount to receive plus the fee. */
  sendAtomic: bigint
  publicLimit: PublicLimitCheck
  protocolCeiling: ProtocolCeilingCheck
  /** Largest amount to receive that passes both checks; undefined without a valuation. */
  maxReceiveAtomic?: bigint
}

/**
 * A deposit typed as the amount to receive. The published limit counts the gross send in the sent
 * token; the protocol ceiling counts the net settlement credit, known only on the settlement-token
 * route, where it equals the amount to receive.
 */
export function depositLimits(input: {
  receiveAtomic: bigint
  feeAtomic: bigint
  decimals: number
  valuation: UsdValuation | undefined
  settlementCreditAtomic: bigint | undefined
  txAmountCap: bigint | undefined
}): DepositLimits {
  const { receiveAtomic, feeAtomic, decimals, valuation, settlementCreditAtomic, txAmountCap } =
    input
  const sendAtomic = receiveAtomic + feeAtomic
  const limit = publicLimitAtomic(decimals, valuation)
  let maxReceiveAtomic: bigint | undefined
  if (limit !== undefined) {
    const net = limit > feeAtomic ? floorToTypeable(limit - feeAtomic, decimals) : 0n
    maxReceiveAtomic =
      settlementCreditAtomic !== undefined && txAmountCap !== undefined && net > txAmountCap
        ? floorToTypeable(txAmountCap, decimals)
        : net
  }
  return {
    sendAtomic,
    publicLimit: checkPublicLimit(sendAtomic, decimals, valuation),
    protocolCeiling: checkProtocolCeiling(settlementCreditAtomic, txAmountCap),
    maxReceiveAtomic,
  }
}

export interface WithdrawalLimits {
  publicLimit: PublicLimitCheck
  protocolCeiling: ProtocolCeilingCheck
}

/** A withdrawal is typed as the amount taken from the balance: the burn, fees included. */
export function withdrawalLimits(input: {
  debitAtomic: bigint
  decimals: number
  valuation: UsdValuation | undefined
  txAmountCap: bigint | undefined
}): WithdrawalLimits {
  return {
    publicLimit: checkPublicLimit(input.debitAtomic, input.decimals, input.valuation),
    protocolCeiling: checkProtocolCeiling(input.debitAtomic, input.txAmountCap),
  }
}

export type WithdrawalMax =
  | { status: "available"; atomic: bigint; bound: "balance" | "public-limit" | "protocol-ceiling" }
  | { status: "valuation-unavailable" }

/** MAX: the smallest of the spendable balance, the published limit and `txAmountCap`, rounded down. */
export function withdrawalMax(input: {
  spendableAtomic: bigint
  decimals: number
  valuation: UsdValuation | undefined
  txAmountCap: bigint | undefined
}): WithdrawalMax {
  return withdrawalMaxNet({ ...input, feeAtomic: 0n })
}

/**
 * MAX for a withdrawal typed as the amount to receive, its fee burned on top: the largest typeable
 * amount whose debit, fee included, fits the spendable balance, the published limit and
 * `txAmountCap`. Zero when the fee alone fills the smallest of them.
 */
export function withdrawalMaxNet(input: {
  spendableAtomic: bigint
  feeAtomic: bigint
  decimals: number
  valuation: UsdValuation | undefined
  txAmountCap: bigint | undefined
}): WithdrawalMax {
  const limit = publicLimitAtomic(input.decimals, input.valuation)
  if (limit === undefined) return { status: "valuation-unavailable" }
  const candidates: { atomic: bigint; bound: "balance" | "public-limit" | "protocol-ceiling" }[] = [
    { atomic: input.spendableAtomic, bound: "balance" },
    { atomic: limit, bound: "public-limit" },
    ...(input.txAmountCap === undefined
      ? []
      : [{ atomic: input.txAmountCap, bound: "protocol-ceiling" as const }]),
  ]
  const least = candidates.reduce((a, b) => (b.atomic < a.atomic ? b : a))
  const net = least.atomic - input.feeAtomic
  return {
    status: "available",
    atomic: net > 0n ? floorToTypeable(net, input.decimals) : 0n,
    bound: least.bound,
  }
}
