// A holding is a private balance on its own bridge, moved to and from its base's bridge. The
// pinned deployment's features say which holdings exist: a `sky` feature is Sky's savings, moved
// through an escrow per move; a `position` feature is a vault, moved through the deployment's one
// `multistep` executor. A savings portal the profile names under its own id is a vault too. The profile's
// `holdings` say which the wallet shows. A profile that names none shows Sky's savings on the
// pinned bridge, unless its savings portals leave them out.

import type { Failure } from "../errors/index.js"
import { isWellFormedNonZeroL1Address } from "./address.js"
import { bridgeByPortal, featureBridge } from "./deployment.js"
import type { OxideBridge, OxideDeployment, OxideFeature } from "./deployment.js"

/** How a holding's token takes and returns its base's asset. */
export const TERMS_KINDS = ["erc4626"] as const
export type TermsKind = (typeof TERMS_KINDS)[number]

/** How a move turns the base's token into the held bridge's asset and back. */
export const CONVERSION_KINDS = ["None", "DaiUsds", "Psm"] as const
export type ConversionKind = (typeof CONVERSION_KINDS)[number]

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
  terms: TermsKind
  conversion: ConversionKind
}

/** Each move runs through an escrow of `factory`; a move out's burn pays `withdrawalExecutor`. */
export interface SkyEscrowHolding extends HoldingCommon {
  rail: "skyEscrow"
  escrow: { factory: string; withdrawalExecutor: string }
}

/** The deployment's `MultiStepExecutor`, from its `multistep` feature. */
export interface MultiStepExecutor {
  /** The feature's id. */
  id: string
  address: string
  /** Each usable `<kind>Adapter` contract of the feature, by kind, e.g. `erc4626`. */
  adapters: Readonly<Record<string, string>>
}

/** Moves run through the deployment's `MultiStepExecutor`. */
export interface ExecutorHolding extends HoldingCommon {
  rail: "executor"
  executor: MultiStepExecutor
}

export type Holding = SkyEscrowHolding | ExecutorHolding

/** A feature left out, and why. */
export interface RejectedHolding extends Failure {
  /** The feature's id. */
  id: string
  /** The role, bridge, contract or value at fault. */
  detail: string
}

export interface DeploymentHoldings {
  /** Manifest order. */
  holdings: readonly Holding[]
  rejected: readonly RejectedHolding[]
  /** The id of the holding a profile that names none lists. */
  listedByDefault?: string
}

/** The holdings the wallet lists, one per L2 token. */
export interface HoldingCatalog {
  /** Profile order. */
  holdings: readonly Holding[]
}

/** The manifest project of Sky's features. */
export const SKY_PROJECT = "sky"

/** The roles a Sky feature binds its bridges in. */
export const SKY_ROLES = { base: "dai", held: "sUsds" } as const

/** The manifest project of a vault's feature. The manifest's id of one is `fea-vault-<tag>`. */
export const VAULT_PROJECT = "position"

/** The roles a vault feature binds its bridges in. */
export const VAULT_ROLES = { base: "main", held: "position" } as const

/** The manifest project of the deployment's `MultiStepExecutor` and its adapters. */
export const EXECUTOR_PROJECT = "multistep"

/** The executor adapters a vault's moves run through, beside its terms' and its conversion's. */
const MOVE_ADAPTERS = ["portalDeposit"] as const

const TERMS_ADAPTERS: Readonly<Record<TermsKind, readonly string[]>> = { erc4626: ["erc4626"] }

/** The executor adapters each conversion steps through. */
export const CONVERSION_ADAPTERS: Readonly<Record<ConversionKind, readonly string[]>> = {
  None: [],
  DaiUsds: ["skyConverter"],
  Psm: ["makerPsm", "uniswapV3"],
}

const VAULT_ID = /^fea-vault-./
const ADAPTER_CONTRACT = /^(.+)Adapter$/

type Problem = Omit<RejectedHolding, "id">

const isMember = <T extends string>(values: readonly T[], value: unknown): value is T =>
  (values as readonly unknown[]).includes(value)

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

function multiStepExecutor(feature: OxideFeature): MultiStepExecutor | Problem {
  const { multiStepExecutor: address } = feature.contracts
  if (!isWellFormedNonZeroL1Address(address)) {
    return { code: "holding.unusableAddress", detail: "multiStepExecutor" }
  }
  const adapters: Record<string, string> = {}
  for (const [name, adapter] of Object.entries(feature.contracts)) {
    const kind = ADAPTER_CONTRACT.exec(name)?.[1]
    if (kind !== undefined && isWellFormedNonZeroL1Address(adapter)) adapters[kind] = adapter
  }
  return { id: feature.id, address, adapters }
}

/**
 * The deployment's executor, or why it has none. Two `multistep` features reject both: a move must
 * not guess which executor its route runs on.
 */
function deploymentExecutor(
  features: readonly OxideFeature[],
  rejected: RejectedHolding[],
): MultiStepExecutor | Problem {
  const all = features.filter((feature) => feature.project === EXECUTOR_PROJECT)
  if (all.length > 1) {
    const detail = all.map((feature) => feature.id).join(", ")
    for (const { id } of all) rejected.push({ id, code: "holding.duplicateExecutor", detail })
    return { code: "holding.noExecutor", detail }
  }
  const [feature] = all
  if (!feature) return { code: "holding.noExecutor", detail: EXECUTOR_PROJECT }
  const read = multiStepExecutor(feature)
  if (!("code" in read)) return read
  rejected.push({ id: feature.id, ...read })
  return { code: "holding.noExecutor", detail: feature.id }
}

/** A vault: its shares on their bridge, moved to and from its base through the executor. */
function vaultHolding(
  deployment: OxideDeployment,
  feature: OxideFeature,
  executor: MultiStepExecutor | Problem,
  named: boolean,
): ExecutorHolding | Problem {
  if (!named && !VAULT_ID.test(feature.id)) {
    return { code: "holding.unsupported", detail: feature.id }
  }
  const base = roleBridge(deployment, feature, VAULT_ROLES.base)
  if ("code" in base) return base
  const held = roleBridge(deployment, feature, VAULT_ROLES.held)
  if ("code" in held) return held
  const { conversion } = feature.variables
  if (!isMember(CONVERSION_KINDS, conversion)) {
    return { code: "holding.unsupported", detail: `conversion ${String(conversion)}` }
  }
  if ("code" in executor) return executor
  const terms = "erc4626"
  const needs = [...MOVE_ADAPTERS, ...TERMS_ADAPTERS[terms], ...CONVERSION_ADAPTERS[conversion]]
  const missing = needs.find((kind) => executor.adapters[kind] === undefined)
  if (missing !== undefined) {
    return { code: "holding.unusableAddress", detail: `${executor.id} ${missing}Adapter` }
  }
  return {
    id: feature.id,
    kind: "yield",
    l2Token: held.l2Token,
    base,
    held,
    terms,
    conversion,
    rail: "executor",
    executor,
  }
}

/**
 * A savings portal the profile names: `portal`'s token held over `base`'s. An entry lasts as long
 * as an account may hold its shares: without it the holding and its open moves are gone.
 */
export interface SavingsPortal {
  /** The holding's id: a manifest holding feature's, or a name the profile gives it. */
  id: string
  portal: string
  base: string
  /** A {@link ConversionKind}; another value is rejected as unsupported. */
  conversion: string
}

/** The vault feature of each of `savings` that no manifest feature has the id of. */
function namedVaults(
  deployment: OxideDeployment,
  savings: readonly SavingsPortal[],
): OxideFeature[] {
  const manifest = deployment.features ?? []
  return savings.flatMap(({ id, portal, base, conversion }) => {
    const held = bridgeByPortal(deployment, portal)?.id
    const main = bridgeByPortal(deployment, base)?.id
    if (!held || !main || manifest.some((feature) => feature.id === id)) return []
    return [
      {
        id,
        project: VAULT_PROJECT,
        bridges: { [VAULT_ROLES.base]: main, [VAULT_ROLES.held]: held },
        contracts: {},
        variables: { conversion },
      },
    ]
  })
}

/**
 * Every holding `deployment` lists: one per usable Sky or vault feature, and one per vault of
 * `savings`, the profile's savings portals, under the id the profile gives it. An entry whose
 * portals the deployment lacks adds none. One that names a manifest feature keeps that feature's
 * holding, and is rejected when the feature is no holding or its portals differ. A deployment
 * keeps a feature listed after it moves to a new id, so several can hold one token. The catalog
 * shows one. A malformed feature is rejected with its reason and never hides another.
 */
export function deploymentHoldings(
  deployment: OxideDeployment,
  savings: readonly SavingsPortal[] = [],
): DeploymentHoldings {
  const named = namedVaults(deployment, savings)
  const features = [...(deployment.features ?? []), ...named]
  const holdings: Holding[] = []
  const rejected: RejectedHolding[] = []
  const executor = features.some((feature) => feature.project === VAULT_PROJECT)
    ? deploymentExecutor(features, rejected)
    : undefined
  for (const feature of features) {
    const own = named.includes(feature)
    const entry = own ? undefined : savings.find(({ id }) => id === feature.id)
    const read =
      feature.project === SKY_PROJECT
        ? skyHolding(deployment, feature)
        : feature.project === VAULT_PROJECT && executor
        ? vaultHolding(deployment, feature, executor, own)
        : undefined
    if (read === undefined) {
      if (entry) rejected.push({ id: feature.id, code: "holding.unsupported", detail: feature.id })
    } else if ("code" in read) {
      rejected.push({ id: feature.id, ...read })
    } else {
      holdings.push(read)
      const differs = !entry
        ? undefined
        : bridgeByPortal(deployment, entry.portal) !== read.held
        ? "portal"
        : bridgeByPortal(deployment, entry.base) !== read.base
        ? "base"
        : undefined
      if (entry && differs) {
        const detail = `${differs} ${entry[differs]}`
        rejected.push({ id: feature.id, code: "holding.unknownBridge", detail })
      }
    }
  }
  return { holdings, rejected }
}

/**
 * The pinned deployment's holdings, and the one a profile that names none lists: the first Sky
 * feature's, when it is usable and its base is the pinned bridge. A wallet whose profile carries
 * no list offers those savings, and no later Sky feature or other product in their place. With
 * `savings`, the profile's savings portals, Sky's savings are the default only when `savings`
 * names them.
 */
export function pinnedHoldings(
  { deployment, pinned }: { deployment: OxideDeployment; pinned: OxideBridge },
  savings?: readonly SavingsPortal[],
): DeploymentHoldings {
  const read = deploymentHoldings(deployment, savings)
  const first = deployment.features?.find((feature) => feature.project === SKY_PROJECT)
  const sky = read.holdings.find((holding) => holding.id === first?.id)
  if (!sky || sky.base.portal.toLowerCase() !== pinned.portal.toLowerCase()) return read
  if (savings && !savings.some(({ id }) => id === sky.id)) return read
  return { ...read, listedByDefault: sky.id }
}

const RAIL_RANK = { executor: 0, skyEscrow: 1 } as const

/**
 * The holdings the wallet lists, one per L2 token: those the profile's `listed` ids name, in its
 * order, where an empty list names none. A profile without a list takes the deployment's default.
 * An executor holding takes the line from an escrow one, else the first listed keeps it.
 */
export function holdingCatalog(
  deployment: DeploymentHoldings,
  listed: readonly string[] | undefined,
): HoldingCatalog {
  const { listedByDefault } = deployment
  const ids = listed ?? (listedByDefault === undefined ? [] : [listedByDefault])
  const lines = new Map<string, Holding>()
  for (const id of ids) {
    const holding = deployment.holdings.find((h) => h.id === id)
    if (!holding) continue
    const token = holding.l2Token.toLowerCase()
    const prior = lines.get(token)
    if (!prior || RAIL_RANK[holding.rail] < RAIL_RANK[prior.rail]) lines.set(token, holding)
  }
  return { holdings: [...lines.values()] }
}
