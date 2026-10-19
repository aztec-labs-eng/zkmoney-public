import { NO_FROM } from "@aztec/aztec.js/account"
import { TxHash, TxExecutionResult } from "@aztec/stdlib/tx"
import { broadcastL1Operation } from "@oxide/oxide-client/broadcaster_calls.js"
import type { BroadcastL1Operation } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { FrozenRefundKind, MigrationFundingBatch } from "@obsidion/core/types"
import { keccak256, toHex, type Address } from "viem"
import type { MetadataMigrationSource, MigrationSourceQuote } from "./MetadataMigrationService.js"
import type { LiveMetadataMigrationSourceOptions } from "./LiveMetadataMigrationSource.js"
import { buildClaimSponsorPayload } from "../feePaymentMethod/claimSponsoredCall.js"
import { claimFpcSponsoredFee } from "../feePaymentMethod/claimFpcBatchGas.js"
import {
  ApprovalNeededError,
  MigrationHaltedError,
  readOrdinaryDepositFee,
  StalePlanError,
} from "./metadataMigration.js"
import {
  migrationDepositCalls,
  migrationSipaCoordinates,
  receiveMigrationSweeps,
  resolveMigrationDeposit,
  type MigrationDestinationContext,
} from "./migrationDeposit.js"

export interface FrozenRefundCandidate {
  /** The portal refund nullifier. */
  id: string
  amount: string
  kind: FrozenRefundKind
}

export interface FrozenRefundSelection {
  kind: FrozenRefundKind
  ids: string[]
}

export interface FrozenRefundCandidates {
  maxNotesPerBatch: number
  /** The portal's per-refund amount cap. */
  maxBatchAmount: bigint
  candidates: FrozenRefundCandidate[]
  /** Unprocessed deposits the portal refunds only once the old network closes their Inbox tree. */
  waiting?: bigint
}

/** Implemented inside the source generation. No source Aztec objects cross this boundary. */
export interface FrozenMigrationRuntime {
  /** Pins the source account, chain, portal, asset, executor and proof generation. */
  identity: string
  /** Validate the source deployment, freeze state, and destination funding asset on chain. */
  validate(destinationAsset: Address): Promise<void>
  /**
   * Fresh source data of the kinds this runtime refunds, excluding nullifiers already refunded on
   * L1. Errors must propagate. `fresh` re-reads what the runtime may memoize between calls.
   */
  candidates(opts?: { fresh?: boolean }): Promise<FrozenRefundCandidates>
  /** Prove this exact selection. The runtime validates recipient, tip, and source spentness. */
  build(
    selection: FrozenRefundSelection,
    recipient: Address,
    relayerTip: bigint,
  ): Promise<{
    amount: bigint
    operation: BroadcastL1Operation
  }>
  /** Positive on-chain refund evidence for every selected identifier. */
  refunded(ids: string[]): Promise<boolean>
}

/** The covering note subset is searched exactly over this many of the largest notes. */
const EXACT_COVER_NOTES = 16

type Note = { id: string; amount: bigint }

/** The smallest-total subset of `notes` (largest first) reaching `need` within the count and amount caps. */
function coverNotes(notes: Note[], need: bigint, maxCount: number, cap: bigint) {
  const pool = notes.slice(0, EXACT_COVER_NOTES)
  const suffix = pool.map((_, i) => pool.slice(i).reduce((sum, n) => sum + n.amount, 0n))
  let best: Note[] | undefined
  let bestSum = 0n
  const chosen: Note[] = []
  const visit = (i: number, sum: bigint) => {
    if (sum >= need) {
      if (!best || sum < bestSum || (sum === bestSum && chosen.length < best.length)) {
        best = [...chosen]
        bestSum = sum
      }
      return
    }
    if (i === pool.length || chosen.length === maxCount || sum + suffix[i]! < need) return
    if (best && sum >= bestSum) return
    const note = pool[i]!
    if (sum + note.amount <= cap) {
      chosen.push(note)
      visit(i + 1, sum + note.amount)
      chosen.pop()
    }
    visit(i + 1, sum)
  }
  visit(0, 0n)
  return best
}

/**
 * The next refund batch that nets more than `minimumNetAmount` after the relayer tip, or none.
 *
 * A deposit is refunded alone. Notes take the covering subset with the smallest total, so later
 * batches stay affordable, then the smallest remaining notes ride along up to the caps. This is a
 * heuristic, not an optimal partition: whatever no affordable batch can take is a stranded residual.
 */
export function selectFrozenBatch(o: {
  candidates: FrozenRefundCandidate[]
  maxNotesPerBatch: number
  maxBatchAmount: bigint
  minimumNetAmount: bigint
  tip: bigint
}): { kind: FrozenRefundKind; ids: string[]; amount: bigint } | undefined {
  if (
    !Number.isSafeInteger(o.maxNotesPerBatch) ||
    o.maxNotesPerBatch < 1 ||
    o.maxBatchAmount <= 0n ||
    o.minimumNetAmount <= 0n
  ) {
    throw new Error("Invalid frozen-source batch limit or funding quote")
  }
  const ids = new Set<string>()
  for (const c of o.candidates) {
    if (BigInt(c.amount) <= 0n || ids.has(c.id)) throw new Error("Invalid frozen-source candidate")
    ids.add(c.id)
  }
  const need = o.minimumNetAmount + o.tip
  const notes = o.candidates
    .filter((c) => c.kind === "note")
    .map((c) => ({ id: c.id, amount: BigInt(c.amount) }))
    .sort((a, b) => (a.amount === b.amount ? (a.id < b.id ? -1 : 1) : a.amount > b.amount ? -1 : 1))
  const cover = coverNotes(notes, need, o.maxNotesPerBatch, o.maxBatchAmount)
  if (cover) {
    let amount = cover.reduce((sum, n) => sum + n.amount, 0n)
    const batch = cover.map((n) => n.id)
    for (const note of [...notes].reverse()) {
      if (batch.length === o.maxNotesPerBatch) break
      if (batch.includes(note.id) || amount + note.amount > o.maxBatchAmount) continue
      batch.push(note.id)
      amount += note.amount
    }
    return { kind: "note", ids: batch, amount }
  }
  const deposit = o.candidates
    .filter((c) => c.kind !== "note")
    .map((c) => ({ ...c, value: BigInt(c.amount) }))
    .filter((c) => c.value >= need && c.value <= o.maxBatchAmount)
    .sort((a, b) => (a.value === b.value ? (a.id < b.id ? -1 : 1) : a.value > b.value ? -1 : 1))[0]
  return deposit && { kind: deposit.kind, ids: [deposit.id], amount: deposit.value }
}

type Options = Pick<
  LiveMetadataMigrationSourceOptions,
  | "client"
  | "wallet"
  | "destination"
  | "selfResolver"
  | "token"
  | "tokenService"
  | "broadcaster"
  | "registered"
  | "owner"
  | "batches"
> & {
  runtime: FrozenMigrationRuntime
  destinationAsset: Address
}

/** Frozen funds are released only by broadcasts on the destination; no old-L2 transaction. */
export class FrozenMetadataMigrationSource implements MetadataMigrationSource {
  readonly identity: string
  private prepared = new Map<string, Awaited<ReturnType<FrozenMigrationRuntime["build"]>>>()

  constructor(private readonly o: Options) {
    this.identity = keccak256(
      toHex(
        JSON.stringify({
          source: o.runtime.identity,
          destination: [
            o.destination.portal,
            o.destination.factory,
            String(o.destination.rollupVersion),
            o.destinationAsset,
            o.registered.user.toString(),
          ],
        }),
      ),
    )
  }

  private get deposits(): MigrationDestinationContext {
    const o = this.o
    return { ...o, node: o.wallet.node, recipient: o.registered.user, recoveryAccount: o.owner }
  }

  async state(): Promise<"frozen" | "empty"> {
    await this.o.runtime.validate(this.o.destinationAsset)
    return (await this.o.runtime.candidates()).candidates.length ? "frozen" : "empty"
  }

  /** Whether one batch nets more than `minimumNetAmount` after the relayer tip. */
  async movable(minimumNetAmount: bigint, fresh = false): Promise<boolean> {
    await this.o.runtime.validate(this.o.destinationAsset)
    const candidates = await this.o.runtime.candidates({ fresh })
    return !!selectFrozenBatch({ ...candidates, minimumNetAmount, tip: WITHDRAW_RELAYER_TIP })
  }

  /** Every batch a run takes, chosen as `prepare` and recovery choose them. */
  async quote(minimums: { first: bigint; later: bigint }): Promise<MigrationSourceQuote> {
    await this.o.runtime.validate(this.o.destinationAsset)
    const { candidates, waiting = 0n, ...limits } = await this.o.runtime.candidates()
    let left = candidates
    let movable = 0n
    let batches = 0
    for (let minimumNetAmount = minimums.first; ; minimumNetAmount = minimums.later) {
      const batch = selectFrozenBatch({
        ...limits,
        candidates: left,
        minimumNetAmount,
        tip: WITHDRAW_RELAYER_TIP,
      })
      if (!batch) break
      movable += batch.amount
      batches++
      left = left.filter((c) => !batch.ids.includes(c.id))
    }
    const stranded = left.reduce((sum, c) => sum + BigInt(c.amount), 0n)
    return { movable, stranded, waiting, batches }
  }

  /** Keys a proof by what it commits to, so a batch stored under another id reuses it. */
  private proofKey(recipient: Address, kind: FrozenRefundKind, selection: string[], tip: string) {
    return keccak256(
      toHex(JSON.stringify([this.identity, recipient.toLowerCase(), kind, selection, tip])),
    )
  }

  private async read(id: string, recipient?: Address) {
    const batch = await this.o.batches.get(id)
    if (
      !batch ||
      batch.binding !== this.identity ||
      !batch.sourceSelection?.length ||
      (recipient && batch.recipient.toLowerCase() !== recipient.toLowerCase()) ||
      BigInt(batch.exitFee) < 0n ||
      BigInt(batch.amount) <= BigInt(batch.exitFee)
    ) {
      throw new StalePlanError("Stored frozen batch does not match this migration")
    }
    return batch
  }

  async prepare(
    recipient: Address,
    minimumNetAmount: bigint,
    onSelected?: (id: string) => Promise<void>,
  ) {
    const o = this.o
    await o.runtime.validate(o.destinationAsset)
    // A frozen portal takes no funding cut; the refund pays only the relayer tip.
    const tip = WITHDRAW_RELAYER_TIP
    const selected = selectFrozenBatch({
      ...(await o.runtime.candidates()),
      minimumNetAmount,
      tip,
    })
    if (!selected)
      throw new Error(
        "No single frozen batch covers source execution and a positive destination deposit",
      )
    const { kind, ids, amount } = selected
    const id = this.proofKey(recipient, kind, ids, String(tip))
    // Saved before its approval, so a resumed preparation rebuilds this exact challenge.
    if (!(await o.batches.get(id)))
      await o.batches.set(id, {
        binding: this.identity,
        recipient,
        amount: String(amount),
        exitFee: String(tip),
        sourceSelection: ids,
        sourceKind: kind,
        fromBlock: String(await o.client.getBlockNumber()),
        createdAt: Date.now(),
      })
    await onSelected?.(id)
    const built = await o.runtime.build({ kind, ids }, recipient, tip)
    if (built.amount !== amount) throw new Error("Source proof amount differs from the selection")
    await this.validateOperation(built.operation, recipient)
    this.prepared.set(id, built)
    return { id, netAmount: amount - tip, operation: built.operation }
  }

  async restore(id: string, recipient: Address) {
    const batch = await this.read(id, recipient)
    const kind = batch.sourceKind ?? "note"
    const ids = batch.sourceSelection!
    await this.o.runtime.validate(this.o.destinationAsset)
    if (await this.o.runtime.refunded(ids))
      throw new StalePlanError("The selected frozen batch has already been refunded")
    // A cached proof must not bypass fresh spentness checks when only part of a selection was
    // refunded elsewhere. The aggregate refunded() check above proves only that ALL were spent.
    const { candidates, maxNotesPerBatch, maxBatchAmount } = await this.o.runtime.candidates()
    const available = new Map(
      candidates.filter((c) => c.kind === kind).map((c) => [c.id, BigInt(c.amount)]),
    )
    if (
      ids.length > (kind === "note" ? maxNotesPerBatch : 1) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !available.has(id))
    ) {
      throw new StalePlanError("A selected source candidate is no longer refundable")
    }
    const amount = ids.reduce((sum, id) => sum + available.get(id)!, 0n)
    if (amount !== BigInt(batch.amount) || amount > maxBatchAmount)
      throw new StalePlanError("Restored source selection amount changed")
    if (WITHDRAW_RELAYER_TIP > BigInt(batch.exitFee))
      throw new StalePlanError("The frozen refund relayer tip increased")
    const key = this.proofKey(recipient, kind, ids, batch.exitFee)
    const built =
      this.prepared.get(key) ??
      (await this.o.runtime.build({ kind, ids }, recipient, BigInt(batch.exitFee)))
    if (built.amount !== BigInt(batch.amount))
      throw new Error("Restored source proof amount changed")
    await this.validateOperation(built.operation, recipient)
    this.prepared.set(key, built)
    return { netAmount: built.amount - BigInt(batch.exitFee), operation: built.operation }
  }

  private async validateOperation(
    operation: Awaited<ReturnType<FrozenMigrationRuntime["build"]>>["operation"],
    recipient: Address,
  ) {
    // Verify against the deployed source portal and verifier before consuming destination
    // sponsorship. eth_call discards all effects.
    await this.o.client.call({
      account: recipient,
      to: operation.target.toString() as Address,
      data: `0x${operation.calldata.toString("hex")}`,
    })
  }

  async fund(): Promise<void> {
    /* The destination broadcast carries the signed refund. */
  }

  /** Every saved `remaining-N` still in play, in order; an abandoned one is skipped. */
  private async remaining(): Promise<{ id: string; batch: MigrationFundingBatch }[]> {
    const out: { id: string; batch: MigrationFundingBatch }[] = []
    for (let index = 0; ; index++) {
      const id = `remaining-${index}`
      const batch = await this.o.batches.get(id)
      if (!batch) return out
      if (!batch.abandoned) out.push({ id, batch: await this.read(id) })
    }
  }

  private async nextIndex() {
    for (let index = 0; ; index++)
      if (!(await this.o.batches.get(`remaining-${index}`))) return index
  }

  private async ordinaryFee() {
    return readOrdinaryDepositFee(this.o.client, this.o.destination)
  }

  /**
   * Plan every later batch and prove it. Each batch's selection, coordinates and recipient are saved
   * before its approval; unapproved batches go first, so a refused prompt never waits behind rebuilds
   * of approved ones. Re-running it resumes: saved batches keep their ids, coordinates and recipients,
   * and only funds no saved batch covers are planned anew.
   */
  async prepareRemaining(
    minimumNetAmount: bigint,
    opts: {
      /** The first batch's id: its selection is not a later batch's. */
      exclude?: string
      /** Coordinates another SIPA of this migration already uses. */
      reserved?: { day: number; nonce: number }[]
      signal?: AbortSignal
      onApproval?: (approved: number, total: number) => Promise<void>
    } = {},
  ): Promise<void> {
    const o = this.o
    await o.runtime.validate(o.destinationAsset)
    const first = new Set(opts.exclude ? (await this.read(opts.exclude)).sourceSelection! : [])
    const { candidates, waiting: _, ...limits } = await o.runtime.candidates()
    const available = new Map(candidates.map((c) => [c.id, BigInt(c.amount)]))
    // An unsent batch whose selection lost an id, or overlaps the first batch, is planned again.
    const saved: { id: string; batch: MigrationFundingBatch }[] = []
    for (const entry of await this.remaining()) {
      const ids = entry.batch.sourceSelection!
      const holds =
        ids.every((id) => available.has(id) && !first.has(id)) &&
        ids.reduce((sum, id) => sum + available.get(id)!, 0n) === BigInt(entry.batch.amount)
      if (entry.batch.broadcastTx || holds) saved.push(entry)
      else await o.batches.set(entry.id, { ...entry.batch, abandoned: true })
    }
    const covered = new Set([...first, ...saved.flatMap(({ batch }) => batch.sourceSelection!)])
    let left = candidates.filter((c) => !covered.has(c.id))
    const taken = [...saved.map(({ batch }) => batch), ...(opts.reserved ?? [])]
    const open = saved.filter(({ batch }) => !batch.broadcastTx)
    let index = await this.nextIndex()
    for (;;) {
      const selected = selectFrozenBatch({
        ...limits,
        candidates: left,
        minimumNetAmount,
        tip: WITHDRAW_RELAYER_TIP,
      })
      if (!selected) break
      left = left.filter((c) => !selected.ids.includes(c.id))
      let coordinates = migrationSipaCoordinates()
      while (taken.some((t) => t.day === coordinates.day && t.nonce === coordinates.nonce))
        coordinates = migrationSipaCoordinates()
      taken.push(coordinates)
      const resolved = await this.resolve(coordinates)
      const batch: MigrationFundingBatch = {
        binding: this.identity,
        recipient: resolved.sipaAddress,
        amount: String(selected.amount),
        exitFee: String(WITHDRAW_RELAYER_TIP),
        sourceSelection: selected.ids,
        sourceKind: selected.kind,
        fromBlock: String(await o.client.getBlockNumber()),
        createdAt: Date.now(),
        ...coordinates,
      }
      const id = `remaining-${index++}`
      await o.batches.set(id, batch)
      open.push({ id, batch })
    }
    const order = [
      ...open.filter(({ batch }) => !batch.approved),
      ...open.filter(({ batch }) => batch.approved),
    ]
    let approved = open.filter(({ batch }) => batch.approved).length
    let total = open.length
    await opts.onApproval?.(approved, total)
    for (const { id, batch } of order) {
      opts.signal?.throwIfAborted()
      try {
        await this.restore(id, batch.recipient as Address)
      } catch (error) {
        if (!(error instanceof StalePlanError)) throw error
        // Its funds moved while it was proven: the next plan covers what is left of them.
        await o.batches.set(id, { ...batch, abandoned: true })
        if (batch.approved) approved--
        total--
        await opts.onApproval?.(approved, total)
        continue
      }
      if (!batch.approved) {
        await o.batches.set(id, { ...batch, approved: true })
        approved++
      }
      await opts.onApproval?.(approved, total)
    }
  }

  /**
   * Send every planned, unsent batch, one after another: each sponsored send waits for inclusion,
   * since the next spends the subscription note it re-inserts. A send never waits for a refund on
   * L1. Proofs come from memory or a rebuild from saved approvals; this never plans a batch.
   */
  async recoverRemaining(signal?: AbortSignal): Promise<void> {
    const o = this.o
    // L1 refund evidence first: a refunded batch's carrier landed, whatever its receipt says now.
    await this.reconcileRemaining()
    for (const { id, batch } of await this.remaining()) {
      if (batch.broadcastTx) {
        // A carrier not yet included may still spend the note the next send needs: wait for it.
        if (batch.refunded || batch.received) continue
        const receipt = await o.wallet.node.getTxReceipt(TxHash.fromString(batch.broadcastTx))
        if (receipt.executionResult === undefined) return
        continue
      }
      signal?.throwIfAborted()
      const resolved = await this.resolve(batch)
      if (resolved.sipaAddress.toLowerCase() !== batch.recipient.toLowerCase())
        throw new MigrationHaltedError("recipient", "Remaining-funds SIPA changed")
      const { operation } = await this.restore(id, resolved.sipaAddress)
      const innerCalls = [
        ...(await broadcastL1Operation(o.broadcaster, operation).request()).calls,
        ...(await migrationDepositCalls(this.deposits, resolved)),
      ]
      const payload = await buildClaimSponsorPayload({ ...o.registered, innerCalls })
      await o.wallet.sendTx(payload, {
        from: NO_FROM,
        sendMessagesAs: o.registered.user,
        additionalScopes: [o.registered.user],
        fee: claimFpcSponsoredFee(o.registered.policy, innerCalls),
        onTxHash: async (hash) => {
          signal?.throwIfAborted()
          await o.batches.set(id, { ...batch, broadcastTx: hash, sentAt: Date.now() })
        },
      })
    }
    await this.reconcileRemaining()
  }

  /**
   * Bring every sent batch up to date from chain evidence. It never signs and never sends. A spent
   * refund nullifier on L1 is the refund, whatever its carrier's receipt says. Funds that reach the
   * source once every batch arrived wait for the user's approval.
   */
  async reconcileRemaining(): Promise<void> {
    const o = this.o
    for (const { id, batch } of await this.remaining()) {
      if (!batch.broadcastTx || batch.received) continue
      if (!batch.refunded) {
        if (!(await o.runtime.refunded(batch.sourceSelection!))) {
          const receipt = await o.wallet.node.getTxReceipt(TxHash.fromString(batch.broadcastTx))
          if (receipt.executionResult === TxExecutionResult.REVERTED)
            throw new MigrationHaltedError(
              "reverted",
              "Remaining-funds broadcast reverted; its saved refund requires attention",
            )
          continue
        }
        await o.batches.set(id, { ...batch, refunded: true })
      }
      const resolved = await this.resolve(batch)
      if (
        await receiveMigrationSweeps(
          this.deposits,
          resolved.sipaAddress,
          BigInt(batch.fromBlock),
          resolved.resolution.messageSecret,
        )
      )
        await o.batches.set(id, { ...batch, refunded: true, received: true })
    }
    if (
      (await this.remaining()).every(({ batch }) => batch.received) &&
      (await this.movable((await this.ordinaryFee()) + 1n, true))
    )
      throw new ApprovalNeededError("More funds reached the old version; approve moving them")
  }

  /** Whether every planned batch has been sent. */
  async remainingSent(): Promise<boolean> {
    return (await this.remaining()).every(({ batch }) => !!batch.broadcastTx)
  }

  private resolve(batch: Pick<MigrationFundingBatch, "day" | "nonce">) {
    if (batch.day === undefined || batch.nonce === undefined)
      throw new Error("Missing remaining-funds coordinates")
    return resolveMigrationDeposit(this.deposits, batch.day, batch.nonce)
  }

  /** Complete once every planned batch arrived and a fresh scan finds no affordable remainder. */
  async remainingComplete(): Promise<boolean> {
    if (!(await this.remaining()).every(({ batch }) => batch.received)) return false
    return !(await this.movable((await this.ordinaryFee()) + 1n, true))
  }
}
