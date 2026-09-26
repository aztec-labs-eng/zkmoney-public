import { isPaylinkWindowRevert, type OperationFailureCause } from "@obsidion/front-core"
import { PAYLINK_NOT_CLAIMABLE_YET_MESSAGE } from "../paylink/claimWindow"
import type { OperationFlow } from "./operations"

interface FlowCopy {
  /**
   * Row title while it runs, before the summary ("Sending", "$25 to @alice"); also the working
   * beat's label while it runs as a child operation.
   */
  live: string
  /** Settled row title; none where no settled row is due. */
  settled?: string
  failed: string
  /** A transaction button's label while this runs: local proving is single-flight. */
  busy: string
  icon: string
  /** Who reports the ending: the panel off the operation, or the flow's own record's rows. */
  outcome: "operation" | "record"
  /** Row text for a failure the store recorded itself; `null` writes no row. */
  causes: Readonly<Record<OperationFailureCause, string | null>>
  /** Row text for a failure the flow threw, where its message is not for the user. */
  describeError?: (error: string) => string | undefined
}

/** `balanceKept`: the amount came out of the balance, so the user needs to hear it is still there. */
function causes(balanceKept: boolean): FlowCopy["causes"] {
  const kept = balanceKept ? " The amount is still in your balance." : ""
  return {
    interrupted: `The tab closed before it was sent.${kept}`,
    dropped: `The network turned it down.${kept}`,
  }
}

export const OPERATION_COPY: Readonly<Record<OperationFlow, FlowCopy>> = {
  "send": {
    live: "Sending",
    settled: "Sent",
    failed: "Send failed",
    busy: "Waiting for your send to finish",
    icon: "arrow.up.right",
    outcome: "operation",
    causes: causes(true),
  },
  "withdraw": {
    live: "Withdrawing",
    failed: "Withdrawal failed",
    busy: "Waiting for your withdrawal to finish",
    icon: "arrow.up.right",
    outcome: "record",
    causes: causes(true),
  },
  "paylink-create": {
    live: "Creating",
    settled: "Paylink created",
    failed: "Paylink failed",
    busy: "Waiting for your paylink to be created",
    icon: "link",
    outcome: "operation",
    causes: causes(true),
  },
  "paylink-claim": {
    live: "Receiving",
    settled: "Received",
    failed: "Claim failed",
    busy: "Waiting for your paylink claim to finish",
    icon: "arrow.down.left",
    outcome: "operation",
    causes: causes(false),
    describeError: (error) =>
      isPaylinkWindowRevert(error) ? PAYLINK_NOT_CLAIMABLE_YET_MESSAGE : undefined,
  },
  "paylink-claim-l1": {
    live: "Withdrawing",
    failed: "Withdrawal failed",
    busy: "Waiting for your withdrawal to finish",
    icon: "arrow.up.right",
    outcome: "record",
    causes: causes(false),
  },
  "paylink-reclaim": {
    live: "Recovering",
    settled: "Paylink recovered",
    failed: "Recovery failed",
    busy: "Waiting for your paylink recovery to finish",
    icon: "arrow.uturn.backward",
    outcome: "operation",
    causes: causes(false),
  },
  "deposit": {
    live: "Preparing",
    failed: "Deposit address failed",
    busy: "Waiting for your deposit address",
    icon: "arrow.down.left",
    outcome: "operation",
    causes: causes(false),
  },
  "request-link": {
    live: "Preparing",
    failed: "Request link failed",
    busy: "Waiting for your request link",
    icon: "link",
    outcome: "operation",
    causes: causes(false),
  },
  "migration": {
    live: "Moving",
    failed: "Migration failed",
    busy: "Waiting for your funds to move",
    icon: "arrow.up.right",
    outcome: "record",
    causes: causes(false),
  },
  "migration-arrival": {
    live: "Publishing your new address",
    failed: "Couldn't publish your new address",
    busy: "Waiting for your new address",
    icon: "arrow.down.left",
    outcome: "operation",
    // It runs before the burn: one the store ended burned nothing, and the move is offered again.
    causes: { interrupted: null, dropped: null },
  },
}

export function flowCopy(flow: string): FlowCopy {
  return OPERATION_COPY[flow as OperationFlow] ?? OPERATION_COPY.send
}
