import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { depositPayoutTokenFor, depositTokensFor } from "@oxide/l1-contracts"
import {
  feeTokenRow,
  sipaIntentRow,
  type OxideBridge,
  type OxideDeployment,
  type OxideDeploymentTable,
  type OxideFeature,
  type OxideTableRow,
  type SipaIntentName,
} from "@obsidion/core/oxide"
import type { Address } from "viem"
import { SKY_PROJECT, SKY_ROLES } from "../core/services/savings/savingsDeployment"

/** A token a SIPA of the pinned table accepts, and the row its sweep settles on. */
export interface DepositTokenRoute {
  /** The token the sender sends. */
  token: Address
  row: OxideTableRow
  /** The SIPA swaps `token` into the row's token before it deposits. */
  swapped: boolean
}

/**
 * Every token a SIPA of the table accepts for `intent`, each with the row its sweep reads: each row's own token, and
 * each token Oxide's SIPA swaps into a row's token on this chain (the mainnet USDC and USDT, into DAI). A row's swap
 * inputs follow it. A row is left out when `intent` does not settle on it, so a registration lists only the fee
 * token's row, and a token the SIPA swaps away settles on the row it swaps into. Product rows are listed too, so the
 * sweeps and claims cover them; {@link mainDepositTokenRoutes} is what a deposit surface offers.
 */
export function depositTokenRoutes(
  table: OxideDeploymentTable,
  chainId: number | bigint,
  intent: SipaIntentName = "deposit",
): DepositTokenRoute[] {
  const chain = BigInt(chainId)
  const routes: DepositTokenRoute[] = []
  const seen = new Set<string>()
  const add = (token: EthAddress, row: OxideTableRow, swapped: boolean) => {
    const key = token.toString().toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    routes.push({ token: token.toString() as Address, row, swapped })
  }
  for (const row of table.rows) {
    if (sipaIntentRow(table, intent, row.bridge.underlying)?.bridge !== row.bridge) continue
    const own = EthAddress.fromString(row.bridge.underlying)
    if (depositPayoutTokenFor(chain, own).equals(own)) add(own, row, false)
    for (const token of depositTokensFor(chain, own)) {
      if (!token.equals(own) && depositPayoutTokenFor(chain, token).equals(own))
        add(token, row, true)
    }
  }
  return routes
}

/** A row a feature binds: only that feature's product offers its token. */
export interface ProductRow {
  row: OxideTableRow
  feature: OxideFeature
  /** The role the feature binds the row's bridge in, e.g. Sky's `sUsds`. */
  role: string
}

/** The table's rows split by what a deposit of their token credits. */
export interface DepositRows {
  /** The rows that credit Main: what the deposit surfaces offer. */
  main: OxideTableRow[]
  /** The rows that credit a product, such as Savings: each is offered only by its product's UI. */
  product: ProductRow[]
}

/** The role a known feature binds Main's bridge in. */
const MAIN_ROLES: Readonly<Record<string, string>> = { [SKY_PROJECT]: SKY_ROLES.main }

/** The first feature that binds `bridge` in a role other than Main's. */
function productBinding(
  deployment: OxideDeployment,
  bridge: OxideBridge,
): Omit<ProductRow, "row"> | undefined {
  if (bridge.id === undefined) return undefined
  for (const feature of deployment.features ?? []) {
    const role = Object.keys(feature.bridges).find(
      (role) => feature.bridges[role] === bridge.id && role !== MAIN_ROLES[feature.project],
    )
    if (role !== undefined) return { feature, role }
  }
  return undefined
}

/**
 * Splits the table's rows into Main's and products'. A row is a product's when a feature binds its bridge in a role
 * other than Main's (Sky binds DAI as `dai`), unless it is the fee token's row, which is Main's whatever binds it. So a
 * new plain row is offered with no release, and a new feature-bound row stays hidden until its product surfaces it.
 */
export function depositRows(table: OxideDeploymentTable): DepositRows {
  const fee = feeTokenRow(table)
  const rows: DepositRows = { main: [], product: [] }
  for (const row of table.rows) {
    const binding = row === fee ? undefined : productBinding(table.deployment, row.bridge)
    if (binding) rows.product.push({ row, ...binding })
    else rows.main.push(row)
  }
  return rows
}

/** {@link depositTokenRoutes} over Main's rows alone: what the deposit, funding, request and limits surfaces offer. */
export function mainDepositTokenRoutes(
  table: OxideDeploymentTable,
  chainId: number | bigint,
  intent: SipaIntentName = "deposit",
): DepositTokenRoute[] {
  const main = new Set(depositRows(table).main)
  return depositTokenRoutes(table, chainId, intent).filter((route) => main.has(route.row))
}

/** Whether a SIPA sweep of `sent` settles on the row of `rowToken` on this chain: `sent` is it, or swaps into it. */
export function sweepsInto(chainId: number | bigint, sent: string, rowToken: string): boolean {
  try {
    return depositPayoutTokenFor(BigInt(chainId), EthAddress.fromString(sent)).equals(
      EthAddress.fromString(rowToken),
    )
  } catch {
    return false
  }
}
