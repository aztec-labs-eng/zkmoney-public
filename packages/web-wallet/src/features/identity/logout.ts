import { leavePage } from "../../platform/storage/walletStorage"
import { showReportableError } from "../../errors/errorModal"
import { campaignSignedOutUrl } from "./campaignReturn"
import { signOut } from "./signOut"

/**
 * Local sign-out. The passkey and the on-chain claim survive, so /enter brings the account back.
 * A full reload, not a route change: the front-core store singletons cache the signed-out
 * account's state and would leak it into the next account on this browser. The PXE must release
 * its OPFS handles before that reload or the next document can race them while opening its store.
 * A failed removal or shutdown is reported and nothing reloads.
 *
 * It lands on the campaign signed out of the campaign too, which is where signing up and signing
 * back in both start. A build with no campaign (a local pair, a self-hosted wallet, the e2e) keeps
 * the wallet's own route.
 */
export async function logout(stopPxe: () => Promise<void>): Promise<void> {
  try {
    await signOut()
    await stopPxe()
  } catch (e) {
    showReportableError(e, "identity:logout", { message: "Couldn't sign out. Try again." })
    return
  }
  await leavePage(campaignSignedOutUrl() || "/claim")
}
