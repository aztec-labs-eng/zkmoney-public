/** How a bridge-in's status reads in its sheet and its Activity row. */
import type { BridgeInRecord } from "@obsidion/front-core"
import type { RingPhase } from "../../ui/flow/RingStage/RingStage"

type Status = Pick<BridgeInRecord, "status" | "pays">

/** A payment the bridge filled: the payee's wallet does the rest, so it is paid. */
export const bridgeInPaid = (record: Status): boolean => !!record.pays && record.status === "filled"

/**
 * The status sheet's phase. `landed`: this wallet claimed the deposit's sweeps. A payment lands at
 * the payee's address, so its filled block is its last.
 */
export function bridgeInPhase(record: Status, landed: boolean): RingPhase {
  switch (record.status) {
    case "signing":
    case "pending":
      return "bridging"
    case "filled":
      return landed && !record.pays ? "arrived" : "arriving"
    default:
      return "failed"
  }
}
