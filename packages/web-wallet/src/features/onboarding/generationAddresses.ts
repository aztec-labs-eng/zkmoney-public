import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { L2AddressOn } from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { getRetiredRollupSources } from "../../config/oxideTuple"
import {
  isOtherGeneration,
  loadSourceGeneration,
  nodeAztecMajor,
} from "../../platform/sourceGeneration"

/**
 * A candidate's address on each retired rollup sign-in admits. A rollup of another Aztec generation
 * derives another address from the same keys, so that generation's bundle derives it.
 */
export function generationAddresses(config: WebWalletConfig, publicKeyHex: string) {
  return (msk: Fr, l2Address: string): L2AddressOn =>
    async (rollupVersion) => {
      const nodeUrl = await retiredNodeOf(config, rollupVersion)
      if (!nodeUrl || !(await isOtherGeneration(nodeUrl))) return l2Address
      const rollup = config.sourceRollups?.find((r) => r.nodeUrl === nodeUrl)
      if (!rollup) return undefined
      const generation = await loadSourceGeneration(await nodeAztecMajor(nodeUrl))
      return generation.accountAddress({
        secretKey: msk.toString(),
        publicKeyHex,
        network: config.network,
        contracts: rollup.contracts,
      })
    }
}

/** The configured node of a retired rollup, by rollup version. */
async function retiredNodeOf(config: WebWalletConfig, rollupVersion: string) {
  const retired = (await getRetiredRollupSources(config)).find(
    (tuple) => tuple.rollupVersion === rollupVersion,
  )
  return retired && config.sourceRollupNodes?.get(retired.portal.toLowerCase())
}
