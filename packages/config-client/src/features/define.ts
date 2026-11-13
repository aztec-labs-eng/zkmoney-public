import type { z } from "zod"
import type { OxideFeature } from "@obsidion/core/types"
import type { ProfileNetwork } from "../schema.js"

/** An Oxide feature of the pinned deployment that a wallet feature can bind. */
export interface OxideRole {
  /** The Etherplan project that must have deployed it. */
  project: string
  /** Contracts it must name, each a non-zero L1 address. */
  contracts?: readonly string[]
  /** Bridge roles it must bind to a bridge of the deployment. */
  bridges?: readonly string[]
  /** The wallet feature still runs without it; its own logic decides what is lost. */
  optional?: boolean
}

export type OxideRoles = Readonly<Record<string, OxideRole>>

export interface FeatureContext {
  network: ProfileNetwork
  l1ChainId: number
}

export interface FeatureIssue {
  message: string
  path: (string | number)[]
}

export type FeaturePath = (string | number)[]

/** A contract a feature names, by where the payload names it. */
export interface ContractRef {
  path: FeaturePath
  address: string
}

/** What a feature names on chains, for the publisher's live checks. */
export interface FeatureChainRefs {
  /** Contracts on the profile's L1. */
  l1Contracts: ContractRef[]
  /** Other chains, each by the RPC the feature names for it. */
  chains: {
    path: FeaturePath
    chainId: number
    rpcUrl: string
    contracts: ContractRef[]
    /** ERC-20s, with the symbol the feature shows them by. */
    tokens: (ContractRef & { symbol: string })[]
  }[]
}

export interface FeatureDefinition<
  Id extends string = string,
  Schema extends z.ZodType = z.ZodType,
  Roles extends OxideRoles = OxideRoles,
> {
  id: Id
  /** The payload without `oxide`. A strict object, so the authoring gate catches a stray key. */
  schema: Schema
  oxide?: Roles
  /** Rules across the parsed payload that the schema cannot state. */
  check?: (payload: z.infer<Schema>, context: FeatureContext) => FeatureIssue[]
  /** What the payload names on chains; absent for a feature that names none. */
  onChain?: (payload: z.infer<Schema>) => FeatureChainRefs
}

export function defineFeature<
  const Id extends string,
  Schema extends z.ZodType,
  const Roles extends OxideRoles = Record<never, OxideRole>,
>(definition: FeatureDefinition<Id, Schema, Roles>): FeatureDefinition<Id, Schema, Roles> {
  return definition
}

export type AnyFeatureDefinition = FeatureDefinition<string, z.ZodType, any>
export type FeatureRegistry = readonly AnyFeatureDefinition[]

type RolesOf<D> = D extends FeatureDefinition<string, z.ZodType, infer R> ? R : never
type PayloadOf<D> = D extends FeatureDefinition<string, infer S, OxideRoles> ? z.infer<S> : never
type OptionalRoles<R> = { [K in keyof R]: R[K] extends { optional: true } ? K : never }[keyof R]
type RequiredRoles<R> = Exclude<keyof R, OptionalRoles<R>>

/** A feature as the document states it: its payload, and the Oxide feature id bound to each role. */
export type FeatureEntry<D> = PayloadOf<D> & {
  oxide: { [K in RequiredRoles<RolesOf<D>>]: string } & {
    [K in OptionalRoles<RolesOf<D>>]?: string
  }
}

/** A feature with each role resolved against the pinned deployment. */
export type ResolvedFeature<D> = PayloadOf<D> & {
  oxide: { [K in RequiredRoles<RolesOf<D>>]: OxideFeature } & {
    [K in OptionalRoles<RolesOf<D>>]?: OxideFeature
  }
}

export type FeaturesOf<R extends FeatureRegistry> = {
  [D in R[number] as D["id"]]?: FeatureEntry<D>
}

export type ResolvedFeaturesOf<R extends FeatureRegistry> = {
  [D in R[number] as D["id"]]?: ResolvedFeature<D>
}
