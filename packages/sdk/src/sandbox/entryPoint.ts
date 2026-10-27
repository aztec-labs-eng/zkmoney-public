import { CANONICAL_ENTRY_POINT_V08, EntryPointAbi, deployEntryPoint } from "@oxide/l1-contracts"
import type { Address, PublicClient, WalletClient } from "viem"

/**
 * Installs the ERC-4337 entry point at the canonical address an `OxideAccount` pins, on an anvil
 * that has none. The entry point's SenderCreator only accepts calls from the entry point address
 * baked into it at construction, so that immutable is patched to the canonical address too, as
 * oxide's own end-to-end harness does. Returns the canonical address.
 */
export async function deployCanonicalEntryPoint(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<Address> {
  const present = await publicClient.getCode({ address: CANONICAL_ENTRY_POINT_V08 })
  if (present && present !== "0x") return CANONICAL_ENTRY_POINT_V08
  const deployed = await deployEntryPoint(walletClient, publicClient)
  const runtime = await publicClient.getCode({ address: deployed })
  if (!runtime) throw new Error(`entry point deploy at ${deployed} produced no code`)
  await publicClient.request({
    method: "anvil_setCode" as never,
    params: [CANONICAL_ENTRY_POINT_V08, runtime] as never,
  })
  const senderCreator = (await publicClient.readContract({
    address: deployed,
    abi: EntryPointAbi,
    functionName: "senderCreator",
  } as never)) as Address
  const creatorRuntime = await publicClient.getCode({ address: senderCreator })
  if (!creatorRuntime) throw new Error(`entry point ${deployed} has no SenderCreator code`)
  const patched = creatorRuntime
    .split(deployed.slice(2).toLowerCase())
    .join(CANONICAL_ENTRY_POINT_V08.slice(2).toLowerCase())
  if (patched === creatorRuntime) {
    throw new Error(`SenderCreator ${senderCreator} does not embed its entry point ${deployed}`)
  }
  await publicClient.request({
    method: "anvil_setCode" as never,
    params: [senderCreator, patched] as never,
  })
  return CANONICAL_ENTRY_POINT_V08
}
