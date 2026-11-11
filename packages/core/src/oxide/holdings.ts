// A holding is a private balance on its own bridge, moved to and from its base's bridge. The
// pinned deployment's features say which holdings exist; the profile's `holdings` say which the
// wallet shows.

import type { Failure } from "../errors/index.js"
import { isWellFormedNonZeroL1Address } from "./address.js"
import { featureBridge } from "./deployment.js"
import type { OxideBridge, OxideDeployment, OxideFeature } from "./deployment.js"

interface HoldingCommon {
  /** The feature's id, e.g. `fea-sky-v6`: what the profile lists and a holding is picked by. */
  id: string
  /**
   * One literal per kind of product. `yield`: its value is an amount of its base's token, which
   * grows over time.
   */
  kind: "yield"
  /** The held bridge's L2 token: the token the holding's balance is in. */
  l2Token: string
  /** The bridge moves go to and from. */
  base: OxideBridge
  /** The bridge of the token the holding holds. */
  held: OxideBridge
  terms: "erc4626"
  /** How a move turns the base's token into the held bridge's asset and back. */
  conversion: "None" | "DaiUsds"
}

/** Each move runs through an escrow of `factory`; a move out's burn pays `withdrawalExecutor`. */
export interface SkyEscrowHolding extends HoldingCommon {
  rail: "skyEscrow"
  escrow: { factory: string; withdrawalExecutor: string }
}

/** Moves run through the deployment's `MultiStepExecutor`. */
export interface ExecutorHolding extends HoldingCommon {
  rail: "executor"
}

export type Holding = SkyEscrowHolding | ExecutorHolding

/** A feature left out, and why. */
export interface RejectedHolding extends Failure {
  /** The feature's id. */
  id: string
  /** The role, bridge or contract at fault. */
  detail: string
}

export interface DeploymentHoldings {
  /** Manifest order. */
  holdings: readonly Holding[]
  rejected: readonly RejectedHolding[]
}

/** The holdings the profile lists, one per L2 token. */
export interface HoldingCatalog {
  /** Profile order. */
  holdings: readonly Holding[]
}

const SKY_PROJECT = "sky"

/** The roles a Sky feature binds its bridges in. */
const SKY_ROLES = { base: "dai", held: "sUsds" } as const

type Problem = Omit<RejectedHolding, "id">

function roleBridge(
  deployment: OxideDeployment,
  feature: OxideFeature,
  role: string,
): OxideBridge | Problem {
  const id = feature.bridges[role]
  if (id === undefined) return { code: "holding.missingRole", detail: role }
  return (
    featureBridge(deployment, feature, role) ?? {
      code: "holding.unknownBridge",
      detail: `${role} ${id}`,
    }
  )
}

/** Sky's savings: sUSDS on its bridge, moved to and from DAI through the factory's escrows. */
function skyHolding(
  deployment: OxideDeployment,
  feature: OxideFeature,
): SkyEscrowHolding | Problem {
  const base = roleBridge(deployment, feature, SKY_ROLES.base)
  if ("code" in base) return base
  const held = roleBridge(deployment, feature, SKY_ROLES.held)
  if ("code" in held) return held
  const { skyEscrowFactory: factory, skyWithdrawalExecutor: withdrawalExecutor } = feature.contracts
  if (!isWellFormedNonZeroL1Address(factory)) {
    return { code: "holding.unusableAddress", detail: "skyEscrowFactory" }
  }
  if (!isWellFormedNonZeroL1Address(withdrawalExecutor)) {
    return { code: "holding.unusableAddress", detail: "skyWithdrawalExecutor" }
  }
  return {
    id: feature.id,
    kind: "yield",
    l2Token: held.l2Token,
    base,
    held,
    terms: "erc4626",
    conversion: "DaiUsds",
    rail: "skyEscrow",
    escrow: { factory, withdrawalExecutor },
  }
}

/**
 * Every holding `deployment` lists, one per usable Sky feature. A deployment keeps a feature listed
 * after it moves to a new id, so several can hold one token; the catalog shows one. A malformed
 * feature is rejected with its reason.
 */
export function deploymentHoldings(deployment: OxideDeployment): DeploymentHoldings {
  const holdings: Holding[] = []
  const rejected: RejectedHolding[] = []
  for (const feature of deployment.features ?? []) {
    if (feature.project !== SKY_PROJECT) continue
    const read = skyHolding(deployment, feature)
    if ("code" in read) rejected.push({ id: feature.id, ...read })
    else holdings.push(read)
  }
  return { holdings, rejected }
}

const RAIL_RANK = { executor: 0, skyEscrow: 1 } as const

/**
 * The `holdings` the profile's `listed` ids name, in its order, one per L2 token: an executor
 * holding takes the line from an escrow one, else the first listed keeps it.
 */
export function holdingCatalog(
  holdings: readonly Holding[],
  listed: readonly string[],
): HoldingCatalog {
  const lines = new Map<string, Holding>()
  for (const id of listed) {
    const holding = holdings.find((h) => h.id === id)
    if (!holding) continue
    const token = holding.l2Token.toLowerCase()
    const prior = lines.get(token)
    if (!prior || RAIL_RANK[holding.rail] < RAIL_RANK[prior.rail]) lines.set(token, holding)
  }
  return { holdings: [...lines.values()] }
}
