import type { CandidateProbe } from "../core/services/resolveRecoveredMsk"
import { deriveBootstrapKey } from "./oxideAccountKeys"
import {
  OxideIdentityUnavailableError,
  resolveOxideIdentity,
  type OxideIdentityDeps,
} from "./oxideIdentityGeneration"

export function registryCandidateProbe(deps: OxideIdentityDeps): CandidateProbe {
  return async (msk, l2Address) => {
    const outcome = await resolveOxideIdentity(deps, deriveBootstrapKey(msk).address, l2Address)
    if (outcome.kind === "no-generation") {
      throw new OxideIdentityUnavailableError(
        "no published generation binds this deployment's name registry on this rollup",
      )
    }
    // An inconclusive key reads absent too: the key that does anchor still resolves, and a key
    // left unresolved is refused, never offered a name claim.
    return outcome.kind === "verified" ? "anchored" : "absent"
  }
}
