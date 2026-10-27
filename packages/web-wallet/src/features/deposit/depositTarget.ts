import type { DepositAddress } from "./sipaGateway"

/**
 * An address on screen. `publishing`: its broadcast has not landed. It shows, copies and funds all
 * the same: funds wait at the address until it lands.
 */
export type ShownAddress = DepositAddress & { publishing?: boolean }

/**
 * An address the deposit screen funds instead of a fresh deposit address: a registration's. It says
 * only what its sweep needs; the screen keeps the transfer, the funding checks, the unresolved-send
 * hold and capacity. Amounts are in the settlement token's base units.
 */
export interface DepositTarget {
  kind: "registration"
  address: ShownAddress
  /** What the sweep takes. Fixed by the target, so the funding sheet never reads it again. */
  fee?: bigint
  /** The least the address must hold for its sweep; less waits there. */
  floor?: bigint
  /** The least to send. */
  ask?: bigint
  /** What the address already holds. */
  held?: bigint
  /** The screen saw funds at the address. */
  onFunded(amount: bigint, decimals: number): void
  /** The sheet showed the address. */
  onShown(address: string): void
}
