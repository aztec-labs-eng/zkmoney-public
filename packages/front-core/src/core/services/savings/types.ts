import type { Address } from "viem"
import type { SavingsMove } from "../../../oxide/savingsMoves"
import type { SavingsMoveStorage } from "./SavingsMoveStorage"

export type SavingsDirection = "in" | "out"

/** Same words as `WithdrawStage`; a sheet's stage line reads them unchanged. */
export type SavingsMoveStage = "building" | "proving" | "submitting"

export interface SavingsPosition {
  /** zk-sUSDS held privately, 18 decimals. */
  shares: bigint
  /** DAI the shares redeem for at Sky's current price. */
  value: bigint
  /** DAI one `SHARE` redeems for; prices a deposit's shares before they are claimed. */
  sharePrice: bigint
  /** Yearly yield from Sky's savings rate; absent where the vault publishes none. */
  apy?: number
  readAt: number
  /** When the balance store last wrote the shares, ms; a claim counts as on its way until then. */
  sharesReadAt?: number
}

/** The vault's side of a position: what a share redeems for and the rate, read on L1. */
export type SavingsPrice = Pick<SavingsPosition, "sharePrice" | "apy" | "readAt">

/** What a move costs and leaves, priced on L1 before the burn. Base units throughout. */
export interface SavingsQuote {
  direction: SavingsDirection
  /** What the source burns: DAI moving in, sUSDS shares moving out. */
  amount: bigint
  /** The L1 token every other figure is in: DAI, which both releases pay out. */
  unit: Address
  /** The DAI value of `amount`. */
  value: bigint
  /** The DAI the source's withdrawal executor takes from the burn: Main's fee moving in, none moving out. */
  withdrawalFee: bigint
  /** Who receives `withdrawalFee`. */
  feeBeneficiary?: Address
  /** The DAI the release pays the relayer. */
  releaseTip: bigint
  /** The DAI the escrow pays whoever runs it. */
  escrowTip: bigint
  /** DAI the release leaves at the escrow. */
  escrowFunding: bigint
  /** DAI that lands, or the DAI value of the shares that do. */
  net: bigint
  /** Every deduction, in DAI: `value - net`. */
  fee: bigint
}

/** A move this front made. `withdrawalLocalId` is its burn's record and this store's key. */
export interface SavingsMoveRecord extends SavingsMove {
  startTime: number
  /** When the destination claimed the deposit. */
  endTime?: number
  /** The quote's DAI value and what it said would land; absent on a move adopted from a rescan. */
  value?: string
  net?: string
  /** What the last settle pass found, for a row to show while the move is pending. */
  lastCheck?: { at: number; message: string }
  /** Carried from a retired rollup's database, where the record ended. */
  retired?: true
}

/** What a front composes over its deployments; `useSavings` reads it. */
export interface SavingsSource {
  /** L1 asset whose shares the vault prices. */
  assetAddress?: string
  moves: SavingsMoveStorage
  /** Where the wallet's sync writes the shares held: Main's balance store, under the Savings token. */
  balance: { scope: string; tokenAddress: string }
  readPrice(): Promise<SavingsPrice>
  quote(direction: SavingsDirection, amount: bigint): Promise<SavingsQuote>
  /** Burns into a Sky escrow and records the move. The relayer runs the rest; `settle` claims it. */
  move(
    direction: SavingsDirection,
    amount: bigint,
    onStage: (stage: SavingsMoveStage) => void,
  ): Promise<SavingsMoveRecord>
  /** Claims the deposits of moves whose escrows have run. */
  settle(): Promise<void>
}
