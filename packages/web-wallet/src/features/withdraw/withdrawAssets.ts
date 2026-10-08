import type { OxideEnvTuple } from "@obsidion/core/types"
import type { SwapOnWithdrawOutput } from "@obsidion/sdk"
import daiIcon from "../../assets/deposit/dai.svg"
import usdcIcon from "../../assets/deposit/USDCToken.svg"
import usdtIcon from "../../assets/deposit/USDTToken.svg"
import ethIcon from "../../assets/deposit/ethereum.webp"

export type WithdrawalReceiveAsset = "DAI" | SwapOnWithdrawOutput

export interface WithdrawalReceiveAssetOption {
  id: WithdrawalReceiveAsset
  symbol: WithdrawalReceiveAsset
  name: string
  icon: string
  direct: boolean
}

/** Output choices for the web withdrawal; the swap ones route through oxide's SwapEscrow. */
export const WITHDRAWAL_RECEIVE_ASSETS: readonly WithdrawalReceiveAssetOption[] = [
  { id: "DAI", symbol: "DAI", name: "Dai (direct)", icon: daiIcon, direct: true },
  { id: "USDC", symbol: "USDC", name: "USD Coin", icon: usdcIcon, direct: false },
  { id: "USDT", symbol: "USDT", name: "Tether", icon: usdtIcon, direct: false },
  { id: "ETH", symbol: "ETH", name: "Ether", icon: ethIcon, direct: false },
]

/** Native ETH is not an ERC20, so its network row drops the token standard. */
export function withdrawalNetworkLabel(asset: WithdrawalReceiveAsset | undefined): string {
  return asset === "ETH" ? "Ethereum" : "Ethereum (ERC20)"
}

/**
 * The choices to actually offer. A swap route needs the factory whose counterfactual escrow the
 * burn pays; without it there is nowhere to burn to, so offering the route would strand the DAI.
 * Fail closed instead — DAI always works.
 */
export function withdrawalReceiveAssets(
  tuple: Pick<OxideEnvTuple, "swapEscrowFactory">,
): readonly WithdrawalReceiveAssetOption[] {
  const swapReady = tuple.swapEscrowFactory != null
  return swapReady ? WITHDRAWAL_RECEIVE_ASSETS : WITHDRAWAL_RECEIVE_ASSETS.filter((o) => o.direct)
}

export function withdrawalReceiveAsset(id: WithdrawalReceiveAsset): WithdrawalReceiveAssetOption {
  const option = WITHDRAWAL_RECEIVE_ASSETS.find((candidate) => candidate.id === id)
  if (!option) throw new Error(`Unknown withdrawal receive asset: ${id}`)
  return option
}
