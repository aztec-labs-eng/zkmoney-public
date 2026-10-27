import { DEFAULT_CONTRACTS, getHardcodedArtifact } from "@obsidion/sdk"
import { GOOGLE_CALLBACK_PATH } from "./features/paylink/googleAuth"
import { warmBarretenberg } from "./platform/bbWasm"
import { ACTIVE_TAB_LOCK } from "./platform/storage/activeTabLifecycle"
import { originWasFresh } from "./platform/storage/freshOrigin"
import { isPayPath } from "./ui/PxeBoot"

/** Another tab runs the wallet, so this one boots no PXE unless the visitor takes it over. */
async function walletRunsElsewhere(): Promise<boolean> {
  try {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks
    const { held = [] } = (await locks?.query()) ?? {}
    return held.some((lock) => lock.name === ACTIVE_TAB_LOCK)
  } catch {
    return false
  }
}

/** Starts what the boot waits on, as soon as the wallet chunk runs. */
export async function warmBoot(pathname: string): Promise<void> {
  // Before this page creates a wallet database of its own.
  void originWasFresh()
  // A pay page's PXE waits for a screen to need it, and the sign-in popup boots none.
  if (isPayPath(pathname) || pathname === GOOGLE_CALLBACK_PATH) return
  if (await walletRunsElsewhere()) return
  // The PXE's largest download.
  const barretenberg = warmBarretenberg()
  // A payment link's first read loads its escrow's artifact: fetched once that download is in.
  if (pathname === "/link" || pathname === "/p") {
    void barretenberg
      .then(() => getHardcodedArtifact(DEFAULT_CONTRACTS.paylinkDirect))
      .catch(() => {})
  }
}
