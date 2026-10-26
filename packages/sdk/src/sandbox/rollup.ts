import { RegistryContract } from "@aztec-labs/ethereum/contracts"
import { deployL1Contract } from "@aztec-labs/ethereum/deploy-l1-contract"
import type { ExtendedViemWalletClient } from "@aztec-labs/ethereum/types"
import type { OxidePortalContract } from "@oxide/l1-contracts"
import { MockRollupAbi, MockRollupBytecode } from "@oxide/l1-contracts/artifacts.js"
import { createWalletClient, http, parseAbi, toHex, type Hex } from "viem"
import { foundry } from "viem/chains"

/**
 * Makes a stand-in rollup canonical in `portal`'s registry on an anvil, so the portal can freeze: it freezes only
 * once its rollup is no longer the canonical one. The registry's governance is impersonated, as Oxide's own e2e
 * does, and the nodes keep running their own rollups. Does nothing when the portal's rollup is already not canonical.
 */
export async function makeRollupNonCanonical(
  l1Client: ExtendedViemWalletClient,
  portal: OxidePortalContract,
  l1RpcUrl: string,
): Promise<void> {
  const registryAddress = (await portal.getRegistry()).toString() as Hex
  const registry = new RegistryContract(l1Client, registryAddress)
  if (!(await registry.getCanonicalAddress()).equals(await portal.getRollup())) return
  const { address: standIn } = await deployL1Contract(
    l1Client,
    MockRollupAbi,
    MockRollupBytecode,
    [],
  )
  const governance = (await registry.getOwner()).toString() as Hex
  const anvil = (method: string, params: unknown[]) => l1Client.request({ method, params } as never)
  await anvil("anvil_impersonateAccount", [governance])
  try {
    await anvil("anvil_setBalance", [governance, toHex(10n ** 18n)])
    const hash = await createWalletClient({
      account: governance,
      chain: foundry,
      transport: http(l1RpcUrl),
    }).writeContract({
      address: registryAddress,
      abi: parseAbi(["function addRollup(address)"]),
      functionName: "addRollup",
      args: [standIn.toString() as Hex],
    })
    await l1Client.waitForTransactionReceipt({ hash })
  } finally {
    await anvil("anvil_stopImpersonatingAccount", [governance])
  }
}
