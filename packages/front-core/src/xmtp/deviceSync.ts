/**
 * Cross-installation history for one XMTP inbox. An MLS installation only holds keys for
 * messages sent after it joined a conversation, so a payment request that reached the laptop
 * never reaches a phone installed later unless another installation hands it over.
 *
 * History exchange over the XMTP history server:
 *   - `importHistory` on a fresh installation: newest accessible archive first, then a live sync request as the fallback.
 *     A brand-new installation needs an existing device online to share the archive keys.
 *   - `startArchivePublisher` on every running installation: pushes the inbox's archive on a
 *     cadence so the import lane has something to pick up.
 *
 *   - `startHistoryImporter` processes late replies and asks the receiver to replay older messages.
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

export interface HistorySyncPort extends DeviceSyncPort {
  /** Newest first, as returned by the SDK. */
  listSyncArchivePins(): Promise<string[]>
}

export interface DeviceSyncLogger {
  warn(message: string, ...args: unknown[]): void
}

export const ARCHIVE_PUBLISH_INTERVAL_MS = 15 * 60_000

/**
 * A browser SDK whose archive listing always throws would otherwise log a panic on every poll.
 * After this many consecutive failures the importer stops asking and relies on the live sync
 * request, which carries the same replies.
 */
export const ARCHIVE_LIST_FAILURE_LIMIT = 3

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

// Mark our own publications: archive listings can expose only pins, not sender ids.
function archivePinPrefix(port: DeviceSyncPort): string {
  return `wallet:${port.installationId}:`
}

/**
 * Import late replies and newly published archives while the receiver runs. The SDK may import
 * a live reply itself, but does not expose import completion consistently on both platforms.
 * Explicitly importing by pin gives the receiver a completion boundary for cursor replay.
 */
export function startHistoryImporter(
  port: HistorySyncPort,
  log: DeviceSyncLogger,
  onImported: () => void,
  intervalMs = 5_000,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let initialized = false
  let listFailures = 0
  const seen = new Set<string>()
  const listPins = async (): Promise<string[] | undefined> => {
    if (listFailures >= ARCHIVE_LIST_FAILURE_LIMIT) return undefined
    try {
      const pins = await port.listSyncArchivePins()
      listFailures = 0
      return pins.filter((pin) => !pin.startsWith(archivePinPrefix(port)))
    } catch (err) {
      listFailures += 1
      log.warn(
        listFailures >= ARCHIVE_LIST_FAILURE_LIMIT
          ? "[xmtp deviceSync] archive list keeps failing; replies now arrive by live sync only"
          : "[xmtp deviceSync] archive list failed",
        err,
      )
      return undefined
    }
  }
  const poll = async (): Promise<void> => {
    try {
      await port.syncAllDeviceSyncGroups()
      if (stopped) return
      const pins = await listPins()
      if (stopped || pins === undefined) return
      if (!initialized) {
        // Match initial recovery's newest-archive policy, without downloading a week's
        // worth of full-history snapshots on every mount. Subsequent replies are all handled.
        for (const pin of pins.slice(1)) seen.add(pin)
        initialized = true
      }
      for (const pin of [...pins].reverse()) {
        if (seen.has(pin)) continue
        try {
          await port.processSyncArchive(pin)
          if (stopped) return
          onImported()
          seen.add(pin)
        } catch (err) {
          // A missing or expired archive must not prevent a newer reply from being imported.
          log.warn("[xmtp deviceSync] archive refresh failed", err)
        }
        if (stopped) return
      }
    } catch (err) {
      log.warn("[xmtp deviceSync] history refresh failed", err)
    } finally {
      // Schedule after completion so slow imports never overlap or build up a queue.
      if (!stopped) timer = setTimeout(() => void poll(), intervalMs)
    }
  }
  void poll()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}
