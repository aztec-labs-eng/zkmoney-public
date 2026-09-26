import { erc20Abi, formatUnits, type Address } from "viem"
import { quotedDepositFee } from "@obsidion/core/constants"
import { Network, readDepositFee } from "@obsidion/sdk"
import { depositSipaImplementation } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { fpcFundingCut } from "../fees/fpcFundingCut"
import daiIcon from "../../assets/deposit/dai.svg"
import usdcIcon from "../../assets/deposit/USDCToken.svg"
import usdtIcon from "../../assets/deposit/USDTToken.svg"
import testIcon from "../../assets/deposit/ethereum.webp"

export interface DepositTokenOption {
  /** Unset = the manifest token (`l1Addresses.<network>.token` in the oxide tuple). */
  address?: Address
  symbol: string
  decimals: number
  icon: string
}

const MAINNET_TOKENS: DepositTokenOption[] = [
  { symbol: "DAI", decimals: 18, icon: daiIcon },
  {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    decimals: 6,
    icon: usdcIcon,
  },
  {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    symbol: "USDT",
    decimals: 6,
    icon: usdtIcon,
  },
]

/**
 * Picker entries per network. The first entry is always the manifest token the portal settles in:
 * DAI on mainnet, the registry's deployed test ERC-20 elsewhere. USDC/USDT are swapped to DAI via
 * the Curve 3pool (`ThreePoolLib`) on `chainid == 1` only, so no other network offers them — a
 * non-manifest token sent anywhere else strands until `recoverERC20`.
 *
 * A dev demo shows the mainnet shape whatever network it booted on, so the picker, the per-token
 * fee copy and the non-DAI Received row are reviewable offline.
 */
export function depositTokensFor(network: Network): DepositTokenOption[] {
  if (import.meta.env.DEV && isDemoMode()) return MAINNET_TOKENS
  switch (network) {
    case Network.MAINNET:
      return MAINNET_TOKENS
    default:
      return [{ symbol: "TEST", decimals: 18, icon: testIcon }]
  }
}

/** What the deposit screen quotes: the fee, its two halves, and the manifest token address. */
export interface DepositDisplayFacts {
  /** The whole quoted fee, display units. */
  fee: string
  token: Address
  /** The relayer's sweep fee, base units. */
  sweepFeeAtomic: bigint
  /** The portal's funding cut, base units. */
  fpcFundingCutAtomic: bigint
}

/**
 * Quote a deposit: both halves of what it costs, read live off the portal's deposit
 * implementation and off the portal itself. The halves are stamped separately on the record a deposit creates, so the
 * detail sheet can reproduce this same total.
 */
export async function loadDepositDisplayFacts(): Promise<DepositDisplayFacts> {
  const config = getConfig()
  const publicClient = l1PublicClient(config)
  const tuple = await getOxideTuple(config)
  const token = requireTupleField(tuple, "token") as Address
  const [decimals, sweepFeeAtomic, fpcFundingCutAtomic] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    depositSipaImplementation(
      publicClient,
      requireTupleField(tuple, "sipaFactory") as Address,
      requireTupleField(tuple, "portal") as Address,
    ).then((implementation) => readDepositFee(publicClient, implementation)),
    fpcFundingCut(publicClient, requireTupleField(tuple, "portal") as Address),
  ])
  return {
    fee: formatUnits(quotedDepositFee(sweepFeeAtomic, fpcFundingCutAtomic), decimals),
    token,
    sweepFeeAtomic,
    fpcFundingCutAtomic,
  }
}
