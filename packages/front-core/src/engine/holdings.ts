import {
  holdingCatalog,
  type DeploymentHoldings,
  type Holding,
  type HoldingCatalog,
  type SkyEscrowHolding,
} from "@obsidion/core/oxide"
import type { Address } from "viem"
import type { SkyHoldingRef } from "../storageMigrations/savingsMoves"
import type { BalanceEntry } from "./balances"
import type { RecordSet } from "./persistentStore"

/** One line of the account's holdings: the holding its moves go through, for its L2 token. */
export type HoldingLine = Holding & {
  /** The profile does not list it: it takes moves out only. */
  exitOnly: boolean
  /** Every deployment holding on the line's token: the moves of each changed its shares. */
  holdingIds: readonly string[]
}

const tokenKey = (token: string) => token.toLowerCase()

/** The shares `scope`'s balance reads hold of `token`; undefined until one is read. */
export function heldShares(
  balances: RecordSet<BalanceEntry>,
  scope: string,
  token: string,
): bigint | undefined {
  return balances.records.find((e) => e.scope === scope && tokenKey(e.token) === tokenKey(token))
    ?.atomic
}

/**
 * The holdings the account sees, one line per L2 token: the catalog's in profile order, then, in
 * manifest order, every other deployment holding `scope` holds shares of, as exit-only, so funds
 * the profile stops listing can still leave.
 */
export function selectHoldings(
  catalog: HoldingCatalog,
  deployment: DeploymentHoldings,
  balances: RecordSet<BalanceEntry>,
  scope: string,
): HoldingLine[] {
  const idsOn = (token: string) =>
    deployment.holdings.filter((h) => tokenKey(h.l2Token) === token).map((h) => h.id)
  const lines = new Map<string, HoldingLine>()
  const add = (holding: Holding, exitOnly: boolean) => {
    const token = tokenKey(holding.l2Token)
    lines.set(token, { ...holding, exitOnly, holdingIds: idsOn(token) })
  }
  for (const holding of catalog.holdings) add(holding, false)
  for (const holding of deployment.holdings) {
    if (lines.has(tokenKey(holding.l2Token))) continue
    if ((heldShares(balances, scope, holding.l2Token) ?? 0n) > 0n) add(holding, true)
  }
  return [...lines.values()]
}

/** The holdings Savings prices, one per share token: the listed ones, then the deployment's. */
export function savingsHoldings(
  deployment: DeploymentHoldings,
  listed: readonly string[] | undefined,
): Holding[] {
  const all = [...holdingCatalog(deployment, listed).holdings, ...deployment.holdings]
  return all.filter(
    (h, i) => all.findIndex((o) => tokenKey(o.l2Token) === tokenKey(h.l2Token)) === i,
  )
}

/** The first holding Savings prices, for a reader that takes one. */
export const savingsHolding = (
  deployment: DeploymentHoldings,
  listed: readonly string[] | undefined,
): Holding | undefined => savingsHoldings(deployment, listed)[0]

/**
 * The holding an older build's Savings moves count in. Those moves ran through a Sky escrow, so it
 * is the first holding on that rail, whose factory their replay reads.
 */
export function savingsHoldingRef(
  deployment: DeploymentHoldings,
  listed: readonly string[] | undefined,
): SkyHoldingRef | undefined {
  const sky = savingsHoldings(deployment, listed).find(
    (h): h is SkyEscrowHolding => h.rail === "skyEscrow",
  )
  if (!sky) return undefined
  const blocks = [sky.base, sky.held].map((bridge) => BigInt(bridge.tuple.deployedAtBlock ?? 0))
  const fromBlock = blocks.reduce((first, block) => (block < first ? block : first))
  return { id: sky.id, factory: sky.escrow.factory as Address, fromBlock }
}
