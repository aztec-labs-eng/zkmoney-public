import type { SavingsDirection } from "./types"

/**
 * The one state a Savings move shows from its burn until the credit, in place of the withdrawal
 * copy about Ethereum its burn would otherwise carry.
 */
export const savingsMoveLabel = (
  direction: SavingsDirection,
): "Moving to Savings" | "Moving to Main Account" =>
  direction === "in" ? "Moving to Savings" : "Moving to Main Account"

/** A long 0x hex as `0x1234…abcd`, so an error line fits a sheet. */
export const shortHex = (text: string): string =>
  text.replace(/0x([0-9a-fA-F]{4})[0-9a-fA-F]{8,}([0-9a-fA-F]{4})/g, "0x$1…$2")
