import { useEffect, useMemo, useRef } from "react"
import {
  SIPADepositStore,
  RequestStorage,
  bootPriority,
  reconcileSipaRequestFulfillments,
  useAssetContext,
  useAztecContext,
  useCachedRecords,
} from "@obsidion/front-core"
import type { SIPADepositRecord, SipaDepositSyncResult } from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { fireEvent } from "../../lib/analytics"
import { getSipaDepositGateway } from "./sipaGateway"

/** Poll cadence while a deposit is in flight. */
const SYNC_INTERVAL_MS = 12_000
/** Cadence once every known SIPA is settled or long-idle (`SipaDepositSyncResult.active === 0`). */
const IDLE_SYNC_INTERVAL_MS = 60_000

/**
 * Records that just reached the terminal `claimed` phase (balance-visible), against `seen` —
 * which it mutates, so each claim reports exactly once. Seed `seen` with the already-claimed
 * records at mount or history re-fires. Addresses stay in-memory dedup keys; only durations
 * are ever emitted.
 */
export function newlyClaimedRecords(
  records: SIPADepositRecord[],
  seen: Set<string>,
): SIPADepositRecord[] {
  const fresh: SIPADepositRecord[] = []
  for (const r of records) {
    if (r.phase !== "claimed" || seen.has(r.sipaAddress)) continue
    seen.add(r.sipaAddress)
    fresh.push(r)
  }
  return fresh
}

/**
 * Reports the claims that settle from `since` onward, deduped by address. Records hydrate
 * cache-first and asynchronously, starting from an empty list, so arrival order can't separate
 * history from a live claim — `endTime` can: a record that settled before this session started is
 * history whenever it shows up. A claimed record with no `endTime` is treated as history, since a
 * duplicate funnel entry costs more than a missing one.
 *
 * In-memory dedupe: a reload re-derives everything from `since`, so it can't double-count.
 */
export function createClaimSweepReporter(
  since: number = Date.now(),
): (records: SIPADepositRecord[]) => SIPADepositRecord[] {
  const seen = new Set<string>()
  return (records) =>
    newlyClaimedRecords(records, seen).filter((r) => r.endTime !== undefined && r.endTime >= since)
}

/**
 * Reports a sync's unclaimed notes only on the way into failure. The pass retries on every tick, so
 * a note that stays stuck would otherwise report itself for as long as it sits there. A clean run
 * arms the next report.
 */
export function createSyncFailureReporter(): (failed: number) => boolean {
  let failing = false
  return (failed) => {
    const report = failed > 0 && !failing
    failing = failed > 0
    return report
  }
}

/**
 * Whether a pass settles the boot balance: it ran unlocked and claimed every note it found. A failed
 * or locked pass leaves that to a later pass or the backstop.
 */
export function settlesBootBalance(result: SipaDepositSyncResult | null): boolean {
  return !!result && result.failed === 0
}

/**
 * Drives the browser SIPA deposit loop: discovery (once) + a claim sync pass
 * on an interval. Records render cache-first — the persisted store hydrates
 * immediately and the sync pass overwrites it as fresh chain state lands.
 * Balance is NOT read here — a claim credits the shared asset layer, the pass
 * refreshes the chain view through `refreshBalance`, and `useBalance` renders
 * the result.
 * Sync is a no-op while the wallet is locked (the claim path needs the
 * unlocked key), so a refreshed session starts crediting deposits as soon as
 * it unlocks. The first pass runs right after the boot balance's note sync, and
 * the first pass that runs clean settles the boot balance.
 */
export function useSipaDeposits(): void {
  const { obsidionWallet } = useAztecContext()
  const { tokenService } = useAssetContext()
  const gateway = getSipaDepositGateway()

  const store = useMemo(() => SIPADepositStore.get(webStorage), [])
  const { records } = useCachedRecords(store)

  // A claimed deposit closes the request link it was minted for.
  useEffect(() => {
    void reconcileSipaRequestFulfillments(RequestStorage.get(), records).catch((err) =>
      console.warn("[sipaDeposits] request reconcile failed:", err),
    )
  }, [records])

  // Per-mount, so a StrictMode re-run reuses the same reporter and re-reports nothing.
  const reportSweeps = useRef<ReturnType<typeof createClaimSweepReporter> | null>(null)
  reportSweeps.current ??= createClaimSweepReporter()

  useEffect(() => {
    for (const r of reportSweeps.current!(records)) {
      fireEvent("deposit_swept", {
        duration_ms: r.endTime !== undefined ? r.endTime - r.startTime : undefined,
      })
    }
  }, [records])

  // Per-mount, so a StrictMode re-run reuses the same reporter.
  const reportFailures = useRef<ReturnType<typeof createSyncFailureReporter> | null>(null)
  reportFailures.current ??= createSyncFailureReporter()

  useEffect(() => {
    if (!obsidionWallet || !tokenService) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const runOnce = async () => {
      // Fast unless a pass reports nothing in flight. A locked or failed pass reports
      // nothing at all, so it stays fast.
      let nextDelay = SYNC_INTERVAL_MS
      let clean = false
      try {
        await bootPriority.whenNotesSynced()
        if (cancelled) return
        const result = await gateway.sync(obsidionWallet, tokenService, {
          onProgress: (done, total) => bootPriority.depositProgress(done, total),
        })
        // Locked sessions return null; a healthy tick logs its counts so
        // silence always means "not running", never "ran and found nothing".
        if (result) console.debug("[sipaDeposits] sync:", result)
        // Per-note failures are swallowed by the pass so one bad note can't stop the others, which
        // leaves a deposit stuck with nothing said. Report the run, not each note.
        if (result) {
          if (result.failed > 0)
            console.warn("[sipaDeposits] sync left", result.failed, "note(s) unclaimed")
          if (reportFailures.current!(result.failed))
            fireEvent("action_failed", { action: "deposit:sync", code: "note_sync_failed" })
        }
        if (result && result.active === 0) nextDelay = IDLE_SYNC_INTERVAL_MS
        clean = settlesBootBalance(result)
      } catch (e) {
        console.warn("[sipaDeposits] sync failed (will retry):", e)
        nextDelay = SYNC_INTERVAL_MS
      } finally {
        if (!cancelled) {
          if (clean) bootPriority.depositsReplayed()
          timer = setTimeout(runOnce, nextDelay)
        }
      }
    }
    runOnce()

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [gateway, obsidionWallet, tokenService])
}
