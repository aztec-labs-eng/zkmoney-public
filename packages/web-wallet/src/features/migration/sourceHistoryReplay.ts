import type { OxideEnvTuple, SourceGenerationSession } from "@obsidion/core/types"
import { retiredDatabaseOf, sourceTagResolver } from "@obsidion/front-core"
import { sourceSipaScanParams, type SourceSipaScan } from "./sourceSipaSources"

/** The account's database on another generation's `tuple`, as that generation's own sync rebuilds it. */
export async function readSourceHistory(
  o: Omit<SourceSipaScan, "chain"> & {
    session: SourceGenerationSession
    handle: string | undefined
    /** The source rollup's deployments: a Savings move settles on the one its factory names. */
    deployments: OxideEnvTuple[]
  },
) {
  const { session, tuple, publicClient, scanHead } = o
  const { entries, short } = await session.history({
    ...(await sourceSipaScanParams(o)),
    accountTag: o.handle ?? session.address,
    linkBase: `${location.origin}/link#`,
    deployments: o.deployments,
    resolveTag: sourceTagResolver(publicClient, tuple, scanHead),
  })
  if (short.length) console.warn(`[migration] ${tuple.portal} read short: ${short.join(", ")}`)
  return retiredDatabaseOf(tuple.rollupVersion, entries, short.length > 0)
}
