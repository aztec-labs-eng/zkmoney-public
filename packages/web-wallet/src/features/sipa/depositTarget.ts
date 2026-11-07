import type { Address } from "viem"

export interface DepositAddress {
  /** The L1 SIPA address a sender funds. */
  address: Address
  /** The wallet's name, e.g. "alice.sandbox.oxide" — display only; nothing derives from it. */
  name: string
  /**
   * Settles once the address's broadcast, owed when it was handed out, landed. Absent when the
   * address is known published. Funds sent before it settles are not lost — they sit at the
   * counterfactual address until the relayer is told about it — but they are not swept either.
   * Throws `RegistrationPendingError` while no rail can pay for the broadcast, and the attempt's
   * error once one fails; the broadcast stays owed either way.
   */
  publish?: () => Promise<void>
  /** How it was handed out: a landed pool entry, a pool fill still proving, or a derivation. */
  source?: "pool" | "filling" | "derived"
}

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
