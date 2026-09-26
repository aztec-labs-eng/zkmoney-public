import { act } from "react"
import { provingProgress } from "@obsidion/proving-progress"
import { runOperation, type OperationFlow } from "../../src/features/operations/operations"

let nextId = 0

/**
 * A mocked flow, run as the real one is: inside one operation, which `OperationHandOff` follows.
 * It settles when `fn` resolves.
 */
export function asOperation<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  flow: OperationFlow = "send",
): (...args: A) => Promise<R> {
  return (...args) =>
    runOperation({ operationId: `op-test-${++nextId}`, flow, summary: "$25 to @alice" }, () =>
      fn(...args),
    )
}

/** End the passkey ceremony: the flow's modal hands off to the bell. */
export async function endSigningAndHandOff(): Promise<void> {
  await act(async () => provingProgress.emitSigningEnd())
}
