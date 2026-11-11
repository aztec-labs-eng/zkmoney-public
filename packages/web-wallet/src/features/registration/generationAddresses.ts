import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { L2AddressOn } from "@obsidion/front-core"
import type { PageFacts } from "../../session/pageChain"
import {
  isOtherGeneration,
  loadSourceGeneration,
  nodeAztecMajor,
} from "../../platform/sourceGeneration"

/**
 * A candidate's address on each retired rollup sign-in admits. A rollup of another Aztec generation
 * derives another address from the same keys, so that generation's bundle derives it.
 */
export function generationAddresses(page: PageFacts, publicKeyHex: string) {
  const { config } = page
  return (msk: Fr, l2Address: string): L2AddressOn =>
    async (rollupVersion) => {
      const nodeUrl = await retiredNodeOf(page, rollupVersion)
      if (!nodeUrl || !(await isOtherGeneration(config, nodeUrl))) return l2Address
      const rollup = config.sourceRollups?.find((r) => r.nodeUrl === nodeUrl)
      if (!rollup) return undefined
      const generation = await loadSourceGeneration(await nodeAztecMajor(config, nodeUrl))
      return generation.accountAddress({
        secretKey: msk.toString(),
        publicKeyHex,
        network: config.network,
        contracts: rollup.contracts,
      })
    }
}

/** The configured node of a retired rollup, by rollup version. */
async function retiredNodeOf({ config, chain }: PageFacts, rollupVersion: string) {
  const retired = (await chain.retiredRollupSources.read()).find(
    (tuple) => tuple.rollupVersion === rollupVersion,
  )
  return retired && config.sourceRollupNodes?.get(retired.portal.toLowerCase())
}
