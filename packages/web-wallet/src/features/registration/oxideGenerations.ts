import { bestEffort } from "@obsidion/core/errors"
import type { Address } from "viem"
import {
  readClaimFpcIdentityCatalog,
  type ContractService,
  type ObsidionWallet,
} from "@obsidion/sdk"
import {
  createOxideL1Reader,
  retiredIdentityGenerations,
  type OxideIdentityDeps,
} from "@obsidion/front-core"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"

export async function loadOxideGenerations(
  wallet: ObsidionWallet,
  contractService: ContractService,
  { config, chain }: PageFacts,
): Promise<OxideIdentityDeps> {
  const [tuple, identity, bindings, retired] = await Promise.all([
    chain.oxideTuple.read(),
    wallet.getNodeIdentity(),
    readClaimFpcIdentityCatalog(wallet, contractService),
    bestEffort("unknown", chain.retiredRollupSources.read()),
  ])
  const rollupVersion = String(identity.rollupVersion)
  const retiredSources = retired ?? []
  return {
    reader: createOxideL1Reader(l1PublicClient(config)),
    registry: requireTupleField(tuple, "registry") as Address,
    rollupVersion,
    admissibleRollupVersions: new Set([
      rollupVersion,
      ...retiredSources.map((entry) => entry.rollupVersion),
    ]),
    catalog: [
      ...bindings.map((binding) => ({
        fpcAddress: binding.fpcAddress,
        accountFactory: binding.accountFactory as Address,
        namePortal: binding.namePortal as Address,
        rollupVersion,
      })),
      ...retiredIdentityGenerations(retiredSources),
    ],
    // An account the current rollup verifies still signs in, but no account can be ruled out.
    catalogIncomplete: retired === undefined,
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
