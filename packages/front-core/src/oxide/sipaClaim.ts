/**
 * The claim half of the SIPA pipeline: claims into the PXE the sweeps the scan half left pending
 * on a recipient's records, then saves them `claimed` in one write. It reads no L1: every claim
 * input, time and fee is on the record, and the scan half marks the deposits already spent, so
 * they cost no claim. `store_deposit` asserts the settled root, so a sweep whose L1→L2 message is
 * not ready waits for a later run.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { isL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { isAlreadyClaimedDepositError, type TokenService } from "@obsidion/sdk"
import { bestEffort } from "../engine/errors"
import type {
  SipaDeposit,
  SipaDepositEvent,
  SipaDeposits,
  SIPAPendingSweep,
} from "../engine/sipaDeposits"
import { logger } from "../utils/logger"
import { sipaLedgerEntry, stopIfAborted } from "./sipaScan"
import { sipaSweepRow, type SipaRow } from "./sipaRows"

/** Node surface for the readiness check (`isL1ToL2MessageReady`). */
export interface SipaClaimsNode {
  getL1ToL2MessageCheckpoint(messageHash: Fr): Promise<number | undefined>
  getBlockData?(tag: string): Promise<unknown>
}

export interface SipaClaimDeps {
  store: Pick<SipaDeposits, "byRecipient" | "applyAll">
  node: SipaClaimsNode
  /** The recipient whose sweeps this run claims. */
  recipient: AztecAddress
  tuple: OxideEnvTuple
  rows: readonly SipaRow[]
  /** The token service of a row's L2 token: a sweep is claimed on the token of the row it settled on. */
  tokenServiceFor: (l2Token: string) => Promise<Pick<TokenService, "claimSweptDeposit">>
  /**
   * Reads the balance once the claims landed. The claims are saved once this settles, so the
   * balance holds a deposit before its record reads `claimed`. A failed read is logged and the
   * claims saved anyway.
   */
  refreshBalance?: () => Promise<void>
  /** Sweeps the run has settled, of those it found pending. */
  onProgress?: (done: number, total: number) => void
  /** Ends the run before its next claim or write. */
  signal?: AbortSignal
}

export interface SipaClaimResult {
  /** Sweeps claimed into the PXE this run. */
  claimed: number
  /** Sweeps already claimed or spent (another device, a crash before the save): recorded, not claimed. */
  reconciled: number
  /** Sweeps whose message is not ready yet. */
  pendingSettlement: number
  /** Sweeps whose claim failed, retried next run. */
  failed: number
  /** Nothing failed, every lookup read and the run saved. */
  complete: boolean
}

interface Due {
  record: SipaDeposit
  sweep: SIPAPendingSweep
  row: SipaRow
}

/** The sweeps the scan half left on `records`, with the row each settles on. */
function pendingSweeps(deps: SipaClaimDeps, records: readonly SipaDeposit[]): Due[] {
  return records.flatMap((record) => {
    const claimed = new Set(record.claimedInboxIndexes ?? [])
    return (record.pendingSweeps ?? [])
      .filter((sweep) => !claimed.has(sweep.inboxIndex))
      .map((sweep) => ({
        record,
        sweep,
        row: sipaSweepRow(deps.tuple, deps.rows, sweep, record.intent),
      }))
  })
}

export async function claimSipaDeposits(deps: SipaClaimDeps): Promise<SipaClaimResult> {
  const result: SipaClaimResult = {
    claimed: 0,
    reconciled: 0,
    pendingSettlement: 0,
    failed: 0,
    complete: false,
  }
  const live = () => stopIfAborted(deps.signal, "sipaClaim")
  live()
  const due = pendingSweeps(deps, await deps.store.byRecipient(deps.recipient.toString()))
  let done = 0
  const step = () => deps.onProgress?.(++done, due.length)
  deps.onProgress?.(0, due.length)
  if (due.length === 0) {
    result.complete = true
    return result
  }
  const events: (readonly [string, SipaDepositEvent])[] = []
  const settle = ({ record, sweep, row }: Due) => {
    events.push([
      record.sipaAddress,
      {
        type: "claimed",
        sweep: sipaLedgerEntry(row, sweep),
        ...(sweep.settledAt === undefined ? {} : { endTime: sweep.settledAt }),
      },
    ])
  }
  let landed = 0
  /** In the PXE: `claimed` waits for the run's balance read, but any later read holds it too. */
  const land = async (item: Due) => {
    landed += 1
    await bestEffort(
      "unknown",
      deps.store.applyAll([
        [
          item.record.sipaAddress,
          { type: "claimLanded", inboxIndex: item.sweep.inboxIndex, at: Date.now() },
        ],
      ]),
    )
    settle(item)
  }
  // The readiness reads run at once; the claims one at a time, since each is a PXE simulation.
  const readiness = await Promise.allSettled(
    due.map(
      async ({ sweep }) =>
        sweep.spent ||
        isL1ToL2MessageReady(deps.node as never, Fr.fromHexString(sweep.messageKey) as never),
    ),
  )
  for (const [i, item] of due.entries()) {
    live()
    const { record, sweep, row } = item
    try {
      if (sweep.spent) {
        settle(item)
        result.reconciled += 1
        continue
      }
      const ready = readiness[i]!
      if (ready.status === "rejected") throw ready.reason
      if (!ready.value) {
        result.pendingSettlement += 1
        continue
      }
      const tokenService = await deps.tokenServiceFor(row.l2Token)
      await tokenService.claimSweptDeposit({
        inboxIndex: BigInt(sweep.inboxIndex),
        amount: BigInt(sweep.amount),
        recipient: deps.recipient,
        sharedSecretSalt: Fr.fromHexString(record.messageSecret),
      })
      live()
      await land(item)
      result.claimed += 1
    } catch (err) {
      live()
      // An earlier run may have stored it and stopped before its balance read.
      if (isAlreadyClaimedDepositError(err)) {
        await land(item)
        result.reconciled += 1
        continue
      }
      result.failed += 1
      logger.warn(`[sipaClaim] sweep ${sweep.inboxIndex} failed (will retry next run):`, err)
    } finally {
      step()
    }
  }
  live()
  let refreshed = true
  if (landed > 0) {
    try {
      await deps.refreshBalance?.()
    } catch (err) {
      refreshed = false
      logger.warn("[sipaClaim] balance refresh failed:", err)
    }
  }
  live()
  let saved = true
  if (events.length > 0) {
    try {
      await deps.store.applyAll(events)
    } catch (err) {
      live()
      saved = false
      result.failed += 1
      logger.warn("[sipaClaim] the claims did not save (reconciled next run):", err)
    }
  }
  result.complete = saved && refreshed && result.failed === 0
  return result
}
