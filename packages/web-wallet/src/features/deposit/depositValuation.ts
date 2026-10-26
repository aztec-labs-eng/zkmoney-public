import { depositTokenValuation, type UsdValuation } from "@obsidion/front-core"
import type { DepositTokenOption, DepositTokens } from "./loadDepositFacts"

/** The picked token's USD valuation for the published limit: nominal for every token Main offers. */
export function depositValuation(
  token: Pick<DepositTokenOption, "address">,
  tokens: Pick<DepositTokens, "offered">,
): UsdValuation | undefined {
  return depositTokenValuation({
    accepted: tokens.offered.map((t) => t.address),
    token: token.address,
  })
}
