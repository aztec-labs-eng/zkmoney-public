import type { OxideDeployment } from "@obsidion/core/oxide"
import type { OxideFeature } from "@obsidion/core/types"
import type { FeatureRegistry, FeaturesOf, OxideRole, ResolvedFeaturesOf } from "./define.js"
import { resolveOxideRole, type RoleProblemCode } from "./oxideRole.js"
import { FEATURES } from "./registry.js"

export interface RoleProblem {
  feature: string
  role: string
  code: RoleProblemCode
  detail: string
  /** A required role: the whole feature is off. */
  featureOff: boolean
}

/**
 * Binds every role to the pinned deployment's Oxide feature. A required role that fails turns its
 * feature off; an optional one reaches the feature as missing. Every failure is reported, so the
 * authoring gate can refuse any of them.
 */
export function resolveFeatureRoles<R extends FeatureRegistry = typeof FEATURES>(
  features: FeaturesOf<R>,
  deployment: OxideDeployment,
  registry: R = FEATURES as unknown as R,
): { features: ResolvedFeaturesOf<R>; problems: RoleProblem[] } {
  const resolved: Record<string, unknown> = {}
  const problems: RoleProblem[] = []
  for (const [id, entry] of Object.entries(features) as [
    string,
    { oxide: Record<string, string> },
  ][]) {
    const definition = registry.find((d) => d.id === id)
    if (!definition) continue
    const oxide: Record<string, OxideFeature> = {}
    let off = false
    for (const [role, declared] of Object.entries<OxideRole>(definition.oxide ?? {})) {
      const bound = entry.oxide[role]
      if (bound === undefined) continue
      const result = resolveOxideRole(deployment, declared, bound)
      if ("code" in result) {
        const featureOff = !declared.optional
        off ||= featureOff
        problems.push({ feature: id, role, ...result, featureOff })
      } else oxide[role] = result
    }
    if (!off) resolved[id] = { ...entry, oxide }
  }
  return { features: resolved as ResolvedFeaturesOf<R>, problems }
}
