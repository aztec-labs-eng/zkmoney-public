import { SkyEscrowFactoryAbi } from "@oxide/experiments/sky/sky_savings.js"
import type { Address, PublicClient } from "viem"

/** The two portals a Sky escrow factory's escrows deposit into: DAI's moving out, sUSDS's moving in. */
export interface SkyFactoryPortals {
  daiPortal: Address
  sUsdsPortal: Address
}

/** `factory`'s `DAI_PORTAL()` and `SUSDS_PORTAL()`: immutables. */
export async function readSkyFactoryPortals(
  client: Pick<PublicClient, "readContract">,
  factory: Address,
): Promise<SkyFactoryPortals> {
  const read = (functionName: "DAI_PORTAL" | "SUSDS_PORTAL") =>
    client.readContract({ address: factory, abi: SkyEscrowFactoryAbi, functionName })
  const [daiPortal, sUsdsPortal] = await Promise.all([read("DAI_PORTAL"), read("SUSDS_PORTAL")])
  return { daiPortal, sUsdsPortal }
}
