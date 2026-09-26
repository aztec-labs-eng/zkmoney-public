import type { Address } from "viem"
import {
  readClaimFpcIdentityCatalog,
  type ContractService,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { createOxideL1Reader, type OxideIdentityDeps } from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"

export async function loadOxideGenerations(
  wallet: ObsidionWallet,
  contractService: ContractService,
  config: WebWalletConfig,
): Promise<OxideIdentityDeps> {
  const [tuple, info, bindings] = await Promise.all([
    getOxideTuple(config),
    wallet.node.getNodeInfo(),
    readClaimFpcIdentityCatalog(wallet, contractService),
  ])
  const rollupVersion = String(info.rollupVersion)
  return {
    reader: createOxideL1Reader(l1PublicClient(config)),
    registry: requireTupleField(tuple, "registry") as Address,
    rollupVersion,
    catalog: bindings.map((binding) => ({
      fpcAddress: binding.fpcAddress,
      accountFactory: binding.accountFactory as Address,
      implementation: binding.implementation as Address,
      namePortal: binding.namePortal as Address,
      rollupVersion,
    })),
  }
}

export function generationFactories(generations: OxideIdentityDeps): Address[] {
  const seen = new Set<string>()
  return generations.catalog.flatMap((generation) => {
    const key = generation.accountFactory.toLowerCase()
    if (seen.has(key)) return []
    seen.add(key)
    return [generation.accountFactory]
  })
}
