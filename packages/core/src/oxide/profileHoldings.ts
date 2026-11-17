import { bridgeByPortal, type OxideDeployment } from "./deployment.js"
import { deploymentHoldings, pinnedHoldings, type SavingsPortal } from "./holdings.js"

/** What a config profile version says of its pinned deployment's portals and holdings. */
export interface ProfileHoldings {
  portals?: { main: readonly string[]; savings: readonly SavingsPortal[] }
  holdings?: readonly string[]
  holdingCopy?: Readonly<Record<string, unknown>>
}

/**
 * Why `deployment` cannot carry a profile's `portals` and `holdings`; empty when it can. Each
 * portal must be a bridge of it, and each holding the profile names or lists one it holds. The
 * wallet drops a portal its deployment lacks, so this refuses the profile before it is published.
 */
export function profileHoldingsProblems(
  deployment: OxideDeployment,
  { portals, holdings }: ProfileHoldings,
): string[] {
  const problems: string[] = []
  const faulted = new Set<string>()
  const bridge = (what: string, portal: string, id?: string) => {
    if (bridgeByPortal(deployment, portal)) return
    problems.push(`${what} ${portal} is no bridge of ${deployment.label}`)
    if (id !== undefined) faulted.add(id)
  }
  for (const portal of portals?.main ?? []) bridge("portals.main", portal)
  for (const { id, portal, base } of portals?.savings ?? []) {
    bridge(`savings portal ${id}'s portal`, portal, id)
    bridge(`savings portal ${id}'s base`, base, id)
  }
  const named = new Set([...(portals?.savings ?? []).map(({ id }) => id), ...(holdings ?? [])])
  const read = deploymentHoldings(deployment, portals?.savings)
  for (const { id, code, detail } of read.rejected) {
    if (!named.has(id)) continue
    problems.push(`holding ${id} is refused: ${code} ${detail}`)
    faulted.add(id)
  }
  for (const id of named) {
    if (faulted.has(id) || read.holdings.some((holding) => holding.id === id)) continue
    problems.push(`holding ${id} is no holding of ${deployment.label}`)
  }
  return problems
}

/**
 * The holdings the wallet lists for a profile, by its `holdings` or else the pinned deployment's
 * default, that have no words in `holdingCopy`. The wallet takes no move into such a holding.
 */
export function unwordedHoldings(
  pinned: Parameters<typeof pinnedHoldings>[0],
  { portals, holdings, holdingCopy = {} }: ProfileHoldings,
): string[] {
  const listed = holdings ?? [pinnedHoldings(pinned, portals?.savings).listedByDefault]
  return listed.filter((id): id is string => id !== undefined && !Object.hasOwn(holdingCopy, id))
}
