import { featureBridge, isAllZeroHex, type OxideDeployment } from "@obsidion/core/oxide"
import type { OxideFeature } from "@obsidion/core/types"
import type { OxideRole } from "./define.js"

export type RoleProblemCode =
  | "role.unknownFeature"
  | "role.wrongProject"
  | "role.missingContract"
  | "role.missingBridge"

const L1_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** The Oxide feature `id` names for `role` in `deployment`, or why it cannot serve it. */
export function resolveOxideRole(
  deployment: OxideDeployment,
  role: OxideRole,
  id: string,
): { code: RoleProblemCode; detail: string } | OxideFeature {
  const feature = deployment.features?.find((f) => f.id === id)
  if (!feature) return { code: "role.unknownFeature", detail: id }
  if (feature.project !== role.project)
    return { code: "role.wrongProject", detail: `${id} is ${feature.project}, not ${role.project}` }
  for (const name of role.contracts ?? []) {
    const address = feature.contracts[name]
    if (!address || !L1_ADDRESS.test(address) || isAllZeroHex(address))
      return { code: "role.missingContract", detail: `${id} has no usable ${name}` }
  }
  for (const name of role.bridges ?? [])
    if (!featureBridge(deployment, feature, name))
      return { code: "role.missingBridge", detail: `${id} binds no deployment bridge as ${name}` }
  return feature
}
