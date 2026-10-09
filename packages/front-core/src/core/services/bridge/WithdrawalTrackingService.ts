/**
 * WithdrawalTrackingService — Drives a withdrawal record through its phases by
 * WATCHING chain, not by talking to a relayer. oxide's relayer finalizes L2→L1
 * withdrawals headlessly (no status endpoint), so the client only observes:
 *
 *   submitting → l2_mined → awaiting_proven → finalizing_l1 → done
 *
 * A swap-on-withdraw has one more leg: the release funds a counterfactual escrow and a relayer
 * runs the swap. The relayer is headless here too (it drops an operation whose `deployAndExecute` keeps
 * reverting and says nothing), so the tracker watches the escrow through the injected
 * `SwapEscrowReader`:
 *
 *   finalizing_l1 → swapping → done            (escrow emptied by the swap)
 *                 → swapping → recoverable       (funded, and `deployAndExecute` reverts: the route cannot deliver)
 *                            → recovered         (the user's recoverERC20 emptied it: the escrow's recovery log)
 *
 * The hook (`useWithdrawFlow`) writes the pre-mine `submitting` row, submits the
 * burn, then `markMined` + `watch(record)` to arm this service. From there each
 * tick reads chain:
 *   - lazily derive + stamp the `withdrawalId` (needs the burn's tx effect,
 *     which lags mining by a moment — a missing effect is retryable, never a
 *     failure),
 *   - poll `node.getTxReceipt` until the burn is proven-or-later (`isAtLeastProven`),
 *   - poll the injected `WithdrawalFinalizationReader.isSpent(withdrawalId)` — the
 *     authoritative L1 release signal — then best-effort resolve the L1 tx hash for
 *     the explorer link,
 *   - on a swap record, poll the escrow's DAI balance and code, and simulate `deployAndExecute`
 *     while it stays funded.
 *
 * `failed` is reachable from a pre-mine local error (owned by the flow),
 * from a rejected/reverted paylink submission verified by its receipt,
 * or from a reorg-dropped burn (`WithdrawalStorage.demote`
 * with `droppedBurn`, owned by the reorg layer). A post-mine stall (relayer not running, dry subsidy reserve,
 * gas spike) surfaces as the derived, non-terminal `delayed` presentation (see
 * `isWithdrawalDelayed`) — never a false failure notification. Every phase
 * patch here carries the record's `reorgEpoch`, so a demote racing a tick
 * fences the tick's stale write.
 *
 * Layering: `node.getTxReceipt` and `fetchWithdrawalsWithIds` are node RPC (fine
 * in front-core); the L1 CONTRACT read comes only through the injected
 * `WithdrawalFinalizationReader` (sdk layer), so front-core originates no contract
 * call. RPC reads fail loud (logged) and retry next tick; the authoritative
 * `isSpent` path never silently stalls.
 */

import { TxHash, TxStatus } from "@aztec/stdlib/tx"
import type { AztecNode } from "@aztec/stdlib/interfaces/client"

import {
  fetchWithdrawalsWithIds,
  type SwapEscrowReader,
  type WithdrawalFinalizationReader,
  type WithdrawalPortalContext,
} from "@obsidion/sdk"

import type { Hex } from "viem"

import { WithdrawalStorage } from "./WithdrawalStorage"
import { swapEscrowTarget } from "./swapEscrowArgs"
import { withdrawalRecipients } from "./withdrawalRecipients"
import type { WithdrawalDeployment, WithdrawalPhase, WithdrawalRecord } from "./types"
import { logger } from "src/utils/logger"
import { isFailedSubmission, trackSubmission } from "../transactions/trackSubmission"

/** Records a live in-process submission owns, so this tracker stands off until it releases. */
const liveSubmissions = new Set<string>()

/**
 * {@link trackSubmission} over a withdrawal record: stamps the hash onto the record at the submit
 * boundary, and answers a rejection with the record itself whenever the burn may still land, so a
 * lost connection never fails a withdrawal that is already on chain. The stamp is strict: a hash
 * that did not persist is never announced. `announce: false` for a record riding another's tx.
 */
export function trackWithdrawalSubmission(
  store: WithdrawalStorage,
  localId: string,
  operationId: string,
  opts: { announce?: boolean } = {},
) {
  liveSubmissions.add(localId)
  const submission = trackSubmission(
    operationId,
    (txHash) => store.patch(localId, { phase: "submitting", l2TxHash: txHash }, { strict: true }),
    opts,
  )
  return {
    /** The hash emitted at the submit boundary; undefined until then. */
    get txHash() {
      return submission.txHash
    },
    /** The record while the burn may still land, else null. */
    async recover(node: Pick<AztecNode, "getTxReceipt">) {
      if (!(await submission.survived(node))) return null
      return store.get(localId)
    },
    /** Whether the hash stamp persisted. */
    saved: () => submission.saved(),
    async stop() {
      try {
        await submission.stop()
      } finally {
        liveSubmissions.delete(localId)
      }
    },
  }
}

const DEFAULT_POLL_INTERVAL_MS = 20_000

/**
 * When a post-mine record has sat in its current phase longer than this, the UI
 * flips to the non-terminal `delayed` presentation ("taking longer than usual").
 * Sized well above the deployment's ~40-min proven cadence so a normal wait is
 * never mislabeled; tuned against measured latency in the staging smoke.
 */
export const WITHDRAWAL_DELAYED_THRESHOLD_MS = 60 * 60 * 1000

/**
 * How long a funded escrow may wait for a relayer before the user is offered to run the swap
 * themselves. The relayer drops an operation after its retry budget (ten simulations at 30 s
 * apart), so past this a swap nobody has run is one nobody will.
 */
export const SWAP_STUCK_THRESHOLD_MS = 5 * 60 * 1000

/** Post-mine phases that keep advancing toward `done` (i.e. can be `delayed`). */
const POST_MINE_NONTERMINAL_PHASES: ReadonlySet<WithdrawalPhase> = new Set<WithdrawalPhase>([
  "l2_mined",
  "awaiting_proven",
  "finalizing_l1",
  "swapping",
])

function isTerminalPhase(phase: WithdrawalPhase): boolean {
  return phase === "done" || phase === "recovered" || phase === "failed"
}

function isPostMineNonTerminal(phase: WithdrawalPhase): boolean {
  return POST_MINE_NONTERMINAL_PHASES.has(phase)
}

/** Proven-or-later: Aztec v4 receipts can skip past `proven` straight to `finalized`. */
function isAtLeastProven(status: TxStatus): boolean {
  return status === TxStatus.PROVEN || status === TxStatus.FINALIZED
}

/**
 * DERIVED, non-terminal `delayed` presentation. True when a post-mine record has
 * sat in its current phase past the threshold. Not a stored phase — the record's
 * `phase` stays `l2_mined`/`awaiting_proven`/`finalizing_l1`; presenters overlay
 * "taking longer than usual" without firing a failure. Pre-mine and terminal
 * records are never delayed.
 */
export function isWithdrawalDelayed(
  record: WithdrawalRecord,
  now: number = Date.now(),
  thresholdMs: number = WITHDRAWAL_DELAYED_THRESHOLD_MS,
): boolean {
  if (!isPostMineNonTerminal(record.phase)) return false
  const enteredAt = record.phaseEnteredAt ?? record.startTime
  return now - enteredAt >= thresholdMs
}

/**
 * Whether `record` may be finalized by the user themselves. The portal's `withdraw` is
 * permissionless whatever the prover tip, so anyone can release a proven burn from its published
 * log — but only once the L2 side is done (`finalizing_l1`) and only once the wait has been delayed
 * for a while, since a relayer that lands first will make the call revert.
 */
export function canSelfFinalizeWithdrawal(
  record: WithdrawalRecord,
  now: number = Date.now(),
): boolean {
  return (
    record.phase === "finalizing_l1" &&
    isWithdrawalDelayed(record, now) &&
    // `l2TxHash` exists means the burn is done on the L2 side.
    !!record.l2TxHash &&
    // `finalizeTxHash` exists means one is already in flight.
    !record.finalizeTxHash
  )
}

/**
 * Whether the user may run a swap record's escrow themselves. `deployAndExecute` is permissionless and
 * pays its caller the tip, so once the escrow has waited past `SWAP_STUCK_THRESHOLD_MS` with no
 * relayer the user is the relayer. A record that cannot rebuild its escrow args has nothing to
 * run.
 */
export function canSelfExecuteSwap(
  record: WithdrawalRecord,
  now: number = Date.now(),
  thresholdMs: number = SWAP_STUCK_THRESHOLD_MS,
): boolean {
  return (
    record.phase === "swapping" &&
    swapEscrowTarget(record) !== undefined &&
    // `swapExecuteTxHash` exists means a self-run is already in flight.
    !record.swapExecuteTxHash &&
    isWithdrawalDelayed(record, now, thresholdMs)
  )
}

/** Whether the escrow's DAI can be signed back out: parked `recoverable`, with rebuildable args. */
export function canRecoverSwap(record: WithdrawalRecord): boolean {
  return record.phase === "recoverable" && swapEscrowTarget(record) !== undefined
}

/**
 * Structural view of the Aztec node the tracker needs. Widened to `AztecNode`
 * because `fetchWithdrawalsWithIds` requires the full node; the tracker itself
 * only calls `getTxReceipt` (+ hands the node to the derivation reader).
 */
export type WithdrawalTrackerNode = AztecNode

export interface WithdrawalTrackingServiceOptions {
  store: WithdrawalStorage
  node: WithdrawalTrackerNode
  finalizationReader: WithdrawalFinalizationReader
  /**
   * Portal identity for deriving `withdrawalId`. Mapped from the env tuple at
   * boot (`l1Portal=tuple.portal`, `l2Portal=tuple.l2Token`, `rollupVersion`,
   * `l1ChainId`) — a wrong mapping yields a wrong id and `isSpent` never flips.
   */
  portalContext: WithdrawalPortalContext
  /**
   * Reader for a record stamped with a `deployment` other than the boot-time one (the live
   * deployment rolled under an in-flight withdrawal). Without it every record reads the boot-time
   * reader, which is wrong for retired portals.
   */
  readerForDeployment?: (deployment: WithdrawalDeployment) => WithdrawalFinalizationReader
  /**
   * Escrow reads for swap records. Without one a swap record settles `done` at the release, the
   * way a direct withdrawal does, and the swap leg goes unwatched.
   */
  swapEscrowReader?: SwapEscrowReader
  /** Poll cadence (ms). Defaults to 20s. */
  pollIntervalMs?: number
  /** Interval scheduler override for tests. Defaults to global setInterval. */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * `endTime` for a record rebuilt from chain that settles on this device. Its settlement was never
 * observed, so the burn time dates it; the wall clock would date it at discovery. Undefined for a
 * live record, whose settlement the store stamps as it happens.
 */
function rebuiltSettledAt(record: WithdrawalRecord): number | undefined {
  return record.rebuilt ? record.startTime : undefined
}

export class WithdrawalTrackingService {
  private static instance: WithdrawalTrackingService | null = null

  private store: WithdrawalStorage
  private node: WithdrawalTrackerNode
  private finalizationReader: WithdrawalFinalizationReader
  private portalContext: WithdrawalPortalContext
  private readerForDeployment?: (deployment: WithdrawalDeployment) => WithdrawalFinalizationReader
  private swapEscrowReader?: SwapEscrowReader
  /** Per-portal readers built from `readerForDeployment`. */
  private deploymentReaders = new Map<string, WithdrawalFinalizationReader>()
  private pollIntervalMs: number
  private scheduler: NonNullable<WithdrawalTrackingServiceOptions["scheduler"]>
  private now: () => number

  private intervalHandle: unknown = null
  /** Non-overlap guard so a slow tick can't stack against the next interval. */
  private syncing = false

  private constructor(options: WithdrawalTrackingServiceOptions) {
    this.store = options.store
    this.node = options.node
    this.finalizationReader = options.finalizationReader
    this.portalContext = options.portalContext
    this.readerForDeployment = options.readerForDeployment
    this.swapEscrowReader = options.swapEscrowReader
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.scheduler = options.scheduler ?? {
      setInterval: (cb, ms) =>
        (globalThis as unknown as { setInterval: typeof setInterval }).setInterval(cb, ms),
      clearInterval: (handle) =>
        (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval(
          handle as ReturnType<typeof setInterval>,
        ),
    }
    this.now = options.now ?? Date.now
  }

  /**
   * Reset the singleton so the next `get()` rebinds with fresh config (network
   * switch / account rotation). Stops the poll loop first so no tick runs
   * against the old node.
   */
  static reset(): void {
    const inst = WithdrawalTrackingService.instance
    if (inst) {
      try {
        inst.stop()
      } finally {
        WithdrawalTrackingService.instance = null
      }
    }
  }

  /**
   * Singleton accessor. First call must supply the full options; subsequent
   * no-arg calls return the same instance. First-call-wins — later options are
   * ignored (use `reset()` first to rebind).
   */
  static get(options?: WithdrawalTrackingServiceOptions): WithdrawalTrackingService {
    if (!WithdrawalTrackingService.instance) {
      if (!options) {
        throw new Error(
          "First call to WithdrawalTrackingService.get() requires { store, node, finalizationReader, portalContext }",
        )
      }
      const invalid: string[] = []
      if (!options.store) invalid.push("store")
      if (!options.node) invalid.push("node")
      if (!options.finalizationReader) invalid.push("finalizationReader")
      if (!options.portalContext) invalid.push("portalContext")
      if (invalid.length > 0) {
        throw new Error(
          `First call to WithdrawalTrackingService.get() received invalid options (missing: ${invalid.join(
            ", ",
          )})`,
        )
      }
      WithdrawalTrackingService.instance = new WithdrawalTrackingService(options)
    }
    return WithdrawalTrackingService.instance
  }

  // ============================================================================
  // Arming
  // ============================================================================

  /**
   * Arm the watcher for a mined withdrawal. Called after the hook's
   * `markMined`. Persists the record if the caller hasn't, backfills
   * `phaseEnteredAt` for the delayed derivation, and starts the poll loop.
   *
   * Non-throwing and does NOT derive `withdrawalId` up front — the burn's tx
   * effect can lag mining, so a one-shot derive here could throw. The poll loop
   * derives lazily on its ticks; the first tick lands within one interval,
   * which is negligible against the ~40-min proven cadence.
   */
  async watch(record: WithdrawalRecord): Promise<void> {
    await this.store.load()
    if (!this.store.get(record.localId)) {
      // Defensive: the normal flow calls markMined before watch, but persist
      // here too so arming never silently drops a record.
      await this.store.create(record)
    }
    const current = this.store.get(record.localId)
    if (current) await this.backfillPhaseEnteredAt(current)
    this.ensureLoop()
  }

  /**
   * Resume watching after app launch. Backfills `phaseEnteredAt` on post-mine
   * records that lack it (so a resumed record's delayed timer starts fresh
   * rather than firing off `startTime`), then arms the poll loop. Terminal and
   * pre-mine records are left alone.
   */
  async resumeAll(): Promise<void> {
    await this.store.load()
    for (const record of this.store.list()) {
      await this.backfillPhaseEnteredAt(record)
    }
    this.ensureLoop()
  }

  /**
   * "Check again" for a post-mine record — kicks an immediate re-poll. Post-mine
   * ONLY: a mined burn stays finalizable, so re-checking chain is the only lever
   * (a re-burn would double-spend). Pre-mine `failed` retry (re-running the burn,
   * keyed by localId) lives in the hook, not here. No-op on a terminal or
   * unknown record; never throws.
   */
  async retry(l2TxHash: string): Promise<void> {
    const record = this.store.getByL2TxHash(l2TxHash)
    if (!record || isTerminalPhase(record.phase)) return
    this.ensureLoop()
    await this.syncOnce()
  }

  /** Stop the poll loop. Records are left in place for the next `resumeAll`. */
  stop(): void {
    if (this.intervalHandle !== null) {
      this.scheduler.clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  // ============================================================================
  // Internal
  // ============================================================================

  private ensureLoop(): void {
    if (this.intervalHandle !== null) return
    this.intervalHandle = this.scheduler.setInterval(
      () => void this.syncOnce(),
      this.pollIntervalMs,
    )
  }

  private async backfillPhaseEnteredAt(record: WithdrawalRecord): Promise<void> {
    if (!isPostMineNonTerminal(record.phase)) return
    if (record.phaseEnteredAt !== undefined) return
    if (!record.l2TxHash) return
    await this.store.patch(record.l2TxHash, {
      phase: record.phase,
      phaseEnteredAt: this.now(),
      reorgEpoch: record.reorgEpoch,
    })
  }

  /**
   * One pass over every armed record. Each step is isolated so one record's RPC
   * error (logged loud) doesn't abort the others; the failing record stays
   * non-terminal and retries next pass.
   */
  async syncOnce(): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      await this.store.load()
      for (const record of this.store.list()) {
        if (isTerminalPhase(record.phase)) continue
        if (!record.l2TxHash) continue // pre-mine — the hook owns it
        try {
          await this.step(record)
        } catch (err) {
          // Fail loud, stay non-terminal, retry next pass. A mined burn is
          // never failed by a transient read error.
          logger.warn(`[WithdrawalTracking] tick failed for ${record.l2TxHash}:`, err)
        }
      }
    } finally {
      this.syncing = false
    }
  }

  /**
   * Advance one record one step. Deriving `withdrawalId` gates the rest of the
   * tick: until the burn's tx effect is indexed we cannot bind the finalization
   * poll, and the tx is far too fresh to be proven anyway, so deferring the
   * whole tick is harmless and keeps the record cleanly parked at its phase.
   */
  /** Reader + portal context for the deployment `record` burned on; boot-time pair when unstamped. */
  private bindingsFor(record: WithdrawalRecord): {
    reader: WithdrawalFinalizationReader
    portalContext: WithdrawalPortalContext
  } {
    const deployment = record.deployment
    if (
      !deployment ||
      !this.readerForDeployment ||
      deployment.portal.toLowerCase() === this.portalContext.l1Portal.toLowerCase()
    ) {
      return { reader: this.finalizationReader, portalContext: this.portalContext }
    }
    const key = deployment.portal.toLowerCase()
    let reader = this.deploymentReaders.get(key)
    if (!reader) {
      reader = this.readerForDeployment(deployment)
      this.deploymentReaders.set(key, reader)
    }
    return {
      reader,
      portalContext: {
        ...this.portalContext,
        l1Portal: deployment.portal,
        l2Portal: deployment.l2Token,
      },
    }
  }

  private async step(mutableRecord: WithdrawalRecord): Promise<void> {
    let record = mutableRecord
    const l2TxHash = record.l2TxHash!
    const txHash = TxHash.fromString(l2TxHash)
    const { reader, portalContext } = this.bindingsFor(record)

    if (record.phase === "submitting") {
      // Mining publishes the hash before sendTx; don't race the live submission.
      if (liveSubmissions.has(record.localId)) return
      const receipt = await this.node.getTxReceipt(txHash)
      if (isFailedSubmission(receipt)) {
        await this.store.patch(record.localId, {
          phase: "failed",
          error:
            receipt.error ||
            (record.source === "paylink"
              ? "The withdrawal transaction was dropped or reverted. You can retry the link."
              : "The withdrawal transaction was dropped or reverted. You can try again."),
        })
        return
      }
    }

    if (!record.withdrawalId) {
      let derivedId: Hex | undefined
      try {
        const { withdrawals } = await fetchWithdrawalsWithIds(this.node, txHash, portalContext)
        const withdrawal = withdrawals[0]
        derivedId = withdrawal?.withdrawalId.toString() as Hex | undefined
        // The sender may have lost its receipt after broadcast. Only an indexed burn and
        // its receipt can advance that durable submitting record to mined.
        if (withdrawal && record.phase === "submitting") {
          const receipt = await this.node.getTxReceipt(txHash)
          if (receipt.blockNumber === undefined) return
          record = await this.store.markMined(
            record.localId,
            l2TxHash,
            receipt.blockNumber,
            withdrawal.amount.toString(),
            withdrawal.relayerTip.toString(),
          )
        }
      } catch (err) {
        // Burn effect not yet indexed (or transient RPC) — retryable. Surface
        // it, then defer the rest of the tick to the next pass.
        logger.warn(`[WithdrawalTracking] withdrawalId derivation deferred for ${l2TxHash}:`, err)
        return
      }
      if (!derivedId) return // no withdrawal log yet — defer
      record = await this.store.patch(l2TxHash, {
        phase: record.phase,
        withdrawalId: derivedId,
        reorgEpoch: record.reorgEpoch,
      })
    }

    if (record.phase === "l2_mined" || record.phase === "awaiting_proven") {
      const receipt = await this.node.getTxReceipt(txHash)
      if (isAtLeastProven(receipt.status)) {
        await this.advancePhase(record, "finalizing_l1")
      } else if (record.phase === "l2_mined") {
        await this.advancePhase(record, "awaiting_proven")
      }
      return
    }

    if (record.phase === "finalizing_l1") {
      const withdrawalId = record.withdrawalId!
      const spent = await reader.isSpent(withdrawalId)
      if (!spent) return
      // Best-effort explorer link — never blocks `done`, omitted when ambiguous.
      const l1TxHash = await reader.resolveL1TxHash(withdrawalId).catch(() => undefined)
      const phase =
        withdrawalRecipients(record).viaEscrow && this.swapEscrowReader ? "swapping" : "done"
      const endTime =
        phase === "done"
          ? (l1TxHash && (await reader.l1TxTimestampMs?.(l1TxHash))) || rebuiltSettledAt(record)
          : undefined
      const released = await this.store.patch(l2TxHash, {
        phase,
        phaseEnteredAt: this.now(),
        l1TxHash,
        ...(endTime === undefined ? {} : { endTime }),
        error: undefined,
        reorgEpoch: record.reorgEpoch,
      })
      if (released.phase === "swapping") await this.stepSwap(released)
      return
    }

    if (record.phase === "swapping" || record.phase === "recoverable") {
      await this.stepSwap(record)
    }
  }

  /**
   * The escrow leg of a swap record. The escrow's DAI is the ground truth: gone from a deployed
   * escrow means the swap ran or the user's recovery did, and the logs tell the two apart; still
   * there means nobody has run it, and a `deployAndExecute` simulation says whether anybody can.
   */
  private async stepSwap(record: WithdrawalRecord): Promise<void> {
    const reader = this.swapEscrowReader
    const target = swapEscrowTarget(record)
    if (!reader || !record.swapEscrow) return
    const l2TxHash = record.l2TxHash!
    const [balance, deployed] = await Promise.all([
      reader.daiBalance(record.swapEscrow),
      reader.isDeployed(record.swapEscrow),
    ])

    if (balance === 0n) {
      if (!deployed) return // release not indexed yet, or balance read raced it — defer
      // A failed log read throws and the tick retries: read as "no log" it would misreport.
      const factory = target?.factory ?? record.swapEscrowFactory
      const [executed, recovered] = await Promise.all([
        factory ? reader.executedTxHash(factory, record.swapEscrow) : undefined,
        reader.recoveredTxHash(record.swapEscrow),
      ])
      if (recovered && !executed) {
        await this.store.patch(l2TxHash, {
          phase: "recovered",
          recoveryTxHash: recovered.txHash,
          recoveryTarget: recovered.target,
          reorgEpoch: record.reorgEpoch,
        })
        return
      }
      await this.store.patch(l2TxHash, {
        phase: "done",
        swapExecuteTxHash: executed ?? record.swapExecuteTxHash,
        endTime: rebuiltSettledAt(record),
        reorgEpoch: record.reorgEpoch,
      })
      return
    }

    // Funded. Without rebuildable args nothing can be simulated: the record waits on a relayer.
    if (!target) return
    const fillable = await reader.deploySimulates(target.factory, target)
    if (!fillable && record.phase === "swapping") {
      await this.advancePhase(record, "recoverable")
    } else if (fillable && record.phase === "recoverable") {
      // The route can fill again (the pool price moved back): let a relayer or the user run it.
      await this.advancePhase(record, "swapping")
    }
  }

  private async advancePhase(record: WithdrawalRecord, phase: WithdrawalPhase): Promise<void> {
    await this.store.patch(record.l2TxHash!, {
      phase,
      phaseEnteredAt: this.now(),
      reorgEpoch: record.reorgEpoch,
    })
  }
}
