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
import { readOrdinaryDepositFee } from "./metadataMigration.js"
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
    for (let minimumNetAmount = minimums.first; ; minimumNetAmount = minimums.later) {
      const batch = selectFrozenBatch({
        ...limits,
        candidates: left,
        minimumNetAmount,
        tip: WITHDRAW_RELAYER_TIP,
      })
      if (!batch) break
      movable += batch.amount
      left = left.filter((c) => !batch.ids.includes(c.id))
    }
    const stranded = left.reduce((sum, c) => sum + BigInt(c.amount), 0n)
    return { movable, stranded, waiting }
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
      throw new Error("Stored frozen batch does not match this migration")
    }
    return batch
  }

  async prepare(recipient: Address, minimumNetAmount: bigint) {
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
    const built = await o.runtime.build({ kind, ids }, recipient, tip)
    if (built.amount !== amount) throw new Error("Source proof amount differs from the selection")
    await this.validateOperation(built.operation, recipient)
    this.prepared.set(id, built)
    if (!(await o.batches.get(id)))
      await o.batches.set(id, {
        binding: this.identity,
        recipient,
        amount: String(amount),
        exitFee: String(tip),
        sourceSelection: ids,
        sourceKind: kind,
        fromBlock: String(await o.client.getBlockNumber()),
      })
    return { id, netAmount: amount - tip, operation: built.operation }
  }

  async restore(id: string, recipient: Address) {
    const batch = await this.read(id, recipient)
    const kind = batch.sourceKind ?? "note"
    const ids = batch.sourceSelection!
    await this.o.runtime.validate(this.o.destinationAsset)
    if (await this.o.runtime.refunded(ids))
      throw new Error("The selected frozen batch has already been refunded")
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
      throw new Error("A selected source candidate is no longer refundable")
    }
    const amount = ids.reduce((sum, id) => sum + available.get(id)!, 0n)
    if (amount !== BigInt(batch.amount) || amount > maxBatchAmount)
      throw new Error("Restored source selection amount changed")
    if (WITHDRAW_RELAYER_TIP > BigInt(batch.exitFee))
      throw new Error("The frozen refund relayer tip increased")
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

  private async nextRemaining() {
    for (let index = 0; ; index++) {
      const id = `remaining-${index}`
      const batch = await this.o.batches.get(id)
      if (batch) await this.read(id)
      if (!batch?.received) return { id, batch }
    }
  }

  private async ordinaryFee() {
    return readOrdinaryDepositFee(this.o.client, this.o.destination)
  }

  async recoverRemaining(): Promise<void> {
    const o = this.o
    const next = await this.nextRemaining()
    let batch = next.batch
    if (!batch) {
      const fee = await this.ordinaryFee()
      // Anything no affordable batch can take stays on the source as a stranded residual.
      if (!(await this.movable(fee + 1n))) return
      const coordinates = migrationSipaCoordinates()
      const resolved = await this.resolve(coordinates)
      const selected = await this.prepare(resolved.sipaAddress, fee + 1n)
      batch = { ...(await this.read(selected.id)), ...coordinates }
      await o.batches.set(next.id, batch)
    }
    batch = await this.read(next.id)
    const resolved = await this.resolve(batch)
    if (resolved.sipaAddress.toLowerCase() !== batch.recipient.toLowerCase())
      throw new Error("Remaining-funds SIPA changed")
    if (!batch.broadcastTx) {
      const { operation } = await this.restore(next.id, resolved.sipaAddress)
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
          batch!.broadcastTx = hash
          await o.batches.set(next.id, batch!)
        },
      })
      return
    }
    const receipt = await o.wallet.node.getTxReceipt(TxHash.fromString(batch.broadcastTx))
    if (receipt.executionResult === TxExecutionResult.REVERTED)
      throw new Error("Remaining-funds broadcast reverted; its saved refund requires attention")
    // Actual source refund and destination receipt remain authoritative after tx-history pruning.
    if (!(await o.runtime.refunded(batch.sourceSelection!))) return
    if (
      await receiveMigrationSweeps(
        this.deposits,
        resolved.sipaAddress,
        BigInt(batch.fromBlock),
        resolved.resolution.messageSecret,
      )
    )
      await o.batches.set(next.id, { ...batch, received: true })
  }

  private resolve(batch: Pick<MigrationFundingBatch, "day" | "nonce">) {
    if (batch.day === undefined || batch.nonce === undefined)
      throw new Error("Missing remaining-funds coordinates")
    return resolveMigrationDeposit(this.deposits, batch.day, batch.nonce)
  }

  /** Complete once a fresh scan finds no affordable remainder: what is left is stranded. */
  async remainingComplete(): Promise<boolean> {
    if ((await this.nextRemaining()).batch) return false
    return !(await this.movable((await this.ordinaryFee()) + 1n, true))
  }
}
