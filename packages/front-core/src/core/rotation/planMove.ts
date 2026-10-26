/**
 * Cuts the forward of a one-key account's balance into chunks one sponsored transfer can prove. The
 * token spends its largest notes first and deposits for the rest, and one proof reaches at most 18
 * of each, so a chunk is proven when the next 18 largest notes and, with a known deposit set, the 18
 * smallest deposits cover it. Which deposits a chunk spends is only known from the next read, so a
 * plan over deposits is an upper bound and each chunk is re-cut from the live shape.
 */
import type { SpendShape } from "@obsidion/sdk"

export const MOVE_NOTES_PER_CHUNK = 18
export const MOVE_DEPOSITS_PER_CHUNK = 18

/** The unspent deposits behind `depositTotal`: exact when their amounts sum to it. */
export type MoveDeposits = { kind: "exact"; amounts: bigint[] } | { kind: "unknown" }

export function moveDeposits(
  shape: Pick<SpendShape, "depositTotal">,
  amounts: readonly bigint[] | undefined,
): MoveDeposits {
  if (!amounts) return { kind: "unknown" }
  const sum = amounts.reduce((total, amount) => total + amount, 0n)
  return sum === shape.depositTotal ? { kind: "exact", amounts: [...amounts] } : { kind: "unknown" }
}

/** The deposit set before it is read: exact and empty while the shape holds nothing in deposits. */
export function unreadDeposits(shape: Pick<SpendShape, "depositTotal">): MoveDeposits {
  return shape.depositTotal === 0n ? { kind: "exact", amounts: [] } : { kind: "unknown" }
}

export interface MoveChunk {
  amount: bigint
  /** The planner can prove the transfer's envelope covers it; an unproven chunk is one attempt. */
  proven: boolean
}

export interface MovePlan {
  chunks: MoveChunk[]
  /** The chunk count: exact where no deposit is spent or one chunk takes everything, else "up to". */
  m: number
  bound: "exact" | "upper"
}

/** Whether a one-transfer funding of `amount` fits one chunk of the shape. */
export type ChunkFit =
  | { kind: "fits" }
  /** The largest proven chunk, for the self-send that consolidates the balance. */
  | { kind: "short"; chunk: bigint }

const min = (a: bigint, b: bigint) => (a < b ? a : b)
const sum = (amounts: readonly bigint[]) => amounts.reduce((total, amount) => total + amount, 0n)
const descending = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0)
const ascending = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)

/** The largest chunk the selection provably covers: the next notes plus, with an exact set, the smallest deposits. */
export function provableChunk(
  cap: bigint,
  notes: readonly bigint[],
  deposits: MoveDeposits,
): bigint {
  const fromNotes = sum([...notes].sort(descending).slice(0, MOVE_NOTES_PER_CHUNK))
  const fromDeposits =
    deposits.kind === "exact"
      ? sum([...deposits.amounts].sort(ascending).slice(0, MOVE_DEPOSITS_PER_CHUNK))
      : 0n
  return min(cap, fromNotes + fromDeposits)
}

/**
 * A proven chunk covers the funding, or, with an unread deposit set, the deposits' total covers what
 * the notes leave: the token spends them for the rest, one attempt. Short names the chunk the notes
 * alone prove, so the self-send that consolidates them needs no deposit.
 */
export function fundingFits(
  amount: bigint,
  cap: bigint,
  shape: Pick<SpendShape, "notes" | "depositTotal">,
  deposits: MoveDeposits,
): ChunkFit {
  const chunk = provableChunk(cap, shape.notes, deposits)
  if (amount <= chunk) return { kind: "fits" }
  if (deposits.kind === "unknown" && amount <= cap && amount <= chunk + shape.depositTotal)
    return { kind: "fits" }
  return { kind: "short", chunk }
}

/**
 * The chunks that move `shape.balance`, each cut over what the previous ones leave: notes largest
 * first, then deposits smallest first, the change of a chunk back as a note. With an unknown set the
 * notes are cut while they cover a chunk, then each remainder is one unproven attempt of the cap.
 */
export function planMove(shape: SpendShape, cap: bigint, deposits: MoveDeposits): MovePlan {
  if (cap <= 0n) throw new Error("planMove: the chunk cap must be positive")
  const notes = [...shape.notes].sort(descending)
  const pool = deposits.kind === "exact" ? [...deposits.amounts].sort(ascending) : undefined
  const chunks: MoveChunk[] = []
  let remaining = shape.balance
  let spentDeposits = false
  while (remaining > 0n) {
    const proven = provableChunk(cap, notes, pool ? { kind: "exact", amounts: pool } : deposits)
    if (proven > 0n) {
      const amount = min(proven, remaining)
      chunks.push({ amount, proven: true })
      if (spend(notes, pool, amount)) spentDeposits = true
    } else if (!pool) {
      // Nothing left to prove with: deposits of an unknown set carry the rest, one attempt at a time.
      chunks.push({ amount: min(cap, remaining), proven: false })
      notes.length = 0
      spentDeposits = true
    } else {
      break
    }
    remaining -= chunks[chunks.length - 1]!.amount
  }
  return {
    chunks,
    m: chunks.length,
    bound: spentDeposits && chunks.length > 1 ? "upper" : "exact",
  }
}

/** Takes `amount` out of the pools as the token would and returns a note for the change. Answers whether deposits were spent. */
function spend(notes: bigint[], deposits: bigint[] | undefined, amount: bigint): boolean {
  let need = amount
  let taken = 0
  while (taken < notes.length && taken < MOVE_NOTES_PER_CHUNK && need > 0n) {
    need -= notes[taken]!
    taken++
  }
  notes.splice(0, taken)
  let spentDeposits = false
  if (need > 0n && deposits) {
    let used = 0
    while (used < deposits.length && used < MOVE_DEPOSITS_PER_CHUNK && need > 0n) {
      need -= deposits[used]!
      used++
    }
    deposits.splice(0, used)
    spentDeposits = used > 0
  }
  if (need < 0n) insertNote(notes, -need)
  return spentDeposits
}

function insertNote(notes: bigint[], amount: bigint): void {
  const at = notes.findIndex((note) => note < amount)
  notes.splice(at < 0 ? notes.length : at, 0, amount)
}
