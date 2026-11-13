/**
 * Drives a backup-passkey rotation through its phases: one step per transition over injected
 * dependencies, and `resume` for a record found on load. A resume trusts nothing the record says
 * about the chain: it checks the record is well formed and the root key's, reconciles what the
 * chain and the other stores already show, and only then judges a precondition or runs a step.
 * No UI, no ceremony, no React.
 */
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import { L1_SWEEP_RECHECK_DEPTH } from "@obsidion/core/constants"
import {
  BACKUP_FUNDING_MARGIN,
  BackupSetConflictError,
  isSpendEnvelopeRefusal,
  VerificationUnavailableError,
  type PersistedRotation,
  type PersistedRotationVerdict,
  type RotationFundability,
  type SpendShape,
  type TxHashCallback,
} from "@obsidion/sdk"
import type { Address, Hex } from "viem"
import { WalletError } from "../../engine/errors"
import { INCLUDED_TIERS, type ReorgTxReceiptLike } from "../services/chain/receiptTypes"
import {
  fundingLanding,
  fundingLocalId,
  fundingStarted,
  moveDeclined,
  persistedRotation,
  storeRotation,
  stripSettled,
  sweepGone,
  sweepWatched,
  type BackupFunding,
  type BackupPublish,
  type BackupRotationPhase,
  type BackupRotationPlan,
  type BackupRotationRecord,
  type BackupRotations,
  type LinkRefundRecord,
  type LinkRefunds,
  type MoveChunkRecord,
  type MoveRun,
  type MoveSend,
  type TokenAmount,
} from "../../engine/backupRotations"
import { bestEffort } from "../../engine/errors"
import { planMove, type MoveDeposits } from "./planMove"

export const PUBLISH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Republishes before a funded, unswept deposit address is reported as stranded. */
export const PUBLISH_BOUND = 12

// ---------------------------------------------------------------------------------------------
// The one classifier of an L2 transaction, by hash alone.

export type TxOutcome =
  | {
      kind: "included"
      blockNumber: number
      blockHash: string
      effect: "success" | "reverted"
      /** In an L1 checkpoint: past the tiers the sequencer alone can drop. */
      checkpointed: boolean
    }
  | { kind: "mined" }
  | { kind: "reverted" }
  | { kind: "pending" }
  | { kind: "dead" }
  | { kind: "unknown" }

export interface OutcomeNode {
  getTxReceipt(txHash: string): Promise<ReorgTxReceiptLike>
  /** The block timestamp of the node's finalized tip, ms. */
  finalizedTimestampMs(): Promise<number>
}

/**
 * `included` at a reorgable tier, with the block kept for re-reading and whether an L1 checkpoint
 * holds it; `mined` once final; `reverted`
 * only when final; a transaction the node does not hold is `pending` until both the wallet's clock
 * and the finalized tip are past its expiry (for good, with no expiry known), and `dead` once a
 * read taken after that still misses it. The expiry is capped by the wallet's clock, so a chain
 * whose clock runs ahead of the wallet's cannot kill a transaction it has yet to receive. A read
 * that fails answers `unknown` and moves nothing.
 */
export async function txOutcome(
  node: OutcomeNode,
  txHash: string,
  expiresAtMs: number | undefined,
  nowMs: number = Date.now(),
): Promise<TxOutcome> {
  try {
    const seen = held(await node.getTxReceipt(txHash))
    if (seen) return seen
    if (expiresAtMs === undefined || nowMs <= expiresAtMs) return { kind: "pending" }
    if ((await node.finalizedTimestampMs()) <= expiresAtMs) return { kind: "pending" }
    return held(await node.getTxReceipt(txHash)) ?? { kind: "dead" }
  } catch {
    return { kind: "unknown" }
  }
}

/** The outcome of a transaction the node holds; nothing for one it does not. */
function held(receipt: ReorgTxReceiptLike): TxOutcome | undefined {
  const reverted = receipt.executionResult === TxExecutionResult.REVERTED
  if (receipt.status === TxStatus.FINALIZED) return { kind: reverted ? "reverted" : "mined" }
  if (INCLUDED_TIERS.has(receipt.status)) {
    return {
      kind: "included",
      blockNumber: receipt.blockNumber ?? 0,
      blockHash: receipt.blockHash ?? "",
      effect: reverted ? "reverted" : "success",
      checkpointed: receipt.status !== TxStatus.PROPOSED,
    }
  }
  return receipt.status === TxStatus.PENDING ? { kind: "pending" } : undefined
}

// ---------------------------------------------------------------------------------------------
// Dependencies.

/** The withdrawal tracker's row for a funding, as the reconciliation reads it. */
export interface FundingRow {
  phase: string
  l2TxHash?: string
  /** The portal's id for the withdrawal, known from `finalizing_l1` on. */
  withdrawalId?: string
  /** When the row was seeded, before its burn. */
  startTime: number
  recipient: string
}

export interface SweepSeen {
  index: string
  blockNumber: number
  blockHash: Hex
  credited: bigint
}

/**
 * A block `L1_SETTLED_DEPTH` confirmations behind the Ethereum tip: what the flow counts a sweep, an
 * install, a release or a recovery on, in place of Ethereum finality. The sweep is read again after
 * the re-root until it is `L1_SWEEP_RECHECK_DEPTH` blocks deep; the others are not re-checked.
 */
export interface SettledBlock {
  number: number
  hash: Hex
}

export interface RotationL1 {
  settledBlock(): Promise<SettledBlock>
  /** Whether the block is still on the chain and settled. */
  isSettled(block: { blockNumber: number; blockHash: Hex }): Promise<boolean>
  /** The block holding an L1 transaction, if one does. */
  txBlock(txHash: Hex): Promise<{ blockNumber: number; blockHash: Hex } | undefined>
  /** The deposit address's balance at the settled block (the one given, else read now), or at the latest one when asked. */
  sipaBalance(sipa: Address, at?: "latest" | SettledBlock): Promise<bigint>
  /** The deposit address's sweep since `fromBlock`, if one ran. */
  sweep(sipa: Address, fromBlock: number): Promise<SweepSeen | undefined>
  /**
   * The latest transfer out of the deposit address since `fromBlock` in a transaction with no sweep.
   * Only a sweep or a recovery moves tokens out, so it is a recovery.
   */
  recovery(sipa: Address, fromBlock: number): Promise<Hex | undefined>
  /** Whether the portal shows the withdrawal spent at the settled block `at`. */
  releaseSettled(withdrawalId: string, at: SettledBlock): Promise<boolean>
}

export interface MoveDeps {
  tokens(): Promise<string[]>
  /** The one-key account's shape on `token`, read while no chunk is in flight. */
  shape(token: string): Promise<SpendShape>
  deposits(token: string, shape: SpendShape): Promise<MoveDeposits>
  /** The most one transfer of `token` moves: its own portal caps its notes. */
  cap(token: string): Promise<bigint>
  usesLeft(): Promise<boolean>
  /**
   * One sponsored transfer of `amount` to the two-key account; the root key signs it. Once `signal`
   * aborts, the root key is not asked and the send rejects with its reason.
   */
  send(token: string, amount: bigint, onTxHash: TxHashCallback, signal?: AbortSignal): Promise<void>
  /** The open paylinks the one-key account made, which the move takes back first. */
  links(): Promise<string[]>
  /**
   * Whether the link can be taken back now, only once it expires (too close to its end to cancel),
   * or not at all because it was spent another way; `spending` while that spend is in a block no
   * L1 checkpoint holds yet, which a reorg can still undo.
   */
  refundable(link: string): Promise<"now" | "later" | "spending" | "spent">
  /** One sponsored refund of the link to the one-key account, signed and aborted as `send` is. */
  refund(link: string, onTxHash: TxHashCallback, signal?: AbortSignal): Promise<void>
  /** Whether `send` or `refund` failed because the user closed the root key's prompt. */
  declined(err: unknown): boolean
}

export interface RotationFlowDeps {
  store: BackupRotations
  now(): number
  mintAttemptId(): string
  /** When this tab became the active one; a row seeded before it belongs to no live burn. */
  activeSince: number
  /** An id for this life of the wallet; a funding seeded or a chunk claimed under another has no send behind it. */
  session: string
  /** The structural check: the sdk's verification plus the signer's decode, over this device's truth. */
  verify(rotation: PersistedRotation): Promise<PersistedRotationVerdict>
  /** Whether the signed change can still run. Throws `BackupSetConflictError`. */
  fundability(rotation: PersistedRotation): Promise<RotationFundability>
  /** The sweep route read live and the signed sweep quoted again. */
  route(rotation: PersistedRotation): Promise<"ok" | "route">
  l1: RotationL1
  node: OutcomeNode
  tracker: {
    row(localId: string): Promise<FundingRow | undefined>
    /** Stamps the row with its hash at the submit boundary, as the tracker does later. */
    stamp(localId: string, txHash: string): Promise<void>
  }
  sign(rotation: Omit<PersistedRotation, "signature">): Promise<Hex>
  /** Writes the deposit address's rail record and enqueues its broadcast. */
  publish(record: BackupRotationRecord, rotation: PersistedRotation): Promise<void>
  /** Sends the landed broadcast again from the current block, so the relayer takes the sweep up again. */
  republish(record: BackupRotationRecord): Promise<void>
  /** The funding withdrawal to the deposit address; `onTxHash` is awaited before the node takes it. */
  fund(
    record: BackupRotationRecord,
    funding: BackupFunding,
    onTxHash: TxHashCallback,
  ): Promise<void>
  /** Runs the wallet on the two-key account, writing each checkpoint as it completes; answers them all. */
  reroot(
    record: BackupRotationRecord,
    checkpoint: (fields: RerootCheckpoints) => Promise<void>,
  ): Promise<RerootCheckpoints>
  move: MoveDeps
}

export type RerootCheckpoints = NonNullable<BackupRotationRecord["reroot"]>

/** Why a step stopped without a transition. */
export type FlowWait =
  | "unverifiable"
  | "applied-pending"
  | "funding"
  | "sweep"
  | "burn"
  | "chunk"
  | "uses"
  | "recovery"
  | "declined"
  /** A planned refund or chunk waits for the user to approve its send. */
  | "approval"
  /** A paylink too close to its expiry to cancel waits for it, then is reclaimed. */
  | "link"

export interface FlowResult {
  record: BackupRotationRecord
  wait?: FlowWait
  /** The sweep is still re-read from the chain: the driver polls whatever the wait. */
  watch?: true
  /** The wait ends on its own within a block or two, so the driver polls at its short interval. */
  soon?: true
}

export type FlowRefusal = "gone" | "phase" | "funding-open" | "not-cancellable"

export interface RunOptions {
  /** Whether a step may ask for the root passkey: set only for a run the user's tap started. */
  prompt?: boolean
  /** Aborted once the screen the tap came from closes: a send that has not asked yet waits instead. */
  signal?: AbortSignal
}

/** A step the record's state refuses. */
export class RotationFlowError extends Error {
  constructor(readonly code: FlowRefusal, message: string) {
    super(`backup rotation: ${message}`)
    this.name = "RotationFlowError"
  }
}

/** A refusal because the record changed under the step; the store's change already shows the outcome. */
export const recordMoved = (error: unknown): boolean =>
  error instanceof RotationFlowError && (error.code === "phase" || error.code === "gone")

/** A funding's hash could not be written durably; the send is aborted before the node takes it. */
export class FundingCheckpointError extends Error {
  constructor(cause: unknown) {
    super("backup rotation: the funding's hash was not saved", { cause })
    this.name = "FundingCheckpointError"
  }
}

// ---------------------------------------------------------------------------------------------
// Record writes.

type Patch = (current: BackupRotationRecord) => Partial<BackupRotationRecord> | null

/**
 * Patches the attempt over what the store holds. A replaced or removed attempt throws `gone`; a
 * patch the stored record declines throws `phase`, so no step goes on over a record that moved.
 */
async function save(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
  patch: Patch,
): Promise<BackupRotationRecord> {
  let applied = false
  const stored = await deps.store.update(record.owner, (current) => {
    if (!current || current.attemptId !== record.attemptId) return null
    const fields = patch(current)
    if (!fields) return null
    applied = true
    return { ...current, ...fields, updatedAt: deps.now() }
  })
  if (stored?.attemptId !== record.attemptId) throw new RotationFlowError("gone", "attempt is gone")
  if (!applied) throw new RotationFlowError("phase", "the record moved on")
  return stored
}

/** The side state, keeping the phase it interrupts so the record can return there. */
const attention = (
  current: BackupRotationRecord,
  reason: NonNullable<BackupRotationRecord["attention"]>,
): Partial<BackupRotationRecord> => ({
  phase: "attention",
  attention: reason,
  suspended: current.phase === "attention" ? current.suspended : current.phase,
})
const CLEARED = { attention: undefined, suspended: undefined } as const
/** Back to `created`, the backup kept: the signed change is dropped for a fresh one. */
const RESTART: Partial<BackupRotationRecord> = {
  phase: "created",
  plan: undefined,
  rotation: undefined,
  fromBlock: undefined,
  publish: undefined,
  ...CLEARED,
}
/** The account's keys changed elsewhere, so the signed change cannot run; nothing of it was funded. */
const CONFLICT: Partial<BackupRotationRecord> = { phase: "conflict", ...CLEARED }

const SETTLED: readonly BackupRotationPhase[] = ["funded", "swept", "rerooted", "moved", "done"]
const rank = (phase: BackupRotationPhase) => SETTLED.indexOf(phase)
/** A side state ranks below every settled phase, so a settled phase supersedes it. */
const before = (record: BackupRotationRecord, phase: BackupRotationPhase) =>
  rank(record.phase) < rank(phase)

const whole = (record: BackupRotationRecord): PersistedRotation | undefined =>
  record.rotation?.signature && record.rotation.sharedSecretSalt && record.rotation.add.envelope
    ? persistedRotation(record.rotation)
    : undefined

const inFlight = (record: BackupRotationRecord) => record.fundings.some(fundingLanding)

/** The phase the record's money is judged in: a parked route's is the one it left. */
const acting = (record: BackupRotationRecord): BackupRotationPhase =>
  record.phase === "attention" && record.attention === "route" && record.suspended
    ? record.suspended
    : record.phase

const sameFunding = (a: BackupFunding, b: BackupFunding) =>
  a.attemptId === b.attemptId &&
  a.txHash === b.txHash &&
  a.outcome === b.outcome &&
  a.expiresAtMs === b.expiresAtMs

/**
 * Whether the store still reads as the snapshot a step decided over, so the decision applies: the
 * same phase and side state, the same signed change, the same sweep as last read, and the same
 * fundings entry for entry.
 */
const unmoved = (c: BackupRotationRecord, snapshot: BackupRotationRecord) =>
  c.phase === snapshot.phase &&
  c.attention === snapshot.attention &&
  c.suspended === snapshot.suspended &&
  c.rotation?.sipa === snapshot.rotation?.sipa &&
  c.sweep?.blockHash === snapshot.sweep?.blockHash &&
  c.sweep?.recheck === snapshot.sweep?.recheck &&
  c.fundings.length === snapshot.fundings.length &&
  c.fundings.every((f, i) => sameFunding(f, snapshot.fundings[i]!))

/** Whether the move runs still read as the snapshot a cut was taken over. */
const sameRuns = (c: BackupRotationRecord, snapshot: BackupRotationRecord) =>
  JSON.stringify(c.move?.runs ?? []) === JSON.stringify(snapshot.move?.runs ?? [])

const sweepKept = (sweep: SweepSeen): NonNullable<BackupRotationRecord["sweep"]> => ({
  index: sweep.index,
  blockNumber: sweep.blockNumber,
  blockHash: sweep.blockHash,
  credited: sweep.credited.toString(),
})

/** The phases from the sweep on, where the sweep the record counts on is read again. */
const AFTER_SWEEP: readonly BackupRotationPhase[] = ["swept", "rerooted", "moved", "done"]

/**
 * The counted sweep read again: a reorg may have moved it to another block or dropped it, and a
 * dropped one is swept again by the relayer. Dropped, or replaced by one not settled yet, reads
 * `gone`, or `lost` once no sweep came within `L1_SWEEP_RECHECK_DEPTH` blocks of the recorded one;
 * one seen and settled is kept as read, `deep` once that far behind the settled block. Nothing for
 * a sweep that reads as saved.
 */
async function recheckSweep(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  sipa: Address,
  fromBlock: number,
): Promise<Partial<BackupRotationRecord> | undefined> {
  const saved = record.sweep!
  const seen = await deps.l1.sweep(sipa, fromBlock)
  const settledNumber = async () => (await deps.l1.settledBlock()).number
  if (!seen || !(await deps.l1.isSettled(seen))) {
    const lost = (await settledNumber()) - saved.blockNumber! >= L1_SWEEP_RECHECK_DEPTH
    const recheck = lost ? "lost" : "gone"
    return saved.recheck === recheck ? undefined : { sweep: { ...saved, recheck } }
  }
  const deep = (await settledNumber()) - seen.blockNumber >= L1_SWEEP_RECHECK_DEPTH
  const next = { ...sweepKept(seen), ...(deep ? { recheck: "deep" as const } : {}) }
  return sameSweep(next, saved) ? undefined : { sweep: next }
}

const sameSweep = (
  a: NonNullable<BackupRotationRecord["sweep"]>,
  b: NonNullable<BackupRotationRecord["sweep"]>,
) =>
  a.index === b.index &&
  a.blockNumber === b.blockNumber &&
  a.blockHash === b.blockHash &&
  a.credited === b.credited &&
  a.recheck === b.recheck

/** The sweep recorded; which funding it took is judged by the reconciliation, not here. */
const sweptPatch = (sweep: SweepSeen): Patch => {
  const kept = sweepKept(sweep)
  return (c) => ({
    ...(before(c, "swept") ? { phase: "swept", ...CLEARED } : {}),
    sweep: kept,
    recovery: undefined,
  })
}

/** The fundability read, a conflict answered as a verdict. */
async function readFundability(
  deps: RotationFlowDeps,
  rotation: PersistedRotation,
): Promise<RotationFundability | "conflict"> {
  try {
    return await deps.fundability(rotation)
  } catch (err) {
    if (err instanceof BackupSetConflictError) return "conflict"
    throw err
  }
}

/** The change ran without this wallet's funding; money already held at the deposit address stays the user's to recover. */
const installedPatch = async (
  deps: RotationFlowDeps,
  rotation: PersistedRotation,
): Promise<Patch> => {
  const block = await deps.l1.settledBlock()
  const held = await depositHeld(deps, rotation.sipa)
  return () => ({
    phase: "installed",
    installed: { blockHash: block.hash },
    ...CLEARED,
    ...(held ? { unswept: true } : {}),
    recovery: undefined,
  })
}

// ---------------------------------------------------------------------------------------------
// Steps.

export interface SignInput {
  prepared: Omit<PersistedRotation, "signature">
  plan: BackupRotationPlan
  /** The L1 block now: where every read of the deposit address starts. */
  fromBlock: number
}

/** `created` → `signed`: the root key signs the prepared change; the record keeps it whole. */
export async function signRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  input: SignInput,
): Promise<BackupRotationRecord> {
  if (record.phase !== "created") throw new RotationFlowError("phase", "already signed")
  const signature = await deps.sign(input.prepared)
  return save(deps, record, (c) =>
    c.phase === "created"
      ? {
          phase: "signed",
          plan: input.plan,
          rotation: storeRotation({ ...input.prepared, signature }),
          fromBlock: input.fromBlock,
        }
      : null,
  )
}

/**
 * The checks before anything is published or funded: the fundability read, then the route and the
 * quote. Only a change that can still run asks the route, since the sweep of any other fails its
 * quote. Answers the phase the record goes to instead, or nothing to proceed. A change the factory
 * no longer clones restarts the attempt at `created`, since a funding of it would strand; money
 * there that could be the funding strands it instead. Every answer is written over the record as
 * read here, so a record that moved during the reads declines it.
 */
async function preconditions(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  rotation: PersistedRotation,
): Promise<{ patch: Patch; wait?: FlowWait } | undefined> {
  const fenced =
    (patch: Patch): Patch =>
    (c) =>
      unmoved(c, record) ? patch(c) : null
  const verdict = await readFundability(deps, rotation)
  switch (verdict) {
    case "fundable":
      return (await deps.route(rotation)) === "ok"
        ? undefined
        : { patch: fenced((c) => attention(c, "route")) }
    case "conflict":
      return { patch: fenced(() => CONFLICT) }
    case "applied":
      return { patch: fenced(await installedPatch(deps, rotation)) }
    case "applied-pending":
      return { patch: fenced(() => ({})), wait: "applied-pending" }
    case "superseded": {
      const held = (await readDeposit(deps, rotation.sipa, fundingFloor(record.plan))).held
      return { patch: fenced((c) => (held ? attention(c, "stranded") : RESTART)) }
    }
    default: {
      // Returning nothing would publish or fund, so a verdict this switch does not know stops it.
      const unknown: never = verdict
      throw new WalletError("invariant", `backup rotation: unknown fundability ${String(unknown)}`)
    }
  }
}

/**
 * `signed` → `published`: the deposit address is written to the rail and its broadcast enqueued; what
 * the executor already counted stays.
 */
export async function publishRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<FlowResult> {
  const rotation = whole(record)
  if (!rotation || record.phase !== "signed") throw new RotationFlowError("phase", "not signed")
  const stop = await preconditions(deps, record, rotation)
  if (stop) return { record: await save(deps, record, stop.patch), wait: stop.wait }
  await deps.publish(record, rotation)
  return {
    record: await save(deps, record, (c) =>
      unmoved(c, record)
        ? { phase: "published", publish: c.publish ?? { count: 0, history: [] } }
        : null,
    ),
  }
}

/**
 * `published` → `funded`: one funding send, its entry appended before it goes out, with the prover
 * tip it carries written on the plan in the same write. The hash is written to the record and the
 * tracker's row before the node takes the transaction; a write that fails aborts the send, as does
 * a record a resume parked meanwhile. A throw before the hash marks the entry `never-sent`; the
 * phase moves on the hash alone. A deposit address that already holds the funding, settled, moves
 * on with no send.
 */
export async function fundRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  proverTip = 0n,
): Promise<FlowResult> {
  const rotation = whole(record)
  if (!rotation || record.phase !== "published")
    throw new RotationFlowError("phase", "not published")
  if (inFlight(record)) throw new RotationFlowError("funding-open", "a funding may still land")
  const stop = await preconditions(deps, record, rotation)
  if (stop) return { record: await save(deps, record, stop.patch), wait: stop.wait }
  if (await depositFunded(deps, record)) {
    return {
      record: await save(deps, record, (c) => (unmoved(c, record) ? { phase: "funded" } : null)),
    }
  }
  const attemptId = fundingStarted(record) ? deps.mintAttemptId() : record.attemptId
  const entry: BackupFunding = {
    attemptId,
    localId: fundingLocalId(attemptId),
    sentAt: deps.now(),
    session: deps.session,
    outcome: "pending",
  }
  const seeded = await save(deps, record, (c) =>
    unmoved(c, record)
      ? {
          ...(c.plan ? { plan: tippedPlan(c.plan, proverTip) } : {}),
          fundings: [...c.fundings, entry],
        }
      : null,
  )
  const pending = (c: BackupRotationRecord) =>
    c.fundings.some((f) => f.attemptId === attemptId && f.outcome === "pending")
  const withEntry = (c: BackupRotationRecord, fields: Partial<BackupFunding>) =>
    c.fundings.map((f) => (f.attemptId === attemptId ? { ...f, ...fields } : f))
  /** Writes `fields` on the entry while it is still pending; a resolved entry declines the write. */
  const patchEntry = (fields: Partial<BackupFunding>) =>
    save(deps, seeded, (c) => (pending(c) ? { fundings: withEntry(c, fields) } : null))
  const onTxHash: TxHashCallback = async (txHash, { expiresAtMs }) => {
    try {
      await save(deps, seeded, (c) =>
        pending(c) && c.phase === "published"
          ? { phase: "funded", fundings: withEntry(c, { txHash: txHash as Hex, expiresAtMs }) }
          : null,
      )
    } catch (err) {
      throw new FundingCheckpointError(err)
    }
    try {
      await deps.tracker.stamp(entry.localId, txHash)
    } catch (err) {
      await save(deps, seeded, (c) =>
        pending(c)
          ? {
              ...(c.phase === "funded" ? { phase: "published" } : {}),
              fundings: withEntry(c, { outcome: "never-sent" }),
            }
          : null,
      ).catch(() => undefined)
      throw new FundingCheckpointError(err)
    }
  }
  try {
    await deps.fund(seeded, entry, onTxHash)
  } catch (err) {
    try {
      const current = await deps.store.get(record.owner)
      const sent = current?.fundings.find((f) => f.attemptId === attemptId)
      if (sent && !sent.txHash && sent.outcome === "pending") {
        await patchEntry({ outcome: "never-sent" })
      }
    } catch {
      // The entry stays pending; a resume ends it.
    }
    throw err
  }
  const after = await deps.store.get(record.owner)
  if (after?.attemptId !== record.attemptId) throw new RotationFlowError("gone", "attempt is gone")
  return { record: after }
}

/**
 * `funded` → `swept`: the deposit address's sweep, counted once its block is settled; it supersedes
 * a stranded report, except on a finished attempt, which keeps nothing to move on with. A sweep gone
 * before it settles returns the record to `funded`; the publish bound reached with the funding
 * unswept, a route that died, or a withdrawal row naming another address are reported as attention.
 */
export async function watchRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<FlowResult> {
  const watching =
    record.phase === "funded" ||
    record.phase === "swept" ||
    (record.phase === "attention" &&
      record.attention === "stranded" &&
      record.suspended !== "done" &&
      record.suspended !== "recovered")
  const sipa = record.rotation?.sipa
  if (!watching || !sipa || record.fromBlock === undefined)
    throw new RotationFlowError("phase", "nothing to watch")
  /** Every write is over the record as this watch read it; one that moved since declines. */
  const fenced =
    (patch: Patch): Patch =>
    (c) =>
      unmoved(c, record) ? patch(c) : null
  const sweep = await deps.l1.sweep(sipa, record.fromBlock)
  if (sweep) {
    if (!(await deps.l1.isSettled(sweep))) return { record, wait: "sweep", soon: true }
    const { fundings, corrupt } = await reconcileFundings(deps, record)
    return {
      record: await save(
        deps,
        record,
        fenced((c) => ({
          fundings,
          ...(corrupt ? attention(c, "corrupt") : sweptPatch(sweep)(c)),
        })),
      ),
    }
  }
  if (record.sweep) {
    return {
      record: await save(
        deps,
        record,
        fenced(() => ({ phase: "funded", sweep: undefined, ...CLEARED })),
      ),
    }
  }
  const rotation = whole(record)
  // A stranded report stays: nothing is sent from there, and a route park could be cancelled.
  const stranded = record.phase === "attention" && record.attention === "stranded"
  if (rotation && !stranded && (await deps.route(rotation)) !== "ok") {
    return {
      record: await save(
        deps,
        record,
        fenced((c) => attention(c, "route")),
      ),
    }
  }
  const count = record.publish?.count ?? 0
  if (count >= PUBLISH_BOUND && (await readDeposit(deps, sipa)).settled) {
    return {
      record: await save(
        deps,
        record,
        fenced((c) => attention(c, "stranded")),
      ),
    }
  }
  // The relayer drops a waiting sweep on its own clock; a funded address is published again on the interval.
  if (
    record.phase === "funded" &&
    count < PUBLISH_BOUND &&
    publishLanded(record, 0) &&
    publishDue(record.publish, deps.now()).due
  )
    await deps.republish(record)
  return { record, wait: "sweep" }
}

/** `swept` or `installed` → `rerooted`: the wallet runs on the two-key account. */
export async function rerootRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<BackupRotationRecord> {
  if (record.phase !== "swept" && record.phase !== "installed") {
    throw new RotationFlowError("phase", "not swept")
  }
  const checkpoint = async (fields: RerootCheckpoints) => {
    await save(deps, record, (c) =>
      c.phase === record.phase ? { reroot: { ...c.reroot, ...fields } } : null,
    )
  }
  // Read before the switch, so the figure is saved by the time Home counts it.
  if (!record.reroot?.switched) {
    const read = await readOneKeyBalances(deps.move)
    if (read.length > 0) {
      await save(deps, record, (c) => (c.phase === record.phase ? withBalances(c, read) : null))
    }
  }
  const reroot = await deps.reroot(record, checkpoint)
  return save(deps, record, (c) =>
    c.phase === record.phase ? { phase: "rerooted", reroot: { ...c.reroot, ...reroot } } : null,
  )
}

/**
 * The one-key account's balance in each move token `known` lacks; a token whose read fails is left
 * out.
 */
async function readOneKeyBalances(
  move: MoveDeps,
  known: readonly TokenAmount[] = [],
): Promise<TokenAmount[]> {
  const tokens = (await bestEffort("unknown", move.tokens())) ?? []
  const read = await Promise.all(
    tokens
      .filter((token) => !known.some((b) => b.token === token))
      .map((token) =>
        bestEffort(
          "unknown",
          move.shape(token).then(({ balance }) => ({ token, amount: `${balance}` })),
        ),
      ),
  )
  return read.filter((balance) => balance !== undefined)
}

/** `read` over the saved balances: a token whose read failed keeps its earlier figure. */
const withBalances = (c: BackupRotationRecord, read: readonly TokenAmount[]) => ({
  reroot: {
    ...c.reroot,
    oneKeyBalances: [
      ...(c.reroot?.oneKeyBalances ?? []).filter((b) => !read.some((r) => r.token === b.token)),
      ...read,
    ],
  },
})

/** The tokens the re-root's read missed, saved while a paylink refund holds the first run. */
async function fillOneKeyBalances(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<BackupRotationRecord> {
  const read = await readOneKeyBalances(deps.move, record.reroot?.oneKeyBalances)
  if (read.length === 0) return record
  return save(deps, record, (c) =>
    c.phase === record.phase && !c.move?.runs.length ? withBalances(c, read) : null,
  )
}

const sendDone = (c: MoveSend<string>) =>
  c.state === "mined" || (c.state === "included" && c.effect !== "reverted")
/** A send a claim holds or the node still decides: claimed, submitted, or included with its transaction reverted and not checkpointed. */
const sendOpen = (c: MoveSend<string>) =>
  c.state === "claimed" ||
  c.state === "submitted" ||
  (c.state === "included" && c.effect === "reverted")

/** The latest run with `fields` written on its chunk at `at`, and `run` on the run. */
const runsWith = (
  c: BackupRotationRecord,
  at: number,
  fields: Partial<MoveChunkRecord>,
  run: Partial<MoveRun> = {},
): Partial<BackupRotationRecord> => {
  const runs = c.move?.runs ?? []
  const latest = runs.at(-1)!
  const chunks = latest.chunks.map((x, i) => (i === at ? { ...x, ...fields } : x))
  return { move: { runs: [...runs.slice(0, -1), { ...latest, ...run, chunks }] } }
}

/**
 * The sends after their transactions are read again; nothing is read for a send with no hash, and
 * one saved with no expiry ends by receipt alone. A send is `mined` once an L1 checkpoint holds it;
 * one that reverted there is planned again by `replan`. A claim from another life of the wallet has
 * no send behind it and is planned again.
 */
async function readSends<T extends MoveSend<string>>(
  deps: RotationFlowDeps,
  sends: readonly T[],
  replan: (send: T) => T,
): Promise<T[]> {
  return Promise.all(
    sends.map(async (send): Promise<T> => {
      if (send.state === "claimed") {
        return send.claim?.session === deps.session ? send : replan(send)
      }
      if (!send.txHash || send.state === "mined") return send
      const outcome = await txOutcome(deps.node, send.txHash, send.expiresAtMs, deps.now())
      switch (outcome.kind) {
        case "included": {
          const inclusion = { blockNumber: outcome.blockNumber, blockHash: outcome.blockHash }
          if (outcome.checkpointed) {
            return outcome.effect === "reverted"
              ? replan(send)
              : { ...send, state: "mined", inclusion, effect: undefined }
          }
          return {
            ...send,
            state: "included",
            inclusion,
            ...(outcome.effect === "reverted"
              ? { effect: "reverted" as const }
              : { effect: undefined }),
          }
        }
        case "mined":
          return { ...send, state: "mined", effect: undefined }
        case "reverted":
        case "dead":
          return replan(send)
        case "pending":
          return send.state === "included"
            ? { ...send, state: "submitted", inclusion: undefined, effect: undefined }
            : send
        default:
          return send
      }
    }),
  )
}

const replanChunk = (c: MoveChunkRecord): MoveChunkRecord => ({
  token: c.token,
  amount: c.amount,
  state: "planned",
})
const replanRefund = (r: LinkRefundRecord): LinkRefundRecord => ({ link: r.link, state: "planned" })

/** A fresh cut of what the run still owes, over the live shape. */
async function cut(deps: RotationFlowDeps, token: string, owed: bigint) {
  const shape = await deps.move.shape(token)
  const deposits = await deps.move.deposits(token, shape)
  const balance = owed < shape.balance ? owed : shape.balance
  return planMove({ ...shape, balance }, await deps.move.cap(token), deposits)
}

/**
 * `rerooted` → `moved` → `done`: the one-key account's open paylinks taken back first, then its
 * balance forwarded in chunks, one sponsored transfer per chunk, each re-cut from the live shape and
 * sent only while no chunk of the run is in flight and the user has not closed the run's last
 * prompt. `moved` once every chunk is included; `done` once every chunk is checkpointed and nothing
 * is left to move. With `prompt` off, or its `signal` aborted, the next send waits at `approval`.
 */
export async function moveRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  { prompt = true, signal }: RunOptions = {},
): Promise<FlowResult> {
  if (record.phase !== "rerooted" && record.phase !== "moved") {
    throw new RotationFlowError("phase", "not rerooted")
  }
  let runs = record.move?.runs ?? []
  let run = runs.at(-1)
  let current = record
  if (!run) {
    const links = await takeBackLinks(deps, current, { prompt, signal })
    if ("stop" in links) return links.stop
    current = links.settled
  }
  /** Writes over the runs as this step read them; a chunk another step moved since declines it. */
  const write =
    (snapshot: BackupRotationRecord, fields: Partial<BackupRotationRecord>): Patch =>
    (c) =>
      c.phase === snapshot.phase && sameRuns(c, snapshot) ? fields : null
  if (run) {
    const chunks = await readSends(deps, run.chunks, replanChunk)
    run = { ...run, chunks }
    runs = [...runs.slice(0, -1), run]
    current = await save(deps, current, write(current, { move: { runs } }))
    if (chunks.some(sendOpen)) return { record: current, wait: "chunk" }
    const planned = chunks.filter((c) => c.state === "planned")
    if (planned.length > 0) {
      const kept = chunks.filter(sendDone)
      const recut: MoveChunkRecord[] = []
      let depositBound = run.depositBound
      for (const token of new Set(planned.map((c) => c.token))) {
        const owed = planned
          .filter((c) => c.token === token)
          .reduce((t, c) => t + BigInt(c.amount), 0n)
        const fresh = await cut(deps, token, owed)
        depositBound ||= fresh.bound === "upper"
        recut.push(
          ...fresh.chunks.map((c) => ({
            token,
            amount: c.amount.toString(),
            state: "planned" as const,
          })),
        )
      }
      run = {
        ...run,
        m: kept.length + recut.length,
        depositBound,
        // A decline holds only over a chunk still to send.
        declined: recut.length > 0 ? run.declined : undefined,
        chunks: [...kept, ...recut],
      }
      runs = [...runs.slice(0, -1), run]
      current = await save(deps, current, write(current, { move: { runs } }))
    }
  }
  if (!run || run.chunks.every(sendDone)) {
    if (run && !run.chunks.every((c) => c.state === "mined")) {
      // Nothing new until the run is checkpointed: a chunk that drops out is resent in this run.
      return {
        record: await save(deps, current, (c) =>
          c.phase === "rerooted" ? { phase: "moved" } : {},
        ),
        wait: "chunk",
      }
    }
    const fresh: MoveChunkRecord[] = []
    let depositBound = false
    for (const token of await deps.move.tokens()) {
      const shape = await deps.move.shape(token)
      const deposits = await deps.move.deposits(token, shape)
      const plan = planMove(shape, await deps.move.cap(token), deposits)
      depositBound ||= plan.bound === "upper"
      fresh.push(
        ...plan.chunks.map((c) => ({
          token,
          amount: c.amount.toString(),
          state: "planned" as const,
        })),
      )
    }
    if (fresh.length === 0) return { record: await finishRotation(deps, current) }
    run = { plannedAt: deps.now(), m: fresh.length, depositBound, chunks: fresh }
    runs = [...runs, run]
    current = await save(deps, current, write(current, { phase: "rerooted", move: { runs } }))
  }
  return sendNextChunk(deps, current, { prompt, signal })
}

async function sendNextChunk(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  { prompt, signal }: RunOptions,
): Promise<FlowResult> {
  const runs = record.move!.runs
  const run = runs.at(-1)!
  const at = run.chunks.findIndex((c) => c.state === "planned")
  if (at < 0) return { record, wait: "chunk" }
  if (run.declined) return { record, wait: "declined" }
  if (!(await deps.move.usesLeft())) return { record, wait: "uses" }
  if (!prompt || signal?.aborted) return { record, wait: "approval" }
  const chunk = run.chunks[at]!
  // The claim is the send's ownership: a second send of the same chunk finds it taken and stops here.
  const claim = { id: deps.mintAttemptId(), session: deps.session }
  const claimed = await save(deps, record, (c) =>
    sameRuns(c, record) ? runsWith(c, at, { state: "claimed", claim }) : null,
  )
  /**
   * Writes `fields` on the chunk, and `runFields` on its run, while this send still holds the chunk,
   * over the rest as it reads now.
   */
  const patchHeld = (fields: Partial<MoveChunkRecord>, runFields?: Partial<MoveRun>) =>
    save(deps, claimed, (c) =>
      c.move?.runs.at(-1)?.chunks[at]?.claim?.id === claim.id
        ? runsWith(c, at, fields, runFields)
        : null,
    )
  const onTxHash: TxHashCallback = async (txHash, { expiresAtMs }) => {
    await patchHeld({ state: "submitted", claim: undefined, txHash: txHash as Hex, expiresAtMs })
  }
  let withdrawn = false
  try {
    await deps.move.send(chunk.token, BigInt(chunk.amount), onTxHash, signal)
  } catch (err) {
    // The screen the tap came from closed before the passkey answered: the chunk waits for the next tap.
    withdrawn = !!signal?.aborted && err === signal.reason
    const declined = !withdrawn && deps.move.declined(err)
    // A chunk that got its hash is past the claim; the write over it declines.
    await patchHeld(
      { state: "planned", claim: undefined },
      declined ? { declined: true } : undefined,
    ).catch(() => undefined)
    if (isSpendEnvelopeRefusal(err)) {
      return { record: await save(deps, record, (c) => attention(c, "move")) }
    }
    if (!declined && !withdrawn) throw err
  }
  await readSentChunk(deps, record, at)
  const after = await deps.store.get(record.owner)
  if (after?.attemptId !== record.attemptId) throw new RotationFlowError("gone", "attempt is gone")
  return {
    record: after,
    wait: withdrawn ? "approval" : moveDeclined(after) ? "declined" : "chunk",
  }
}

/**
 * Saves a chunk's block once its send resolves. A balance read can hold the chunk before the
 * driver's next step reads its receipt, and until its block is saved Home counts it twice.
 */
async function readSentChunk(deps: RotationFlowDeps, record: BackupRotationRecord, at: number) {
  const stored = await deps.store.get(record.owner)
  const sent = stored?.move?.runs.at(-1)?.chunks[at]
  if (!stored || sent?.state !== "submitted" || !sent.txHash) return
  const [seen] = await readSends(deps, [sent], replanChunk)
  if (!seen || !sendDone(seen)) return
  await save(deps, stored, (c) =>
    c.phase === stored.phase && sameRuns(c, stored) ? runsWith(c, at, seen) : null,
  ).catch(() => undefined)
}

/** Whether the refunds still read as the snapshot a step decided over. */
const sameRefunds = (c: BackupRotationRecord, snapshot: BackupRotationRecord) =>
  JSON.stringify(c.refunds ?? null) === JSON.stringify(snapshot.refunds ?? null)

/** The refunds with `fields` written on the link at `at`, and `extra` on the list. */
const refundsWith = (
  c: BackupRotationRecord,
  at: number,
  fields: Partial<LinkRefundRecord>,
  extra: Partial<LinkRefunds> = {},
): Partial<BackupRotationRecord> => {
  const refunds = c.refunds!
  const links = refunds.links.map((x, i) => (i === at ? { ...x, ...fields } : x))
  return { refunds: { ...refunds, ...extra, links } }
}

/**
 * The open paylinks taken back before the first run: listed once, one sponsored refund each, sent
 * while none is in flight and the user has not closed the last prompt. The run is planned once
 * every refund is checkpointed or its link was spent another way, so no chunk spends a refund the
 * sequencer could still drop.
 */
async function takeBackLinks(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  options: RunOptions,
): Promise<{ settled: BackupRotationRecord } | { stop: FlowResult }> {
  /** Writes over the refunds as this step read them, while no run is planned. */
  const write =
    (snapshot: BackupRotationRecord, fields: Partial<BackupRotationRecord>): Patch =>
    (c) =>
      c.phase === snapshot.phase && !c.move?.runs.length && sameRefunds(c, snapshot) ? fields : null
  let current = record
  if (!current.refunds) {
    const links = (await deps.move.links()).map((link) => ({ link, state: "planned" as const }))
    current = await save(deps, current, write(current, { refunds: { links } }))
  }
  const links = await readSends(deps, current.refunds!.links, replanRefund)
  const left = links.some((l) => l.state === "planned")
  // A decline holds only over a refund still to send.
  const declined = left && current.refunds!.declined
  current = await save(
    deps,
    current,
    write(current, { refunds: { links, ...(declined && { declined }) } }),
  )
  if (links.every((l) => l.state === "mined" || l.state === "skipped")) return { settled: current }
  // A refund still to land holds the first run, whose own read would otherwise name the balance.
  current = await fillOneKeyBalances(deps, current)
  if (links.some(sendOpen)) return { stop: { record: current, wait: "chunk" } }
  if (left) return { stop: await sendNextRefund(deps, current, options) }
  return { stop: { record: current, wait: "chunk" } }
}

/**
 * The next planned refund, after a link spent another way is skipped and one too close to its
 * expiry waits for it. A refund that fails over a link spent meanwhile is skipped too. A spend no
 * checkpoint holds yet waits, since its link reopens if a reorg drops it.
 */
async function sendNextRefund(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  { prompt, signal }: RunOptions,
): Promise<FlowResult> {
  if (record.refunds!.declined) return { record, wait: "declined" }
  let current = record
  const skip = (snapshot: BackupRotationRecord, at: number, link: string) =>
    save(deps, snapshot, (c) =>
      sameRefunds(c, snapshot) ? refundsWith(c, at, { link, state: "skipped" }) : null,
    )
  let at: number
  for (;;) {
    at = current.refunds!.links.findIndex((l) => l.state === "planned")
    if (at < 0) return { record: current, wait: "chunk" }
    const refundable = await deps.move.refundable(current.refunds!.links[at]!.link)
    if (refundable === "later") return { record: current, wait: "link" }
    if (refundable === "spending") return { record: current, wait: "chunk" }
    if (refundable === "now") break
    current = await skip(current, at, current.refunds!.links[at]!.link)
  }
  if (!(await deps.move.usesLeft())) return { record: current, wait: "uses" }
  if (!prompt || signal?.aborted) return { record: current, wait: "approval" }
  const { link } = current.refunds!.links[at]!
  const claim = { id: deps.mintAttemptId(), session: deps.session }
  const claimed = await save(deps, current, (c) =>
    sameRefunds(c, current) ? refundsWith(c, at, { state: "claimed", claim }) : null,
  )
  /** Writes `fields` on the link, and `extra` on the list, while this send still holds it. */
  const patchHeld = (fields: Partial<LinkRefundRecord>, extra?: Partial<LinkRefunds>) =>
    save(deps, claimed, (c) =>
      c.refunds?.links[at]?.claim?.id === claim.id ? refundsWith(c, at, fields, extra) : null,
    )
  const onTxHash: TxHashCallback = async (txHash, { expiresAtMs }) => {
    await patchHeld({ state: "submitted", claim: undefined, txHash: txHash as Hex, expiresAtMs })
  }
  let withdrawn = false
  let later = false
  try {
    await deps.move.refund(link, onTxHash, signal)
  } catch (err) {
    withdrawn = !!signal?.aborted && err === signal.reason
    const declined = !withdrawn && deps.move.declined(err)
    const refundable =
      withdrawn || declined ? "now" : await deps.move.refundable(link).catch(() => "now" as const)
    later = refundable === "later"
    await patchHeld(
      refundable === "spent"
        ? { link, state: "skipped", claim: undefined }
        : { state: "planned", claim: undefined },
      declined ? { declined: true } : undefined,
    ).catch(() => undefined)
    if (isSpendEnvelopeRefusal(err)) {
      return { record: await save(deps, current, (c) => attention(c, "move")) }
    }
    if (!declined && !withdrawn && refundable === "now") throw err
  }
  const after = await deps.store.get(record.owner)
  if (after?.attemptId !== record.attemptId) throw new RotationFlowError("gone", "attempt is gone")
  return {
    record: after,
    wait: withdrawn ? "approval" : moveDeclined(after) ? "declined" : later ? "link" : "chunk",
  }
}

/**
 * `moved` → `done`: the signature and the envelope leave the record, and the salt once no funding
 * can land unswept, the deposit address holds nothing, read now, and the sweep is no longer re-read.
 * An attempt with money there and no sweep to take it parks over `done` as stranded, unless the
 * sweep is gone: that money waits for the relayer's re-sweep.
 */
export async function finishRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<BackupRotationRecord> {
  const sipa = record.rotation?.sipa
  const held = !!sipa && !sweepGone(record) && (await depositHeld(deps, sipa))
  return save(deps, record, (c) => {
    if (!sameRuns(c, record)) return null
    const unswept = c.unswept || held
    const done = stripSettled({
      ...c,
      phase: "done",
      ...CLEARED,
      ...(unswept ? { unswept: true } : {}),
    })
    const park = !sweepGone(c) && (unswept || inFlight(c))
    return park ? { ...done, ...attention(done, "stranded") } : done
  })
}

/**
 * Runs the move again once the user asks: from `attention: move`, or after a declined prompt. It
 * runs as a resume, so the answer carries the sweep watch like every other.
 */
export async function retryMove(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  { signal }: RunOptions = {},
): Promise<FlowResult> {
  if (moveDeclined(record)) {
    return resumeRotation(
      deps,
      await save(deps, record, (c) => {
        if (!moveDeclined(c)) return null
        const runs = c.move?.runs ?? []
        return {
          ...(runs.length > 0 && {
            move: { runs: [...runs.slice(0, -1), { ...runs.at(-1)!, declined: undefined }] },
          }),
          ...(c.refunds && { refunds: { ...c.refunds, declined: undefined } }),
        }
      }),
      { prompt: true, signal },
    )
  }
  const suspended = record.suspended
  if (record.attention !== "move" || !suspended)
    throw new RotationFlowError("phase", "not a paused move")
  return resumeRotation(
    deps,
    await save(deps, record, (c) => (unmoved(c, record) ? { phase: suspended, ...CLEARED } : null)),
    { prompt: true, signal },
  )
}

// ---------------------------------------------------------------------------------------------
// Resume.

/** Whether anything shows a funding may have gone out for this record. */
export async function fundingEvidence(
  deps: Pick<RotationFlowDeps, "tracker" | "l1">,
  record: BackupRotationRecord,
): Promise<boolean> {
  if (record.fundings.some((f) => f.txHash || f.outcome === "mined" || f.outcome === "swept"))
    return true
  for (const funding of record.fundings) {
    const row = await deps.tracker.row(funding.localId)
    if (row?.l2TxHash) return true
  }
  return depositSeen(deps, record)
}

/**
 * The deposit address, read once at the latest block and once at the settled one (`at`, else read
 * now) against `floor`, the least that counts. Every decision about money there takes one of two
 * answers: `held` (on either block) guards whatever drops or strips the salt; `settled` is what the
 * flow counts on past the sweep window.
 */
interface Deposit {
  held: boolean
  settled: boolean
}

async function readDeposit(
  deps: Pick<RotationFlowDeps, "l1">,
  sipa: Address,
  floor = 1n,
  at?: SettledBlock,
): Promise<Deposit> {
  const latest = await deps.l1.sipaBalance(sipa, "latest")
  const settled = await deps.l1.sipaBalance(sipa, at)
  return { held: latest >= floor || settled >= floor, settled: settled >= floor }
}

async function depositHeld(deps: Pick<RotationFlowDeps, "l1">, sipa: Address): Promise<boolean> {
  return (await readDeposit(deps, sipa)).held
}

/** The plan's funding without its prover tip: what the burn carries before a speed is chosen. */
export function untippedFunding(
  plan: Pick<BackupRotationPlan, "fundingAmount" | "proverTip">,
): bigint {
  return BigInt(plan.fundingAmount) - BigInt(plan.proverTip ?? 0)
}

/** The plan funded with `tip` on top of its untipped funding; a zero tip leaves no field behind. */
function tippedPlan(plan: BackupRotationPlan, tip: bigint): BackupRotationPlan {
  const tipped = { ...plan, fundingAmount: (untippedFunding(plan) + tip).toString() }
  if (tip > 0n) tipped.proverTip = tip.toString()
  else delete tipped.proverTip
  return tipped
}

/**
 * The least that counts as this wallet's funding at the deposit address: the plan's deposit less
 * its credit's margin, which was the least the sweep could take when the plan was saved. The
 * funding lands at the plan's deposit, since the withdrawal's charges are fixed. Anyone can pay
 * the address once it is published, so less is someone else's and cannot finish the change. A
 * plan saved without its deposit counts any money.
 */
function fundingFloor(plan: BackupRotationPlan | undefined): bigint {
  const floor = plan?.deposited ? BigInt(plan.deposited) - BACKUP_FUNDING_MARGIN : 0n
  return floor > 0n ? floor : 1n
}

/** Whether this wallet's funding already reached the deposit address, so none need go out. */
async function depositFunded(
  deps: Pick<RotationFlowDeps, "l1">,
  record: BackupRotationRecord,
): Promise<boolean> {
  const sipa = record.rotation?.sipa
  if (!sipa) return false
  return (await readDeposit(deps, sipa, fundingFloor(record.plan))).settled
}

/**
 * Whether at least `floor` sits at the deposit address, or a sweep took some since the attempt
 * began.
 */
async function depositSeen(
  deps: Pick<RotationFlowDeps, "l1">,
  record: BackupRotationRecord,
  floor = 1n,
): Promise<boolean> {
  const sipa = record.rotation?.sipa
  if (!sipa) return false
  if ((await readDeposit(deps, sipa, floor)).held) return true
  return (await deps.l1.sweep(sipa, record.fromBlock ?? 0)) !== undefined
}

/**
 * The fundings as the tracker and the node show them now. A funding on L2 is swept once the portal
 * shows its withdrawal spent at the settled block (its money reached the deposit address) and
 * nothing is held there at that same block; before that the sweep may have taken someone else's
 * money and left this one to land later. A funding on L2 whose row is misfiled is never released:
 * `stuck`.
 */
async function reconcileFundings(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<{ fundings: BackupFunding[]; corrupt: boolean; stuck: boolean; burn: boolean }> {
  const sipa = record.rotation?.sipa
  let corrupt = false
  let stuck = false
  let burn = false
  const released = new Set<string>()
  // One settled block for every release read and the balance read that judges them together.
  let settledAt: Promise<SettledBlock> | undefined
  const settled = () => (settledAt ??= deps.l1.settledBlock())
  const judged = await Promise.all(
    record.fundings.map(async (funding): Promise<BackupFunding> => {
      if (!fundingLanding(funding)) return funding
      const row = await deps.tracker.row(funding.localId)
      const misfiled =
        row !== undefined &&
        ((sipa !== undefined && row.recipient.toLowerCase() !== sipa.toLowerCase()) ||
          (row.l2TxHash !== undefined &&
            funding.txHash !== undefined &&
            row.l2TxHash.toLowerCase() !== funding.txHash.toLowerCase()))
      if (misfiled) corrupt = true
      /** A funding on L2 (`onL2`) whose withdrawal is spent at the settled block had its money at the address. */
      const judge = async (f: BackupFunding, onL2: boolean) => {
        // Only a mined funding is stuck for good: an included one can still drop, so it stays polled.
        if (misfiled && f.outcome === "mined") stuck = true
        const releasing = onL2 && !misfiled && row?.phase === "done" && row.withdrawalId
        if (releasing && (await deps.l1.releaseSettled(row.withdrawalId!, await settled()))) {
          released.add(f.attemptId)
        }
        return f
      }
      if (funding.outcome === "mined") return judge(funding, true)
      // A hash only the row holds comes with no expiry: a receipt alone ends that funding.
      const txHash = funding.txHash ?? (row?.l2TxHash as Hex | undefined)
      if (txHash) {
        const outcome = await txOutcome(deps.node, txHash, funding.expiresAtMs, deps.now())
        const next =
          outcome.kind === "mined" || outcome.kind === "reverted" || outcome.kind === "dead"
            ? outcome.kind
            : "pending"
        // An included funding is still `pending` on the record, but its withdrawal can already be released.
        const onL2 =
          next === "mined" || (outcome.kind === "included" && outcome.effect === "success")
        return judge({ ...funding, txHash, outcome: next }, onL2)
      }
      // A send this life of the wallet started may still be between its entry and its row.
      const seededHere = funding.session === deps.session
      const burning = row?.phase === "submitting" && row.startTime >= deps.activeSince
      if (seededHere || burning) {
        burn = true
        return funding
      }
      return { ...funding, outcome: "never-sent" }
    }),
  )
  if (released.size === 0 || !sipa) return { fundings: judged, corrupt, stuck, burn }
  const at = await settled()
  // The reads above went by number: a block replaced under them is judged again next time.
  if (
    (await readDeposit(deps, sipa, 1n, at)).settled ||
    !(await deps.l1.isSettled({ blockNumber: at.number, blockHash: at.hash }))
  ) {
    return { fundings: judged, corrupt, stuck, burn }
  }
  const fundings = judged.map((f) =>
    released.has(f.attemptId) ? { ...f, outcome: "swept" as const } : f,
  )
  return { fundings, corrupt, stuck, burn }
}

/**
 * Runs the next step for a saved record, in a fixed order: the structural check, then what the
 * chain and the other stores already show, then the step the phase calls for. A read that cannot
 * complete leaves the record as it is. Without `prompt` a chunk's send stops at `approval`.
 */
export async function resumeRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  { prompt = false, signal }: RunOptions = {},
): Promise<FlowResult> {
  let current = record
  for (let reads = 1; ; reads++) {
    const result = await resumeOnce(deps, current, { prompt, signal })
    if (result !== MOVED) return result
    const fresh = await deps.store.get(record.owner)
    if (fresh?.attemptId !== record.attemptId)
      throw new RotationFlowError("gone", "attempt is gone")
    if (reads >= RESUME_READS) return { record: fresh }
    current = fresh
  }
}

const RESUME_READS = 3
const MOVED = Symbol("moved")

/**
 * One resume over the record as read. What the chain and the stores show is decided over that
 * snapshot and written in one step that declines once the store no longer matches it: `MOVED`,
 * and the caller reads again.
 */
async function resumeOnce(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  options: RunOptions,
): Promise<FlowResult | typeof MOVED> {
  let current = record
  // A damaged record is not checked again: the check reads the same record and keys, so it would fail
  // again and return before the record can end at `recovered`.
  const rotation = current.attention === "corrupt" ? undefined : whole(current)
  if (rotation) {
    let verdict: PersistedRotationVerdict
    try {
      verdict = await deps.verify(rotation)
    } catch (err) {
      if (err instanceof VerificationUnavailableError)
        return { record: current, wait: "unverifiable" }
      throw err
    }
    if (verdict.verdict === "corrupt") {
      return { record: await save(deps, current, (c) => attention(c, "corrupt")) }
    }
  }
  if (current.rotation && current.fromBlock !== undefined && current.phase !== "created") {
    const snapshot = current
    const sipa = current.rotation.sipa
    const fromBlock = current.fromBlock
    const { fundings, corrupt, stuck, burn } = await reconcileFundings(deps, snapshot)
    let wait: FlowWait | undefined
    let soon: true | undefined
    let sweep = snapshot.sweep
    let watched = false
    let decided: Patch
    if (corrupt) {
      decided = (c) => ({ fundings, ...attention(c, "corrupt") })
    } else {
      const phase = acting(snapshot)
      const awaitingFunds = phase === "published" || phase === "funded"
      const beforeSweep = awaitingFunds || phase === "signed"
      const landed = fundings.some((f) => f.txHash && fundingLanding(f))
      const funded = beforeSweep && !landed && !burn && (await depositFunded(deps, snapshot))
      const to =
        phase === "funded" && !landed && !burn && !funded
          ? "published"
          : phase === "published" && (landed || funded)
          ? "funded"
          : undefined
      // The sweep is re-read from `swept` on, a parked record included, while it is watched.
      const under = snapshot.phase === "attention" ? snapshot.suspended : snapshot.phase
      const rechecking = !!under && AFTER_SWEEP.includes(under) && sweepWatched(snapshot)
      // A read that fails changes nothing, and the step runs.
      const rechecked = rechecking
        ? await bestEffort("unknown", recheckSweep(deps, snapshot, sipa, fromBlock))
        : undefined
      sweep = rechecked?.sweep ?? sweep
      watched = rechecking && sweepWatched({ sweep })
      const moved: Partial<BackupRotationRecord> = {
        fundings,
        ...(to ? (snapshot.phase === "attention" ? { suspended: to } : { phase: to }) : {}),
        ...rechecked,
      }
      let then: Patch = () => ({})
      if (burn && acting({ ...snapshot, ...moved }) === "published") {
        wait = "burn"
      } else if (rotation && beforeSweep) {
        const seen = await deps.l1.sweep(sipa, fromBlock)
        // A published record's own wait is the user's: what settles on its own returns a polled one.
        const published = acting({ ...snapshot, ...moved }) === "published"
        if (seen) {
          if (await deps.l1.isSettled(seen)) then = sweptPatch(seen)
          else if (published) {
            wait = "sweep"
            soon = true
          }
        } else {
          const verdict = await readFundability(deps, rotation)
          if (verdict === "applied") {
            then = await installedPatch(deps, rotation)
          } else if (verdict === "applied-pending" && published) {
            wait = "applied-pending"
          } else if (verdict === "superseded" || verdict === "conflict") {
            // Money that could be the funding of a change that cannot run is the user's to recover.
            const held = (await readDeposit(deps, sipa, fundingFloor(snapshot.plan))).held
            const stop = verdict === "conflict" ? CONFLICT : RESTART
            then = (c) => (acting(c) === "funded" || held ? attention(c, "stranded") : stop)
          }
        }
      }
      decided = (c) => ({ ...moved, ...(then({ ...c, ...moved }) ?? {}) })
    }
    const finished = snapshot.phase === "done" || snapshot.phase === "recovered"
    // Money at the address while the sweep is gone waits for the re-sweep: not held.
    const held = finished && !sweepGone({ sweep }) && (await depositHeld(deps, sipa))
    try {
      current = await save(deps, snapshot, (c) => {
        if (!unmoved(c, snapshot)) return null
        const patch = decided(c)
        return finished
          ? stripSettled({ ...c, ...patch, ...(held ? { unswept: true } : {}) })
          : patch
      })
    } catch (err) {
      if (err instanceof RotationFlowError && err.code === "phase") return MOVED
      throw err
    }
    const watching = (result: FlowResult): FlowResult =>
      watched ? { ...result, watch: true } : result
    if (wait) return watching({ record: current, wait, ...(soon && { soon }) })
    // Nothing on chain releases a stuck funding: a wait would have the driver re-check it forever.
    if (stuck) return watching({ record: current })
    return watching(await step(deps, current, options))
  }
  return step(deps, current, options)
}

/** The record's next step from its phase. */
async function step(
  deps: RotationFlowDeps,
  current: BackupRotationRecord,
  options: RunOptions,
): Promise<FlowResult> {
  switch (current.phase) {
    case "signed":
      return publishRotation(deps, current)
    case "published":
      return { record: current, wait: "funding" }
    case "funded":
      return watchRotation(deps, current)
    case "swept":
    case "installed":
      return { record: await rerootRotation(deps, current) }
    case "rerooted":
    case "moved":
      return moveRotation(deps, current, options)
    case "attention":
      return resumeAttention(deps, current, options)
    case "done":
    case "recovered": {
      const late = await lateFunding(deps, current)
      // A dismissed record stays only while its sweep is watched.
      if (late.record.phase === "done" && late.record.dismissed && !sweepWatched(late.record)) {
        await deps.store.removeIf(
          current.owner,
          (c) => unmoved(c, late.record) && !!c.dismissed && !c.unswept && !sweepWatched(c),
        )
      }
      return late
    }
    default:
      return { record: current }
  }
}

/**
 * A parked record returns to the phase it left when the reason has passed: the route paying again,
 * a late sweep, money gone from the deposit address, nothing left to land there. Money gone by a
 * recovery ends the attempt at `recovered` once the recovery is settled, unless the signed change ran
 * anyway: then the backup is installed and the attempt goes on. A finished attempt stays parked
 * while money may sit there, with nothing run twice. A paused move waits for the user; a corrupt
 * record waits until its money is recovered.
 */
async function resumeAttention(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  options: RunOptions,
): Promise<FlowResult> {
  const suspended = record.suspended
  if (!suspended) return { record }
  const finished = suspended === "done" || suspended === "recovered"
  switch (record.attention) {
    case "route": {
      const rotation = whole(record)
      if (!rotation || (await deps.route(rotation)) !== "ok") return { record }
      return resumeRotation(
        deps,
        await save(deps, record, (c) =>
          unmoved(c, record) ? { phase: suspended, ...CLEARED } : null,
        ),
        options,
      )
    }
    case "stranded": {
      if (finished) return strandedStanding(deps, record, suspended)
      if (await nothingLanding(deps, record)) {
        const recovery = await currentRecovery(deps, record)
        if (recovery) {
          if (!(await recoverySettled(deps, recovery))) {
            return awaitRecovery(deps, record, recovery, true)
          }
          const rotation = whole(record)
          const live = rotation ? await readFundability(deps, rotation) : undefined
          if (live !== "applied" && live !== "applied-pending") {
            return { record: await save(deps, record, endRecovered(record, recovery)) }
          }
        }
        return resumeRotation(
          deps,
          await save(deps, record, (c) =>
            unmoved(c, record) ? { phase: suspended, ...CLEARED, recovery: undefined } : null,
          ),
          options,
        )
      }
      const watched = await watchRotation(deps, record)
      const rotation = whole(watched.record)
      if (
        watched.record.phase !== "attention" ||
        watched.record.attention !== "stranded" ||
        !rotation ||
        (await readFundability(deps, rotation)) !== "applied"
      ) {
        return watched
      }
      const install = await installedPatch(deps, rotation)
      const installed = await save(deps, watched.record, (c) =>
        unmoved(c, watched.record) ? install(c) : null,
      )
      return { record: await rerootRotation(deps, installed) }
    }
    case "corrupt": {
      // A damaged record never moves on, and cancelling refuses it over a funding, so it would block
      // every new add: once its money is recovered, end it.
      if (finished) return { record }
      // Read the recovery before the balance: the panel re-checks a damaged record only while this
      // returns a `wait`, so a recovery still settling must return one.
      const recovery = await currentRecovery(deps, record)
      if (!recovery) return { record }
      const emptied = await nothingLanding(deps, record)
      if (!emptied || !(await recoverySettled(deps, recovery))) {
        return awaitRecovery(deps, record, recovery, emptied)
      }
      return { record: await save(deps, record, endRecovered(record, recovery)) }
    }
    default:
      return { record }
  }
}

/**
 * The recovery's L1 transaction, read from the chain: none is noted when the tab closed before its
 * receipt.
 */
async function recoverySeen(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<BackupRotationRecord["recovery"]> {
  const sipa = record.rotation?.sipa
  if (!sipa || record.fromBlock === undefined) return undefined
  const txHash = await deps.l1.recovery(sipa, record.fromBlock)
  return txHash && { txHash }
}

/**
 * The recovery the attempt waits on. A saved one with no block may still be pending, so it stands
 * unless the chain shows another: dropped by a reorg, or followed by a recovery from Settings, it
 * would hold the attempt open for good.
 */
async function currentRecovery(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<BackupRotationRecord["recovery"]> {
  const saved = record.recovery
  if (!saved) return recoverySeen(deps, record)
  if (await deps.l1.txBlock(saved.txHash)) return saved
  return (await recoverySeen(deps, record)) ?? saved
}

/**
 * Whether the recovery's L1 block is settled. A deposit not settled yet reads as nothing held at
 * the settled block, so until then a reorg could drop the recovery alone and leave money at the
 * address with its salt gone.
 */
async function recoverySettled(
  deps: RotationFlowDeps,
  recovery: NonNullable<BackupRotationRecord["recovery"]>,
): Promise<boolean> {
  const block = await deps.l1.txBlock(recovery.txHash)
  return !!block && (await deps.l1.isSettled(block))
}

/**
 * Waits on a recovery still settling. One read from the chain is kept, as `noteRecovery` keeps one
 * the tab saw, so the card shows it as sent rather than offering a recovery again. Once the address
 * is `emptied`, that read is the recovery that took the money, so it replaces a saved one that
 * never landed; before then, the chain's latest may be older than a saved one still pending.
 */
async function awaitRecovery(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  recovery: NonNullable<BackupRotationRecord["recovery"]>,
  emptied: boolean,
): Promise<FlowResult> {
  const saved = record.recovery
  const kept = saved && (!emptied || saved.txHash.toLowerCase() === recovery.txHash.toLowerCase())
  if (kept || !recoverable(record)) return { record, wait: "recovery" }
  const noted = await save(deps, record, (c) => (unmoved(c, record) ? { recovery } : null))
  return { record: noted, wait: "recovery" }
}

/**
 * Ends the attempt at `recovered`. Callers check that nothing can land and the recovery is settled
 * first, so `stripSettled` drops the salt along with the signature and the envelope.
 */
const endRecovered =
  (record: BackupRotationRecord, recovery: NonNullable<BackupRotationRecord["recovery"]>): Patch =>
  (c) =>
    unmoved(c, record)
      ? stripSettled({
          ...c,
          phase: "recovered",
          ...CLEARED,
          unswept: undefined,
          recovery,
          recovered: recovery,
        })
      : null

/** Whether nothing can reach the deposit address any more: no funding landing, no sweep, nothing held. */
async function nothingLanding(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<boolean> {
  const sipa = record.rotation?.sipa
  if (!sipa || record.fromBlock === undefined || inFlight(record) || record.sweep) return false
  if (await deps.l1.sweep(sipa, record.fromBlock)) return false
  return !(await depositHeld(deps, sipa))
}

/**
 * A finished attempt parked over money at its deposit address returns to its phase once nothing can
 * land there, nothing is held and a recovery that took it is settled; the salt leaves with it. It
 * returns at once while the sweep is gone: that money waits for the re-sweep, and the salt stays.
 */
async function strandedStanding(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  suspended: BackupRotationPhase,
): Promise<FlowResult> {
  const sipa = record.rotation?.sipa
  if (!sipa) return { record }
  const gone = sweepGone(record)
  if (!gone && (inFlight(record) || (await depositHeld(deps, sipa)))) return { record }
  const recovery = gone ? undefined : await currentRecovery(deps, record)
  if (recovery && !(await recoverySettled(deps, recovery))) {
    return awaitRecovery(deps, record, recovery, true)
  }
  return {
    record: await save(deps, record, (c) =>
      unmoved(c, record)
        ? stripSettled({ ...c, phase: suspended, ...CLEARED, unswept: undefined })
        : null,
    ),
  }
}

/**
 * A finished attempt with money that may sit at its deposit address is reported: a funding on L2
 * with no sweep to take it, money held after the change ran, or money at the address now. Not while
 * the sweep is gone: that money waits for the re-sweep.
 */
async function lateFunding(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<FlowResult> {
  const sipa = record.rotation?.sipa
  if (!sipa || sweepGone(record)) return { record }
  const held = inFlight(record) || record.unswept || (await depositHeld(deps, sipa))
  if (!held) return { record }
  // Drop the earlier recovery: kept, it would read as sent for this new money and end the new park on
  // the old transaction.
  return {
    record: await save(deps, record, (c) =>
      unmoved(c, record) ? { ...attention(c, "stranded"), recovery: undefined } : null,
    ),
  }
}

/**
 * Whether the user may send the deposit address's money back out: from a stranded record, or a
 * damaged one that cannot be cancelled. A damaged record that can be cancelled is started over.
 * Never while the sweep is gone: that money is the relayer's to sweep again. The panel shows its
 * recovery card on the same test, so it never offers what `noteRecovery` would refuse.
 */
export const recoverable = (record: BackupRotationRecord): boolean =>
  record.phase === "attention" &&
  !sweepGone(record) &&
  (record.attention === "stranded" || (record.attention === "corrupt" && !cancellable(record)))

/**
 * Where an attempt whose funding has to go back stands: held at the deposit address, sent back
 * and waiting for Ethereum to settle it, or recovered. Undefined for every other attempt.
 */
export type RecoveryState = "held" | "sent" | "recovered"

export function recoveryState(record: BackupRotationRecord): RecoveryState | undefined {
  if (record.phase === "recovered") return "recovered"
  if (!recoverable(record)) return undefined
  return record.recovery ? "sent" : "held"
}

/**
 * Keeps the L1 transaction that sent the deposit address's money back out on a parked attempt. The
 * attempt stays parked until the recovery is settled: a resume ends it once nothing can land and the
 * address holds nothing.
 */
export async function noteRecovery(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
  txHash: Hex,
): Promise<BackupRotationRecord> {
  return save(deps, record, (c) => (recoverable(c) ? { recovery: { txHash } } : null))
}

/**
 * The user left the done screen. The record goes once its sweep is no longer re-read; until then
 * it stays, marked, and the resume removes it when the watch closes. Both fenced on the record as
 * the screen showed it.
 */
export async function dismissRotation(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
): Promise<void> {
  if (record.phase === "done" && sweepWatched(record)) {
    await save(deps, record, (c) => (unmoved(c, record) ? { dismissed: true } : null))
    return
  }
  await deps.store.removeIf(record.owner, (c) => unmoved(c, record))
}

/** Whether the user may still drop the attempt from this state. */
export function cancellable(record: BackupRotationRecord): boolean {
  if (inFlight(record)) return false
  switch (record.phase) {
    case "created":
    case "signed":
    case "conflict":
      return true
    case "published":
      return !record.fundings.some(fundingLanding)
    case "attention":
      return (
        (record.attention === "route" || record.attention === "corrupt") &&
        record.suspended !== undefined &&
        cancellable({ ...record, phase: record.suspended, ...CLEARED })
      )
    default:
      return false
  }
}

/**
 * Drops the attempt. The stored record decides: it is read, judged and removed as read. The salt
 * leaves with the record, so one is dropped only while its deposit address holds nothing that could
 * be the funding; no funding of this wallet's is landing by then. A corrupt record, whose plan is
 * not trusted, stays over any trace of a funding.
 */
export async function cancelRotation(
  deps: Pick<RotationFlowDeps, "store" | "tracker" | "l1">,
  record: BackupRotationRecord,
): Promise<void> {
  const current = await deps.store.get(record.owner)
  if (!current) return
  if (current.attemptId !== record.attemptId)
    throw new RotationFlowError("gone", "the attempt moved on")
  if (inFlight(current)) throw new RotationFlowError("funding-open", "a funding may still land")
  if (!cancellable(current))
    throw new RotationFlowError("not-cancellable", `${current.phase} cannot be cancelled`)
  const seen =
    current.attention === "corrupt"
      ? fundingEvidence(deps, current)
      : depositSeen(deps, current, fundingFloor(current.plan))
  if (await seen) {
    throw new RotationFlowError("not-cancellable", "money may have reached the deposit address")
  }
  const removed = await deps.store.removeIf(
    record.owner,
    (c) => c.attemptId === current.attemptId && unmoved(c, current) && cancellable(c),
  )
  if (removed) return
  if (!(await deps.store.get(record.owner))) return
  throw new RotationFlowError("phase", "the record moved on")
}

// ---------------------------------------------------------------------------------------------
// The republish accounting the broadcast executor keeps on the record. Each write is for the signed
// change the executor read; a record re-signed since declines it.

/** Whether the broadcast may be sent again now, else when. */
export function publishDue(
  publish: BackupPublish | undefined,
  now: number,
): { due: true } | { due: false; at: number } {
  const lastAt = publish?.lastAt
  if (lastAt === undefined || now >= lastAt + PUBLISH_INTERVAL_MS) return { due: true }
  return { due: false, at: lastAt + PUBLISH_INTERVAL_MS }
}

const sameChange = (c: BackupRotationRecord, record: BackupRotationRecord) =>
  c.rotation?.sipa !== undefined && c.rotation.sipa === record.rotation?.sipa

/** Counts a send before it goes out, so an interrupted publication counts. */
export async function recordPublishSend(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
): Promise<BackupRotationRecord> {
  return save(deps, record, (c) => {
    if (!sameChange(c, record)) return null
    const publish = c.publish ?? { count: 0, history: [] }
    return { publish: { ...publish, count: publish.count + 1, lastAt: deps.now() } }
  })
}

export async function recordPublishHash(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
  txHash: Hex,
): Promise<BackupRotationRecord> {
  return save(deps, record, (c) =>
    sameChange(c, record)
      ? { publish: { ...(c.publish ?? { count: 0, history: [] }), txHash } }
      : null,
  )
}

export async function recordPublishLanded(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
  landed: { txHash: Hex; l2Block: number },
): Promise<BackupRotationRecord> {
  return save(deps, record, (c) => {
    if (!sameChange(c, record)) return null
    const publish = c.publish ?? { count: 0, history: [] }
    return {
      publish: {
        ...publish,
        txHash: landed.txHash,
        l2Block: landed.l2Block,
        history: [...publish.history, { ...landed, at: deps.now() }],
      },
    }
  })
}

/** Whether a publication landed at or past `since`, the scheduler's floor for the job. */
export function publishLanded(record: BackupRotationRecord, since: number): boolean {
  return (record.publish?.history ?? []).some((h) => h.l2Block >= since)
}
