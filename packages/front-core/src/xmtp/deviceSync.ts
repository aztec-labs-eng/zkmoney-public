/**
 * Cross-installation history for one XMTP inbox. An MLS installation only holds keys for
 * messages sent after it joined a conversation, so a payment request that reached the laptop
 * never reaches a phone installed later unless another installation hands it over.
 *
 * History exchange over the XMTP history server:
 *   - `importHistory` on a fresh installation: newest accessible archive first, then a live sync
 *     request as the fallback. A brand-new installation needs an existing device online to share
 *     the archive keys.
 *   - `startArchivePublisher` on every running installation: pushes the inbox's archive on a
 *     cadence so the import lane has something to pick up.
 *
 *   - `startHistoryImporter` keeps syncing the device sync groups, which brings in late replies.
 *
 * These are best-effort and never throw. The `local` env has no history server.
 */

export interface DeviceSyncPort {
  readonly installationId?: string | null
  sendSyncRequest(): Promise<void>
  sendSyncArchive(pin: string): Promise<void>
  processSyncArchive(pin?: string): Promise<void>
  syncAllDeviceSyncGroups(): Promise<unknown>
}

export interface DeviceSyncLogger {
  warn(message: string, ...args: unknown[]): void
}

export const ARCHIVE_PUBLISH_INTERVAL_MS = 15 * 60_000

/**
 * Pull history into a fresh installation. Must run before the inbox driver starts: archived
 * messages are older than anything live, so an advanced cursor would skip them.
 */
export async function importHistory(port: DeviceSyncPort, log: DeviceSyncLogger): Promise<void> {
  try {
    await port.syncAllDeviceSyncGroups()
    await port.processSyncArchive()
  } catch (err) {
    log.warn("[xmtp deviceSync] archive import skipped", err)
  }
  // This only sends the request. startHistoryImporter handles replies that arrive later.
  try {
    await port.sendSyncRequest()
  } catch (err) {
    log.warn("[xmtp deviceSync] sync request failed", err)
  }
}

/** Push an archive now and every `intervalMs`; returns the stop function. */
export function startArchivePublisher(
  port: DeviceSyncPort,
  log: DeviceSyncLogger,
  intervalMs = ARCHIVE_PUBLISH_INTERVAL_MS,
): () => void {
  // ponytail: full-history archive each time; add a time window if it grows past what the
  // history server tolerates (browser-sdk takes no startNs/endNs yet).
  const publish = () =>
    port
      .sendSyncArchive(`${archivePinPrefix(port)}${Date.now()}`)
      .catch((err) => log.warn("[xmtp deviceSync] archive push failed", err))
  void publish()
  const timer = setInterval(publish, intervalMs)
  return () => clearInterval(timer)
}

// Each publication's pin names the installation that sent it.
function archivePinPrefix(port: DeviceSyncPort): string {
  return `wallet:${port.installationId}:`
}

/**
 * Sync the device sync groups while the receiver runs, which brings in replies to this
 * installation's sync request that arrive late. No archive listing: the browser SDK's
 * (listAvailableArchives) panics in wasm on every call, as its archive timestamps exceed what a
 * JavaScript number holds (xmtp/libxmtp, bindings/wasm/src/device_sync.rs).
 */
export function startHistoryImporter(
  port: DeviceSyncPort,
  log: DeviceSyncLogger,
  intervalMs = 5_000,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async (): Promise<void> => {
    try {
      await port.syncAllDeviceSyncGroups()
    } catch (err) {
      log.warn("[xmtp deviceSync] history refresh failed", err)
    } finally {
      // Schedule after completion so slow syncs never overlap or build up a queue.
      if (!stopped) timer = setTimeout(() => void poll(), intervalMs)
    }
  }
  void poll()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}
