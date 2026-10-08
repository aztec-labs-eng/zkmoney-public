import type { Address } from "viem"
import { l1ChainIdForNetwork, Network } from "@obsidion/core/constants"
import { depositTokenValuation, type UsdValuation } from "@obsidion/front-core"
import { isDemoMode } from "../../dev/demoFlag"
import type { DepositTokenOption } from "./loadDepositFacts"

/**
 * The picked token's USD valuation for the published limit, matched by address. The dev demo
 * offers the mainnet USDC and USDT on any chain (`depositTokensFor`), so only there does a token
 * this chain does not accept fall back to its mainnet identity.
 */
export function depositValuation(
  token: DepositTokenOption,
  manifestToken: Address,
  chainId: number,
): UsdValuation | undefined {
  const identity = { portalToken: manifestToken, token: token.address ?? manifestToken }
  const valuation = depositTokenValuation({ chainId, ...identity })
  if (valuation || !import.meta.env.DEV || !isDemoMode()) return valuation
  return depositTokenValuation({ chainId: l1ChainIdForNetwork(Network.MAINNET), ...identity })
}
