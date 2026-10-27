import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { CandidateProbe } from "../core/services/resolveRecoveredMsk"
import { deriveBootstrapKey } from "./oxideAccountKeys"
import {
  OxideIdentityUnavailableError,
  resolveOxideIdentity,
  type L2AddressOn,
  type OxideIdentityDeps,
} from "./oxideIdentityGeneration"

/** `retiredAddressFor` gives a candidate's address on each retired rollup; see `resolveOxideIdentity`. */
export function registryCandidateProbe(
  deps: OxideIdentityDeps,
  retiredAddressFor?: (msk: Fr, l2Address: string) => L2AddressOn,
): CandidateProbe {
  return async (msk, l2Address) => {
    const outcome = await resolveOxideIdentity(
      deps,
      deriveBootstrapKey(msk).address,
      l2Address,
      retiredAddressFor?.(msk, l2Address),
    )
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
