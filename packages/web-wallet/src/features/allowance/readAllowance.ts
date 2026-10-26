/**
 * The chain read behind the sponsored-transaction allowance, in its own module so UI fixtures can
 * replace it. It reads the instance, rail and payer that `claimSponsorContext` picks for this
 * account's sponsored batches: the instance may be a retired generation the account is still
 * subscribed on, and the payer another account of this wallet's whose note the batches spend. While
 * the account's registration is pending no instance is picked yet, so the current one answers.
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
  const payer = sponsor.payer ?? deps.account.getAddress()
  const allowance = await readClaimFpcAllowance(
    deps.wallet,
    sponsor.fpcAddress,
    sponsor.fpcArtifact,
    payer,
    sponsor.railId,
  )
  return {
    fpcAddress: sponsor.fpcAddress.toString(),
    railId: sponsor.railId,
    payer: payer.toString(),
    allowance,
  }
}
