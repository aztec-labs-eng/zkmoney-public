import type { Address } from "viem"
import type { SipaIntentName } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { SipaSweepRoute } from "@obsidion/sdk"
import { sipaSweepRoutes } from "@obsidion/front-core"
import { requireTupleField } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"

/**
 * The sweeps a SIPA needs for `intent`: every token the table it commits to accepts, each through its settling row's
 * subsidy. A legacy SIPA commits to no table and sweeps `legacyToken` on `tuple`'s bridge alone.
 */
export async function getSipaSweepRoutes(
  page: PageFacts,
  tuple: OxideEnvTuple,
  sipaArgs: { forwardingTable: string } | { recoveryAddress: string },
  intent: SipaIntentName,
  legacyToken: string,
  /** The SIPA's factory, when it is an earlier set's. */
  sipaFactory?: string,
): Promise<SipaSweepRoute[]> {
  if ("recoveryAddress" in sipaArgs) {
    return [
      {
        token: legacyToken as Address,
        portal: requireTupleField(tuple, "portal") as Address,
        depositSubsidy: requireTupleField(tuple, "depositSubsidy") as Address,
      },
    ]
  }
  const table = await page.chain.sipaDeploymentTable(sipaArgs.forwardingTable).read()
  return sipaSweepRoutes(table, page.config.l1ChainId, intent, sipaFactory)
}
