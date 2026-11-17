import type { Address } from "viem"
import type { BridgeFill, BridgeFillDetector, ReceiptLog } from "./types"

/** The fill in `logs` that paid `recipient`, by the first of `detectors` that finds one. */
export function bridgeFillIn(
  detectors: readonly BridgeFillDetector[],
  logs: readonly ReceiptLog[],
  recipient: Address,
): BridgeFill | undefined {
  for (const detect of detectors) {
    const fill = detect(logs, recipient)
    if (fill) return fill
  }
  return undefined
}
