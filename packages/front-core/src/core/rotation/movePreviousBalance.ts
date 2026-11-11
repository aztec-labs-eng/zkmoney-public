/**
 * Forwards what reached the previous account to the session's account, one chunk in flight at a
 * time. The chunk is saved before its transfer leaves and is resolved by its hash before anything
 * else, so a reload or a second run never sends twice for one chunk.
 */
import { MAX_TX_LIFETIME_MS } from "@obsidion/core/constants"
import { isSpendEnvelopeRefusal, type SpendShape, type TxHashCallback } from "@obsidion/sdk"
import { WalletError } from "../../engine/errors"
import type { SavedPreviousAccount } from "../../engine/savedPreviousAccount"
import type { TxOutcome } from "./backupRotationFlow"
import { planMove, unreadDeposits } from "./planMove"
import { isDust } from "./previousAccount"

/** How long a run waits before reading the chunk in flight again. */
export const PREVIOUS_MOVE_POLL_MS = 15_000

export interface PreviousMoveDeps {
  saved: Pick<SavedPreviousAccount, "move" | "saveMove" | "clearMove">
  /** The previous account, which the move sends from. */
  address: string
  /** The session's account. */
  destination: string
  /** The source's shape on the moved token, read while no chunk is in flight. */
  shape(): Promise<SpendShape>
  cap: bigint
  /** The smallest balance worth a transfer. */
  dust: bigint
  /**
   * One sponsored transfer of `amount` to the destination. `onTxHash` is awaited before it leaves;
   * an abort seen before the signing call throws with nothing sent.
   */
  send(amount: bigint, onTxHash: TxHashCallback, signal: AbortSignal): Promise<void>
  /** `txOutcome` over the node and the wallet's clock. */
  outcome(txHash: string, expiresAtMs: number): Promise<TxOutcome>
  /** Whether the destination is still the session's verified account. */
  destinationOk(): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
}

/**
 * How a run ends. A `spend` refusal names the chunk the transfer's envelope refused; a
 * `destination` one is a failed destination check, with no new chunk sent.
 */
export type PreviousMoveResult =
  | { kind: "done" }
  | { kind: "refused"; reason: "spend" | "destination"; amount: bigint }
  | { kind: "stopped" }

const DONE: PreviousMoveResult = { kind: "done" }
const STOPPED: PreviousMoveResult = { kind: "stopped" }

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Checkpointed or final, whether the transfer took effect or not: either way the next chunk is cut
 * from the live shape.
 */
function settled(outcome: TxOutcome): boolean {
  switch (outcome.kind) {
    case "included":
      return outcome.checkpointed
    case "mined":
    case "reverted":
    case "dead":
      return true
    default:
      return false
  }
}

/**
 * Moves the previous account's balance to the destination: the saved chunk first, by its hash,
 * then one chunk at a time cut from the live shape.
 */
export async function movePreviousBalance(
  deps: PreviousMoveDeps,
  signal: AbortSignal,
): Promise<PreviousMoveResult> {
  for (;;) {
    const move = await deps.saved.move(deps.address)
    if (move) {
      if (!settled(await deps.outcome(move.txHash, move.expiresAtMs))) {
        if (signal.aborted) return STOPPED
        await deps.sleep(PREVIOUS_MOVE_POLL_MS)
        continue
      }
      await deps.saved.clearMove(deps.address, move.txHash)
      // An earlier session's chunk: this session's account was never checked as its destination.
      if (!sameAddress(move.destination, deps.destination))
        return { kind: "refused", reason: "destination", amount: move.amount }
      continue
    }
    if (signal.aborted) return STOPPED
    const shape = await deps.shape()
    if (isDust(shape.balance, deps.dust)) return DONE
    const chunk = planMove(shape, deps.cap, unreadDeposits(shape)).chunks[0]
    if (!chunk) return DONE
    if (!(await deps.destinationOk()))
      return { kind: "refused", reason: "destination", amount: chunk.amount }
    if (signal.aborted) return STOPPED
    const ended = await sendChunk(deps, chunk.amount, signal)
    if (ended) return ended
  }
}

/** One chunk out, saved first; answers how the run ends when the send fails before that. */
async function sendChunk(
  deps: PreviousMoveDeps,
  amount: bigint,
  signal: AbortSignal,
): Promise<PreviousMoveResult | undefined> {
  let saved = false
  const onTxHash: TxHashCallback = async (txHash, { expiresAtMs }) => {
    await deps.saved.saveMove(deps.address, {
      destination: deps.destination,
      txHash,
      expiresAtMs: Math.min(expiresAtMs, deps.now() + MAX_TX_LIFETIME_MS),
      amount,
    })
    saved = true
  }
  try {
    await deps.send(amount, onTxHash, signal)
  } catch (err) {
    // A saved chunk may have left; it is resolved by its hash, never sent again.
    if (saved) throw err
    if (isSpendEnvelopeRefusal(err)) return { kind: "refused", reason: "spend", amount }
    if (signal.aborted) return STOPPED
    throw err
  }
  if (!saved) throw new WalletError("invariant", "previous account move: the send saved no hash")
  return undefined
}
