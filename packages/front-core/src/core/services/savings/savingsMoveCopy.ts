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

const firstLine = (text: string): string =>
  text
    .split("\n")[0]
    .replace(/^Error:\s*/, "")
    .trim()

/**
 * A settle check's message in plain words for a sheet. "No L1 to L2 message found" is the deposit
 * found and still on its way to Aztec; a claim the token already holds reads as claimed; any other
 * refusal is a failure with its first line, hashes shortened.
 */
export function claimCheckCopy(message: string): string {
  const refused = /^claim refused:\s*/i.test(message)
  const text = firstLine(message.replace(/^claim refused:\s*/i, ""))
  if (/no l1 to l2 message found/i.test(text)) return "Deposit found, waiting for it to reach Aztec"
  if (/deposit already (stored|spent|claimed)/i.test(text) || /^claimed$/i.test(text))
    return "Claimed"
  if (refused) return `Claim failed: ${shortHex(text)}`
  return shortHex(text.charAt(0).toUpperCase() + text.slice(1))
}
