import {
  bridgeUnderlying,
  SIPA_INTENT_NAMES,
  type OxideDeploymentTable,
  type SipaIntentName,
} from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address } from "viem"
import type { SipaDeposit, SIPASweep } from "../engine/sipaDeposits"
import { depositTokenRoutes } from "./depositTokenRoutes"
import type { SipaFundingToken } from "./sipaFunding"
import { sipaIntentName, sipaRecordIntent } from "./sipaRoute"

/** A forwarding-table row as the deposit sync reads it: where its sweeps land and what they credit. */
export interface SipaRow {
  portal: Address
  l2Token: string
  /** The row's own token: what its sweeps credit on L2, and the units of its fees and cap. */
  token: SipaFundingToken
  /** Tokens a SIPA swaps into `token` before it sweeps (the mainnet USDC and USDT into DAI). */
  swapped: SipaFundingToken[]
  /** The intents whose sweeps settle on the row. */
  intents: SipaIntentName[]
}

/**
 * Every row of `table` a SIPA sweep settles on, in table order, with each token's symbol and decimals. A deposit
 * settles on each row the table prices it on; a registration on the fee token's row.
 */
export async function sipaRows(
  table: OxideDeploymentTable,
  chainId: number | bigint,
  metadata: (token: Address) => Promise<Omit<SipaFundingToken, "address">>,
): Promise<SipaRow[]> {
  const meta = async (address: Address): Promise<SipaFundingToken> => ({
    address,
    ...(await metadata(address)),
  })
  const routes = SIPA_INTENT_NAMES.map((intent) => ({
    intent,
    routes: depositTokenRoutes(table, chainId, intent),
  }))
  const rows = table.rows.filter((row) =>
    routes.some((r) => r.routes.some((route) => route.row === row)),
  )
  return Promise.all(
    rows.map(async (row): Promise<SipaRow> => {
      // Every intent's swap inputs: a row that settles registrations alone still takes them.
      const swapped = [
        ...new Set(
          routes.flatMap((r) =>
            r.routes
              .filter((route) => route.row === row && route.swapped)
              .map((route) => route.token),
          ),
        ),
      ]
      return {
        portal: row.bridge.portal as Address,
        l2Token: row.bridge.l2Token,
        token: await meta(row.bridge.underlying as Address),
        swapped: await Promise.all(swapped.map(meta)),
        intents: routes
          .filter((r) => r.routes.some((route) => route.row === row))
          .map((r) => r.intent),
      }
    }),
  )
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function sipaRowByPortal(rows: readonly SipaRow[], portal: string): SipaRow | undefined {
  return rows.find((row) => sameAddress(row.portal, portal))
}

/** The row of the bridge whose L2 token is `l2Token`. */
export function sipaRowByL2Token(rows: readonly SipaRow[], l2Token: string): SipaRow | undefined {
  return rows.find((row) => sameAddress(row.l2Token, l2Token))
}

/** The row a SIPA funded in `token` settles on: the row of `token`, or of the token it swaps into. */
export function sipaRowByFunding(
  rows: readonly SipaRow[],
  token: string | undefined,
): SipaRow | undefined {
  if (!token) return undefined
  return rows.find(
    (row) =>
      sameAddress(row.token.address, token) ||
      row.swapped.some((t) => sameAddress(t.address, token)),
  )
}

/** The tokens a SIPA of `rows` may be funded with, each row's token then its swap inputs, once each. */
export function sipaRowFundingTokens(rows: readonly SipaRow[]): SipaFundingToken[] {
  const seen = new Set<string>()
  return rows
    .flatMap((row) => [row.token, ...row.swapped])
    .filter((token) => {
      const key = token.address.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** The rows a sweep for the record's intent settles on: a registration's is the fee token's alone. */
export function sipaIntentRows(rows: readonly SipaRow[], intent: SipaDeposit["intent"]): SipaRow[] {
  const name = sipaIntentName(sipaRecordIntent(intent))
  return rows.filter((row) => row.intents.includes(name))
}

/**
 * The row a SIPA's record is shown in before any sweep names one: the pinned bridge's for a deposit,
 * else the first row that settles the intent.
 */
export function sipaDefaultRow(
  tuple: OxideEnvTuple,
  rows: readonly SipaRow[],
  intent: SipaDeposit["intent"],
): SipaRow {
  const settling = sipaIntentRows(rows, intent)
  return (
    (sipaIntentName(sipaRecordIntent(intent)) === "deposit" &&
      sipaRowByFunding(settling, bridgeUnderlying(tuple))) ||
    settling[0] ||
    rows[0]!
  )
}

/** The row a sweep settled on: its portal's, or the record's default row for a sweep saved without one. */
export function sipaSweepRow(
  tuple: OxideEnvTuple,
  rows: readonly SipaRow[],
  sweep: { portal?: string },
  intent: SipaDeposit["intent"],
): SipaRow {
  return (
    (sweep.portal && sipaRowByPortal(rows, sweep.portal)) || sipaDefaultRow(tuple, rows, intent)
  )
}

/** What a sweep through `row` credits: the row's portal, L2 token and token. */
export function sipaRowCredit(
  row: SipaRow,
): Pick<SIPASweep, "portal" | "l2Token" | "tokenAddress" | "tokenSymbol" | "tokenDecimals"> {
  return {
    portal: row.portal,
    l2Token: row.l2Token,
    tokenAddress: row.token.address,
    tokenSymbol: row.token.symbol,
    tokenDecimals: row.token.decimals,
  }
}
