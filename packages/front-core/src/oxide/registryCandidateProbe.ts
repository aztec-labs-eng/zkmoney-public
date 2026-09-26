import type { Address } from "viem"
import type { CandidateProbe } from "../core/services/resolveRecoveredMsk"
import { deriveBootstrapKey } from "./oxideAccountKeys"
import {
  OxideIdentityUnavailableError,
  resolveOxideIdentity,
  type IdentityGeneration,
  type IdentityGenerationReads,
} from "./oxideIdentityGeneration"

export function registryCandidateProbe(deps: {
  reader: IdentityGenerationReads
  catalog: readonly IdentityGeneration[]
  registry: Address
  rollupVersion: string
}): CandidateProbe {
  return async (msk, l2Address) => {
    const outcome = await resolveOxideIdentity(deps, deriveBootstrapKey(msk).address, l2Address)
    if (outcome.kind === "no-generation") {
      throw new OxideIdentityUnavailableError(
        "no published generation binds this deployment's name registry on this rollup",
      )
    }
    return outcome.kind === "verified" ? "anchored" : "absent"
  }
}
