/**
 * The per-withdrawal limit as the sheets and the gateways apply it: each burn counts what it spends,
 * fees included, at the nominal $1 valuation of the settlement token.
 */
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  NOMINAL_USD_VALUATION,
  checkProtocolCeiling,
  withdrawalLimits,
  withdrawalMax,
} from "@obsidion/front-core"
import { TX_AMOUNT_CAP } from "@obsidion/sdk"
import { formatPublicLimit, type LimitProblem } from "./publicLimit"

/** The first limit a burn of `debitAtomic` breaks; undefined when it fits. */
export function withdrawalLimitProblem(
  debitAtomic: bigint,
  decimals = DEFAULT_DECIMALS,
): LimitProblem | undefined {
  const limits = withdrawalLimits({ debitAtomic, decimals, valuation: NOMINAL_USD_VALUATION })
  if (limits.publicLimit === "valuation-unavailable") return "valuation"
  if (limits.publicLimit === "over") return "public"
  if (limits.protocolCeiling === "over") return "protocol"
  return undefined
}

/** Why a burn is refused: a withdrawal from the balance, or a link's whole escrow sent to Ethereum. */
export function withdrawalLimitRefusal(
  problem: LimitProblem,
  subject: "withdrawal" | "link" = "withdrawal",
): string {
  const limit = formatPublicLimit()
  if (subject === "link") {
    const route = "so it cannot be claimed to an Ethereum wallet."
    return problem === "valuation"
      ? `This link's token cannot be checked against the ${limit} withdrawal limit, ${route}`
      : problem === "public"
      ? `This link holds more than the ${limit} withdrawal limit, ${route}`
      : `This link holds more than the network allows in one withdrawal, ${route}`
  }
  return problem === "valuation"
    ? `This token can't be checked against the ${limit} withdrawal limit.`
    : problem === "public"
    ? `This withdrawal is over the ${limit} limit, fees included.`
    : "This withdrawal is over the network's maximum per withdrawal."
}

/** Throws the refusal for a burn over the limit. Gateways call it before anything is signed or recorded. */
export function assertWithinWithdrawalLimit(
  debitAtomic: bigint,
  subject?: "withdrawal" | "link",
  decimals?: number,
): void {
  const problem = withdrawalLimitProblem(debitAtomic, decimals)
  if (problem) throw new Error(withdrawalLimitRefusal(problem, subject))
}

/**
 * A Savings move out's limit: the network's maximum per burn, on the shares it burns. The dollar
 * limit is Main's withdrawals' and does not apply.
 */
export function sharesBurnLimitProblem(sharesAtomic: bigint): LimitProblem | undefined {
  return checkProtocolCeiling(sharesAtomic) === "over" ? "protocol" : undefined
}

/** The most shares one move out burns. */
export const sharesBurnMax = (shares: bigint): bigint =>
  shares > TX_AMOUNT_CAP ? TX_AMOUNT_CAP : shares

/**
 * The most a withdrawal of `spendableAtomic` takes within Main's limits: the whole balance when it
 * fits, else the limit, to the cent. Undefined when the token cannot be valued.
 */
export function withdrawalMaxAtomic(
  spendableAtomic: bigint,
  decimals = DEFAULT_DECIMALS,
): bigint | undefined {
  const max = withdrawalMax({ spendableAtomic, decimals, valuation: NOMINAL_USD_VALUATION })
  if (max.status !== "available") return undefined
  return max.bound === "balance" ? spendableAtomic : max.atomic
}
