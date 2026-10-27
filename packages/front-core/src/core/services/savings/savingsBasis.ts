/**
 * What the shares Savings holds now have earned: their value now less what they cost, at average
 * cost. Moves are replayed in the order their shares moved: a move in when its deposit landed, a move
 * out when its burn was mined. A claimed move in adds its shares and the USDS it put in, and a mined
 * move out takes its shares and their part of the cost with it. A position moved out in full
 * has nothing left to earn on. The vault's own figures from the escrow run come first and the quote's
 * stand in until they are read; a counted move in with neither is named and leaves the figure
 * unknown, since a missing cost must never count as zero.
 */
import {
  isSavingsMovePending,
  needsVaultFigures,
  vaultKnownUnknown,
} from "../../../oxide/savingsMoves"
import type { WithdrawalRecord } from "../bridge/types"
import type { SavingsMoveRecord } from "./types"

/** The burn's phases before its shares have left the position. */
const UNMINED: ReadonlySet<WithdrawalRecord["phase"]> = new Set(["submitting", "failed"])

/**
 * The USDS a move in put into the vault: the vault's own figure from the escrow run once read, else
 * what the move burned less the release tip and the escrow tip. DAI is USDS one for one and both
 * tips are fixed when the escrow is built, so that is the quote's `net`; a move rebuilt from its
 * burn sums the burn's own fields.
 */
export function savingsMoveBasis(
  move: Pick<SavingsMoveRecord, "net" | "vault">,
  burn: Pick<WithdrawalRecord, "rawAmount" | "relayerTip" | "skyMove"> | undefined,
): bigint | undefined {
  if (move.vault) return BigInt(move.vault.assets)
  if (move.net !== undefined) return BigInt(move.net)
  if (!burn?.rawAmount || burn.relayerTip === undefined || !burn.skyMove) return undefined
  const basis = BigInt(burn.rawAmount) - BigInt(burn.relayerTip) - BigInt(burn.skyMove.relayerTip)
  return basis > 0n ? basis : undefined
}

export interface SavingsLedger {
  /** What the shares the replay leaves cost: the USDS put in, less each move out's part of it. */
  basis: bigint
  /** Moves that count: claimed in, or out with its burn mined. */
  counted: number
  /** Shares the replay leaves, to compare with the shares held. */
  shares: bigint
  /** Counted moves left out because their figures cannot be derived; `backfilling` while a pass may still read them. */
  excluded: { withdrawalLocalId: string; reason: string; backfilling: boolean }[]
}

/** A pass may still read the figure: its transaction's receipt is owed, or the deposit not yet found. */
const stillReading = (move: SavingsMoveRecord) =>
  !vaultKnownUnknown(move) && (needsVaultFigures(move) || isSavingsMovePending(move))

export function savingsLedger(
  moves: SavingsMoveRecord[],
  burns: ReadonlyMap<string, WithdrawalRecord>,
): SavingsLedger {
  const ledger: SavingsLedger = { basis: 0n, counted: 0, shares: 0n, excluded: [] }
  const movedAt = (move: SavingsMoveRecord) =>
    move.direction === "in"
      ? move.deposit?.at ?? move.endTime ?? move.startTime
      : burns.get(move.withdrawalLocalId)?.minedAt ??
        burns.get(move.withdrawalLocalId)?.startTime ??
        move.startTime
  for (const move of [...moves].sort((a, b) => movedAt(a) - movedAt(b))) {
    const burn = burns.get(move.withdrawalLocalId)
    if (move.direction === "in") {
      if (!move.deposit?.claimed) continue
      ledger.counted += 1
      ledger.shares += BigInt(move.deposit.amount)
      const basis = savingsMoveBasis(move, burn)
      if (basis === undefined) {
        ledger.excluded.push({
          withdrawalLocalId: move.withdrawalLocalId,
          reason: vaultKnownUnknown(move) ? move.vaultUnknown! : "no net or burn figures",
          backfilling: stillReading(move),
        })
        continue
      }
      ledger.basis += basis
    } else {
      // Sent but not yet seen mined: its shares may already have left, so the figure waits for it.
      if (burn?.phase === "submitting" && burn.l2TxHash) {
        ledger.counted += 1
        ledger.excluded.push({
          withdrawalLocalId: move.withdrawalLocalId,
          reason: "burn sent, not yet mined",
          backfilling: true,
        })
        continue
      }
      if (burn && UNMINED.has(burn.phase)) continue
      ledger.counted += 1
      const before = ledger.shares
      const out = BigInt(move.amount) < before ? BigInt(move.amount) : before
      ledger.basis -= before > 0n ? (ledger.basis * out) / before : ledger.basis
      ledger.shares = before - out
    }
  }
  return ledger
}

/** How far the replay may differ from the shares held and still describe them: rounding, a millionth of a share. */
export const SAVINGS_SHARE_DUST = 10n ** 12n

/**
 * What the shares held now have earned: `valueNow` less what they cost, nothing once none are held.
 * Unknown while a counted move lacks its figure, or while the moves do not account for the shares
 * held (a restored device before its moves are rebuilt), since the balance would read as earnings.
 */
export function savingsEarned(
  ledger: SavingsLedger,
  valueNow: bigint,
  sharesHeld: bigint,
): bigint | undefined {
  if (ledger.excluded.length > 0) return undefined
  if (sharesHeld === 0n) return 0n
  const off = ledger.shares > sharesHeld ? ledger.shares - sharesHeld : sharesHeld - ledger.shares
  if (off > SAVINGS_SHARE_DUST) return undefined
  return valueNow - (ledger.basis > 0n ? ledger.basis : 0n)
}

/** Unknown only until the passes read the missing figures: every move left out is still being backfilled. */
export const savingsEarningsPending = (ledger: SavingsLedger): boolean =>
  ledger.excluded.length > 0 && ledger.excluded.every((entry) => entry.backfilling)
