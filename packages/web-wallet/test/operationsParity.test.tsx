/**
 * The screen suites that mock front-core run on `support/fakeOperations`. Each scenario here runs
 * through the real module and the fake, and both must leave the same record.
 */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { TxInFlightError } from "@obsidion/front-core"
import { provingProgress } from "@obsidion/proving-progress"
import * as real from "../src/features/operations/operations"
import { fakeOperationsModule } from "./support/fakeOperations"

const fake = fakeOperationsModule()
const hash = `0x${"0a".repeat(32)}`

type Handle = { operationId: string; leaveToChain(txHash: string | undefined): void }
type Scenario = (op: Handle) => Promise<unknown>

const proving = (op: Handle) => provingProgress.emitStageStart("proving", op.operationId)

const scenarios: Record<string, Scenario> = {
  "settles with its hash": async () => ({ txHash: hash }),
  "a cancel before proving goes": async () => {
    throw new Error("Cancelled")
  },
  "a failure before proving goes": async () => {
    throw new Error("read failed")
  },
  "a failure while proving fails with its message": async (op) => {
    proving(op)
    throw new Error("proof failed")
  },
  "a cancel while proving still goes": async (op) => {
    proving(op)
    throw new Error("Cancelled")
  },
  "in flight at the node is sent": async (op) => {
    proving(op)
    throw new TxInFlightError(hash, new Error("timeout"))
  },
  "the hash saved then in flight stays sent": async (op) => {
    proving(op)
    provingProgress.emitTxHashSaved(op.operationId, hash)
    throw new TxInFlightError(undefined as never, new Error("timeout"))
  },
  "a definite failure after the hash was saved fails it": async (op) => {
    proving(op)
    provingProgress.emitTxHashSaved(op.operationId, hash)
    throw new Error("dropped by the node")
  },
  "a passkey closed while proving still goes": async (op) => {
    proving(op)
    throw new DOMException("closed", "NotAllowedError")
  },
  "left to the chain is sent": async (op) => {
    proving(op)
    op.leaveToChain(hash)
    return {}
  },
}

let seq = 0
async function outcome(mod: typeof fake | typeof real, name: string, scenario: Scenario) {
  const operationId = `parity-${++seq}`
  let busy = ""
  const input = { operationId, flow: "send" as const, summary: "$1 to @a" }
  const run = mod.runOperation as typeof real.runOperation
  await run(
    input,
    async (op) => {
      busy = await busyLabel(mod)
      return scenario(op as unknown as Handle)
    },
    (r) => (r as { txHash?: string }).txHash,
  ).catch(() => {})
  const record = mod.getOperationStore().get(operationId)
  return {
    name,
    busy,
    live: mod.getOperationStore().isLive(operationId),
    record: record && {
      state: record.state,
      txHash: record.txHash,
      error: record.error,
      cause: (record as { cause?: string }).cause,
      summary: record.summary,
    },
  }
}

/** What a transaction button says while the operation runs. */
async function busyLabel(mod: typeof fake | typeof real): Promise<string> {
  const host = document.createElement("div")
  const root = createRoot(host)
  function Probe() {
    return <>{mod.useBusyLabel()}</>
  }
  await act(async () => root.render(<Probe />))
  const text = host.textContent ?? ""
  await act(async () => root.unmount())
  return text
}

describe("fakeOperations matches the real operations module", () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(name, async () => {
      real.getOperationsInProgress()
      const expected = await outcome(real, name, scenario)
      const actual = await outcome(fake, name, scenario)
      expect(expected.busy).toBe("Waiting for your send to finish")
      expect(actual).toEqual(expected)
    })
  }
})

describe("the fake's cancel check", () => {
  const errors: unknown[] = [
    new Error("Cancelled"),
    new DOMException("closed", "NotAllowedError"),
    new DOMException("gone", "AbortError"),
    new Error("proof failed"),
    "Cancelled",
    undefined,
  ]
  it.each(errors.map((e) => [String(e), e]))("answers as the real one for %s", (_, err) => {
    expect(fake.isFlowCancelled(err)).toBe(real.isFlowCancelled(err))
  })
})
