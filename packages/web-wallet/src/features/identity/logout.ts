import { stopSession } from "../../session/session"
import type { Store } from "@obsidion/front-core"
import { leavePage } from "../../platform/storage/walletStorage"
import { showReportableError } from "../../errors/errorModal"
import { signOut, type SignOutPage } from "./signOut"

const FAILED = "Couldn't sign out. Try again."

/**
 * Local sign-out. The passkey and the on-chain claim survive, so /enter brings the account back.
 * A full reload, not a route change: the front-core store singletons cache the signed-out
 * account's state and would leak it into the next account on this browser. The PXE must release
 * its OPFS handles before that reload or the next document can race them while opening its store.
 * A failed removal is reported and the page stays. Once the removal commits, the page holds until
 * it reloads, so a failed shutdown is reported with a retry.
 */
export async function logout(
  page: SignOutPage & { leaving: Store<boolean> },
  stopPxe: () => Promise<void>,
): Promise<void> {
  // The cleared identity must not route this page to /claim before the reload does.
  page.leaving.set(true)
  try {
    await signOut(page)
  } catch (e) {
    page.leaving.set(false)
    showReportableError(e, "identity:logout", { message: FAILED })
    return
  }
  await leave(stopPxe)
}

async function leave(stopPxe: () => Promise<void>): Promise<void> {
  try {
    await stopPxe()
  } catch (e) {
    showReportableError(e, "identity:logout", {
      message: FAILED,
      retry: { label: "Try again", run: () => void leave(stopPxe) },
    })
    return
  }
  stopSession()
  await leavePage("/claim")
}
