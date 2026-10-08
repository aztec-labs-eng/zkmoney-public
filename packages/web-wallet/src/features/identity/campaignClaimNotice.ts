/**
 * The wallet half of the campaign's reminder stop (front-core `CampaignClaimNotices`): every path
 * that sees a name confirmed on chain owes the notice, and the loop delivers it with the unlocked
 * session's bootstrap key. Best-effort by construction: a campaign outage never reaches the
 * registration that owed the notice.
 */
import {
  CampaignClaimNoticeStore,
  deliverCampaignClaimNotices,
  type CampaignClaimSigner,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { campaignClaimNoticesWriteLock } from "../../platform/storage/contactsLock"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

const OWED_EVENT = "webwallet:campaign-claim-notice-owed"
/** How often an owed notice looks for a signer: the backoff lives on each notice. */
const RECHECK_MS = 30_000

const claimNotices = () => new CampaignClaimNoticeStore(webStorage, campaignClaimNoticesWriteLock)

/** Owes the notice for a name the Registry holds for `l2Address`. Never throws. */
export async function oweCampaignClaimNotice(subject: {
  l2Address: string
  tag: string
}): Promise<void> {
  if (!getConfig().campaignUrl) return
  try {
    await claimNotices().owe(subject)
    window.dispatchEvent(new Event(OWED_EVENT))
  } catch (err) {
    console.warn("[campaignClaimNotice] owing the claim notice failed:", err)
  }
}

/**
 * Delivers owed notices while the tab is visible: at start, when one is owed, on return to the tab,
 * and every {@link RECHECK_MS} while any is owed, which is how a locked session's notice goes out
 * after the unlock. Only the active tab mounts it, and it holds the wallet database, so no other
 * tab owes one meanwhile. Passes are single-flight. `signerFor` answers with the bootstrap key of
 * an unlocked session that owns the account.
 */
export function startCampaignClaimNoticeLoop(
  signerFor: (l2Address: string) => Promise<CampaignClaimSigner | null>,
): () => void {
  const campaignUrl = getConfig().campaignUrl
  if (!campaignUrl) return () => {}
  let disposed = false
  let running = false
  let rerun = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const run = async () => {
    if (disposed || document.visibilityState === "hidden") return
    if (running) {
      rerun = true
      return
    }
    running = true
    clearTimeout(timer)
    let owed = 1
    try {
      owed = await deliverCampaignClaimNotices({ store: claimNotices(), campaignUrl, signerFor })
    } catch (err) {
      console.warn("[campaignClaimNotice] delivery pass failed:", err)
    } finally {
      running = false
    }
    if (rerun) {
      rerun = false
      void run()
    } else if (owed > 0 && !disposed) {
      timer = setTimeout(() => void run(), RECHECK_MS)
    }
  }

  const kick = () => void run()
  const onVisibility = () => {
    if (document.visibilityState === "hidden") clearTimeout(timer)
    else kick()
  }
  window.addEventListener(OWED_EVENT, kick)
  document.addEventListener("visibilitychange", onVisibility)
  kick()

  return () => {
    disposed = true
    clearTimeout(timer)
    window.removeEventListener(OWED_EVENT, kick)
    document.removeEventListener("visibilitychange", onVisibility)
  }
}
