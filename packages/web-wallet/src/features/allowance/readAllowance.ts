/**
 * The chain read behind the sponsored-transaction allowance, in its own module so UI fixtures can
 * replace it. It reads the instance and rail that `claimSponsorContext` picks for this account's
 * sponsored batches, which may be a retired generation the account is still subscribed on. While the
 * account's registration is pending no instance is picked yet, so the current one answers.
 */
import { readClaimFpcAllowance, type ClaimSponsorContext } from "@obsidion/sdk"
import type { AllowanceRead } from "@obsidion/front-core"
import {
  claimSponsorContext,
  claimSponsorRail,
  type ClaimSponsorDeps,
} from "../onboarding/claimSponsorship"
import { RegistrationPendingError } from "../onboarding/registrationRail"
import { RAIL_REGISTERED } from "../onboarding/rails"

export async function readSponsoredAllowance(deps: ClaimSponsorDeps): Promise<AllowanceRead> {
  let sponsor: ClaimSponsorContext
  try {
    sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)
  } catch (error) {
    if (!(error instanceof RegistrationPendingError)) throw error
    sponsor = (await claimSponsorRail(deps, RAIL_REGISTERED)).sponsor
  }
  const allowance = await readClaimFpcAllowance(
    deps.wallet,
    sponsor.fpcAddress,
    sponsor.fpcArtifact,
    deps.account.getAddress(),
    sponsor.railId,
  )
  return { fpcAddress: sponsor.fpcAddress.toString(), railId: sponsor.railId, allowance }
}
