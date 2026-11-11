// A deployment can replace its SIPA contracts in place. Each address a wallet handed out commits to the set it was
// derived under, so the wallet keeps every set: the entry's own, then the ones its `revisions` record.

import type { OxideEnvTuple, SipaGeneration } from "../types/index.js"
import { L1_ADDRESS } from "./address.js"

const FIELDS = [
  "sipaFactory",
  "forwardingTable",
  "depositSIPAImplementation",
  "registrationSIPAImplementation",
  "depositSubsidy",
] as const

type Field = (typeof FIELDS)[number]
type State = Partial<Record<Field, string>>

const same = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function generationOf(state: State): SipaGeneration | undefined {
  if (!state.sipaFactory) return undefined
  const generation: SipaGeneration = { sipaFactory: state.sipaFactory }
  for (const field of FIELDS) if (state[field]) generation[field] = state[field]
  return generation
}

const generationKey = (generation: SipaGeneration): string =>
  FIELDS.map((field) => generation[field]?.toLowerCase() ?? "").join(":")

/** `value` as a field value: a string for an address, undefined for null, false when malformed. */
function fieldValue(value: unknown): string | undefined | false {
  if (value === null) return undefined
  return typeof value === "string" && L1_ADDRESS.test(value) ? value : false
}

/** The state before `revision`, or null when the revision is malformed. */
function undo(
  state: State,
  revision: unknown,
  newerMs: number,
  bridgeId: string | undefined,
): { state: State; ms: number } | null {
  if (!isRecord(revision) || typeof revision.updatedAt !== "string") return null
  const ms = Date.parse(revision.updatedAt)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(revision.updatedAt) || !(ms < newerMs)) return null
  const before: State = { ...state }
  const apply = (source: Record<string, unknown>, field: Field): boolean => {
    if (!(field in source)) return true
    const value = fieldValue(source[field])
    if (value === false) return false
    if (value === undefined) delete before[field]
    else before[field] = value
    return true
  }
  if (!FIELDS.every((field) => apply(revision, field))) return null
  if (revision.bridges === undefined) return { state: before, ms }
  if (!Array.isArray(revision.bridges)) return null
  for (const bridge of revision.bridges) {
    if (!isRecord(bridge) || typeof bridge.bridgeId !== "string" || !bridgeId) return null
    if (bridge.bridgeId === bridgeId && !apply(bridge, "depositSubsidy")) return null
  }
  return { state: before, ms }
}

/**
 * The SIPA sets earlier publishes of `entry` served, newest first. A revision lists only the values the next publish
 * overwrote or removed, so each set is rebuilt by undoing the revisions from the entry back. A malformed revision ends
 * that: the sets after it stand, and the older ones are unknown.
 */
export function parsePriorSipaGenerations(
  entry: Record<string, unknown>,
  updatedMs: number,
): readonly SipaGeneration[] {
  const revisions = entry.revisions
  if (revisions === undefined) return Object.freeze([])
  if (!Array.isArray(revisions)) {
    console.warn("[oxide] manifest revisions is not an array; earlier SIPA sets are unknown")
    return Object.freeze([])
  }
  const bridgeId = typeof entry.bridgeId === "string" ? entry.bridgeId : undefined
  let state: State = {}
  for (const field of FIELDS) {
    const value = fieldValue(entry[field])
    if (value) state[field] = value
  }
  const current = generationOf(state)
  const seen = new Set(current ? [generationKey(current)] : [])
  const prior: SipaGeneration[] = []
  let newerMs = updatedMs
  for (let i = revisions.length - 1; i >= 0; i--) {
    const undone = undo(state, revisions[i], newerMs, bridgeId)
    if (!undone) {
      console.warn(`[oxide] manifest revisions[${i}] is malformed; older SIPA sets are unknown`)
      break
    }
    ;({ state, ms: newerMs } = undone)
    const generation = generationOf(state)
    if (!generation || seen.has(generationKey(generation))) continue
    seen.add(generationKey(generation))
    prior.push(Object.freeze(generation))
  }
  return Object.freeze(prior)
}

/** Every SIPA set of the tuple's deployment: the current one first, then earlier ones, newest first. */
export function sipaGenerations(tuple: OxideEnvTuple): SipaGeneration[] {
  const current = generationOf(tuple)
  return [...(current ? [current] : []), ...(tuple.priorSipaGenerations ?? [])]
}

/**
 * The set a SIPA was derived under, by its factory and table. Sets sharing both differ in an implementation, which
 * then decides.
 */
export function sipaGenerationOf(
  tuple: OxideEnvTuple,
  origin: { sipaFactory: string; forwardingTable?: string; implementation?: string },
): SipaGeneration | undefined {
  const matches = sipaGenerations(tuple).filter(
    (generation) =>
      same(generation.sipaFactory, origin.sipaFactory) &&
      (origin.forwardingTable === undefined ||
        same(generation.forwardingTable, origin.forwardingTable)),
  )
  return (
    matches.find(
      (generation) =>
        same(generation.depositSIPAImplementation, origin.implementation) ||
        same(generation.registrationSIPAImplementation, origin.implementation),
    ) ?? matches[0]
  )
}
