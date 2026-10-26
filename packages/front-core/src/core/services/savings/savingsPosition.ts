import { L1_CHAIN_ID } from "@obsidion/core/constants"
import { OxidePortalAbi } from "@oxide/l1-contracts"
import { erc4626Abi, type Address, type PublicClient } from "viem"
import { SHARE, apyFromSsr } from "./savingsMath"
import type { SavingsPrice } from "./types"

type Reader = Pick<PublicClient, "readContract">

const ssrAbi = [
  {
    type: "function",
    name: "ssr",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const

/** The sUSDS vault behind a Sky deployment's portal. */
export const readSavingsVault = (client: Reader, portal: Address): Promise<Address> =>
  client.readContract({
    address: portal,
    abi: OxidePortalAbi,
    functionName: "UNDERLYING",
  }) as Promise<Address>

/** The yearly rate shown off mainnet where the vault publishes none, so the rate surfaces can be tested. */
export const TEST_SAVINGS_APY = 0.045

/**
 * The vault's yearly rate. A vault with no `ssr` gives `TEST_SAVINGS_APY` on a chain other than
 * mainnet and no rate on mainnet, so a failed read never shows an invented rate there.
 */
export async function readSavingsApy(
  client: Reader,
  vault: Address,
  { l1ChainId }: { l1ChainId?: number } = {},
): Promise<number | undefined> {
  const ssr = await client
    .readContract({ address: vault, abi: ssrAbi, functionName: "ssr" })
    .catch(() => undefined)
  if (ssr !== undefined) return apyFromSsr(ssr)
  return l1ChainId !== undefined && l1ChainId !== L1_CHAIN_ID.MAINNET ? TEST_SAVINGS_APY : undefined
}

/** The vault's share price and the rate shares grow at. */
export async function readSavingsPrice(
  client: Reader,
  vault: Address,
  { l1ChainId, now = Date.now() }: { l1ChainId?: number; now?: number } = {},
): Promise<SavingsPrice> {
  const [sharePrice, apy] = await Promise.all([
    client.readContract({
      address: vault,
      abi: erc4626Abi,
      functionName: "convertToAssets",
      args: [SHARE],
    }),
    readSavingsApy(client, vault, { l1ChainId }),
  ])
  return { sharePrice, ...(apy === undefined ? {} : { apy }), readAt: now }
}
