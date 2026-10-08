/**
 * The wallet half of `walletPresence.ts` in `@obsidion/passkey-web`: the campaign's queue page
 * reads the flag written here and offers "Open wallet" rather than "Buy" to a user who already
 * started in this browser's wallet.
 */
import { PendingRegistrationStore, isTerminalRegistrationPhase } from "@obsidion/front-core"
import { sharedCookieDomain, walletPresenceCookie } from "@obsidion/passkey-web"
import { getConfig } from "../../config/env"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { walletStorage } from "../../platform/storage/walletStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { loadWalletIdentity } from "./walletIdentity"

const pendingStore = () => PendingRegistrationStore.get(webStorage)

/**
 * An entered account, or a registration still under way. A record lives under the active account:
 * the deposit screen's log-out keeps that pointer so the registration resumes, a full sign-out
 * drops it, and the in-memory list outlives both.
 */
function started(): boolean {
  if (loadWalletIdentity() !== null) return true
  if (getActiveStorageId() === null) return false
  return pendingStore()
    .list()
    .some((r) => !isTerminalRegistrationPhase(r.phase))
}

/** Never throws: a sign-out or a registration must not fail over it. */
function publishWalletPresence(): void {
  try {
    const campaignUrl = getConfig().campaignUrl
    if (!campaignUrl) return
    const domain = sharedCookieDomain(location.hostname, new URL(campaignUrl).hostname)
    if (domain === null) return
    document.cookie = walletPresenceCookie(started(), domain, location.protocol === "https:")
  } catch (err) {
    console.warn("[walletPresence] not published", err)
  }
}

/** Publishes now and on every change it reads: a registration record, or a committed session write. */
export function watchWalletPresence(): () => void {
  publishWalletPresence()
  const offRecords = pendingStore().onListChanged(publishWalletPresence)
  const offCommits = walletStorage.onCommit(publishWalletPresence)
  return () => {
    offRecords()
    offCommits()
  }
}
