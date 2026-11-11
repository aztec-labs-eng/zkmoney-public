import { WalletError } from "@obsidion/core/errors"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { SwapEscrowOutput } from "@obsidion/sdk"
import daiIcon from "../../assets/deposit/dai.svg"
import usdcIcon from "../../assets/deposit/USDCToken.svg"
import usdtIcon from "../../assets/deposit/USDTToken.svg"
import ethIcon from "../../assets/deposit/ethereum.webp"
import { tokenName } from "../token/tokenName"

export type WithdrawalReceiveAsset = SwapEscrowOutput

export interface WithdrawalReceiveAssetOption {
  id: WithdrawalReceiveAsset
  symbol: WithdrawalReceiveAsset
  name: string
  icon: string
  direct: boolean
}

/** Output choices for the web withdrawal; the swap ones route through oxide's SwapEscrow. */
export const WITHDRAWAL_RECEIVE_ASSETS: readonly WithdrawalReceiveAssetOption[] = [
  { id: "DAI", symbol: "DAI", name: tokenName("DAI"), icon: daiIcon, direct: true },
  { id: "USDC", symbol: "USDC", name: tokenName("USDC"), icon: usdcIcon, direct: false },
  { id: "USDT", symbol: "USDT", name: tokenName("USDT"), icon: usdtIcon, direct: false },
  { id: "ETH", symbol: "ETH", name: tokenName("ETH"), icon: ethIcon, direct: false },
]

/**
 * The choices to actually offer. A swap route needs the factory whose counterfactual escrow the
 * burn pays; without it there is nowhere to burn to, so offering the route would strand the DAI.
 * Fail closed instead — DAI always works.
 */
export function withdrawalReceiveAssets(
  tuple: Pick<OxideEnvTuple, "swapEscrowFactoryV2">,
): readonly WithdrawalReceiveAssetOption[] {
  const swapReady = tuple.swapEscrowFactoryV2 != null
  return swapReady ? WITHDRAWAL_RECEIVE_ASSETS : WITHDRAWAL_RECEIVE_ASSETS.filter((o) => o.direct)
}

export function withdrawalReceiveAsset(id: WithdrawalReceiveAsset): WithdrawalReceiveAssetOption {
  const option = WITHDRAWAL_RECEIVE_ASSETS.find((candidate) => candidate.id === id)
  if (!option) throw new WalletError("invariant", `Unknown withdrawal receive asset: ${id}`)
  return option
}
