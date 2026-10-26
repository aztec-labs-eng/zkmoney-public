// The pinned deployment as a table: its bridges, one per forwarding-table row, and the rows' on-chain terms. Every
// token list the wallet shows or sweeps comes from here, keyed by bridge and row, so a new row needs no release.
//
// The manifest names the bridges. The terms (each intent's sweep tip and beneficiary fee, the portal's cap) live on
// L1; sdk's `readDeploymentTable` reads them into an {@link OxideDeploymentTable}.

import type { OxideEnvTuple, OxideFeature } from "../types/index.js"

export type { OxideFeature }

/** The intents a forwarding-table row prices, by the name a SIPA record carries. */
export type SipaIntentName = "deposit" | "registration" | "user-op"

export const SIPA_INTENT_NAMES: readonly SipaIntentName[] = [
  "deposit",
  "registration",
  "user-op",
]

/** One portal for one token. In an app deployment each bridge is one row of the forwarding table. */
export interface OxideBridge {
  /** The row key, e.g. `dai`; absent on a bridge that serves no table. */
  key?: string
  /** The bridge's ID, which features bind it by. */
  id?: string
  /** The portal's own asset: the token a SIPA sweeps into it, and the row's token. */
  underlying: string
  /** The token users hold and are paid in. Differs from `underlying` only on a Sky bridge. */
  token: string
  portal: string
  l2Token: string
  /** The bridge as a whole entry: the deployment's fields plus its own. */
  tuple: OxideEnvTuple
}

/** One deployment: the bridges that share its fleet, its rollup and, for an app, its forwarding table. */
export interface OxideDeployment {
  label: string
  chainId?: string
  rollupVersion: string
  /** The table every SIPA of the deployment commits to; absent on a bridge-only deployment. */
  forwardingTable?: string
  /** The token registrations, metadata updates and user operations settle in. */
  feeToken?: string
  /** In manifest order. */
  bridges: readonly OxideBridge[]
  /** Contracts that serve the bridges beside their portals, in manifest order. */
  features?: readonly OxideFeature[]
}

/** What a row charges a sweep of its token for one intent, in the token's base units. */
export interface OxideRowTerms {
  sweepTip: bigint
  beneficiaryFee: bigint
}

/** A bridge with the terms its forwarding-table row sets. */
export interface OxideTableRow {
  bridge: OxideBridge
  /** Absent ⇒ the table routes no sweep of the token for that intent; such a sweep reverts. */
  intents: Partial<Record<SipaIntentName, OxideRowTerms>>
  /** The portal's `TX_AMOUNT_CAP()`: the most one sweep may deposit. */
  txAmountCap: bigint
}

/** The pinned deployment with the rows its table lists. A bridge the table does not list has no row. */
export interface OxideDeploymentTable {
  deployment: OxideDeployment
  /** Bridge order. */
  rows: readonly OxideTableRow[]
  /** The table's one fee beneficiary; absent when no row was read. */
  beneficiary?: string
}

const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** The portal's asset of a tuple; a tuple without `underlying` is a plain bridge. */
export function bridgeUnderlying(tuple: Pick<OxideEnvTuple, "token" | "underlying">): string {
  return tuple.underlying ?? tuple.token
}

/** A parsed entry as a bridge. */
export function bridgeOfTuple(tuple: OxideEnvTuple): OxideBridge {
  return {
    ...(tuple.bridgeKey ? { key: tuple.bridgeKey } : {}),
    ...(tuple.bridgeId ? { id: tuple.bridgeId } : {}),
    underlying: bridgeUnderlying(tuple),
    token: tuple.token,
    portal: tuple.portal,
    l2Token: tuple.l2Token,
    tuple,
  }
}

/** The deployment of parsed bridge entries that share one manifest deployment. */
export function deploymentOfTuples(
  tuples: readonly [OxideEnvTuple, ...OxideEnvTuple[]],
): OxideDeployment {
  const [first] = tuples
  return {
    label: first.version,
    ...(first.chainId ? { chainId: first.chainId } : {}),
    rollupVersion: first.rollupVersion,
    ...(first.forwardingTable ? { forwardingTable: first.forwardingTable } : {}),
    ...(first.feeToken ? { feeToken: first.feeToken } : {}),
    bridges: tuples.map(bridgeOfTuple),
    ...(first.features?.length ? { features: first.features } : {}),
  }
}

/** The bridge whose portal holds `token`: the table row a sweep of `token` reads. */
export function bridgeByToken(deployment: OxideDeployment, token: string): OxideBridge | undefined {
  return deployment.bridges.find((bridge) => sameAddress(bridge.underlying, token))
}

export function bridgeByPortal(
  deployment: OxideDeployment,
  portal: string,
): OxideBridge | undefined {
  return deployment.bridges.find((bridge) => sameAddress(bridge.portal, portal))
}

/** The bridge `feature` binds in `role`. Absent when the feature binds no bridge in that role, or one of another deployment. */
export function featureBridge(
  deployment: OxideDeployment,
  feature: Pick<OxideFeature, "bridges">,
  role: string,
): OxideBridge | undefined {
  const id = feature.bridges[role]
  return id === undefined ? undefined : deployment.bridges.find((bridge) => bridge.id === id)
}

/** The bridge of the fee token. Absent on a deployment without one, or whose fee token has no bridge. */
export function feeTokenBridge(deployment: OxideDeployment): OxideBridge | undefined {
  return deployment.feeToken ? bridgeByToken(deployment, deployment.feeToken) : undefined
}

/**
 * The token whose row a sweep for `intent` prices and settles on. A deposit settles on the row of the token it
 * funds. Every other intent settles on the fee token's row, whatever token funds it.
 */
export function sipaIntentToken(
  deployment: Pick<OxideDeployment, "feeToken">,
  intent: SipaIntentName,
  token: string,
): string {
  return intent === "deposit" ? token : deployment.feeToken ?? token
}

/** The bridge a sweep of `token` for `intent` settles on; see {@link sipaIntentToken}. */
export function sipaIntentBridge(
  deployment: OxideDeployment,
  intent: SipaIntentName,
  token: string,
): OxideBridge | undefined {
  return bridgeByToken(deployment, sipaIntentToken(deployment, intent, token))
}

export function tableRowByToken(
  table: OxideDeploymentTable,
  token: string,
): OxideTableRow | undefined {
  return table.rows.find((row) => sameAddress(row.bridge.underlying, token))
}

export function tableRowByPortal(
  table: OxideDeploymentTable,
  portal: string,
): OxideTableRow | undefined {
  return table.rows.find((row) => sameAddress(row.bridge.portal, portal))
}

export function feeTokenRow(table: OxideDeploymentTable): OxideTableRow | undefined {
  const { feeToken } = table.deployment
  return feeToken ? tableRowByToken(table, feeToken) : undefined
}

/** The row a sweep of `token` for `intent` reads, when the table prices that intent on it. */
export function sipaIntentRow(
  table: OxideDeploymentTable,
  intent: SipaIntentName,
  token: string,
): OxideTableRow | undefined {
  const row = tableRowByToken(table, sipaIntentToken(table.deployment, intent, token))
  return row?.intents[intent] ? row : undefined
}

/** What a sweep for `intent` takes off the balance: the tip plus the beneficiary fee. */
export function rowSweepFee(row: OxideTableRow, intent: SipaIntentName): bigint | undefined {
  const terms = row.intents[intent]
  return terms && terms.sweepTip + terms.beneficiaryFee
}
