/**
 * The page's prover keeps a background SIPA broadcast or upgrade step from colliding with a user's
 * send or with another background proof: background proofs run one at a time and must not start
 * while a user flow runs, a user flow waits out a proof already in flight, and each send waits for
 * the one before it to release the wallet's anchor pin.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { ProvingStage } from "@obsidion/core/types"
import { createProver, provingBusy, userFlowActive, type Prover } from "../../src/engine/prover"

const died = new Error("proof died")
let prover: Prover
beforeEach(() => void (prover = createProver({ now: () => Date.now() })))
const flowActive = () => userFlowActive(prover.state.get())
const flush = () => new Promise((r) => setTimeout(r, 0))

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("prover", () => {
  it("raises the flag synchronously and lowers it when the flow settles", async () => {
    expect(flowActive()).toBe(false)
    const gate = deferred()
    const flow = prover.runUserFlow(() => gate.promise)
    // Synchronous: a background prover checking in the same tick must already see the flag.
    expect(flowActive()).toBe(true)
    gate.resolve()
    await flow
    expect(flowActive()).toBe(false)
  })

  it("lowers the flag when the flow throws", async () => {
    await expect(prover.runUserFlow(() => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    )
    expect(flowActive()).toBe(false)
  })

  it("holds the flag until the last concurrent flow ends", async () => {
    const a = deferred()
    const b = deferred()
    const flowA = prover.runUserFlow(() => a.promise)
    const flowB = prover.runUserFlow(() => b.promise)
    a.resolve()
    await flowA
    expect(flowActive()).toBe(true)
    b.resolve()
    await flowB
    expect(flowActive()).toBe(false)
  })

  it("makes a user flow wait out an in-flight background proof", async () => {
    const proof = deferred()
    void prover.runBackground(() => proof.promise)
    let started = false
    const flow = prover.runUserFlow(async () => {
      started = true
    })
    await Promise.resolve()
    expect(started).toBe(false)
    proof.resolve()
    await flow
    expect(started).toBe(true)
  })

  it("runs background proofs one at a time, in the order they were reserved", async () => {
    const first = deferred()
    const second = deferred()
    const started: string[] = []
    const a = prover.runBackground(async () => {
      started.push("a")
      await first.promise
    })
    const b = prover.runBackground(async () => {
      started.push("b")
      await second.promise
    })
    const c = prover.runBackground(async () => void started.push("c"))
    await Promise.resolve()
    expect(started).toEqual(["a"])
    first.reject(died)
    await expect(a).rejects.toBe(died)
    await Promise.resolve()
    expect(started).toEqual(["a", "b"])
    second.resolve()
    await Promise.all([b, c])
    expect(started).toEqual(["a", "b", "c"])
  })

  it("starts a waiting background proof only once a user flow raised before its turn has ended", async () => {
    const proof = deferred()
    const flow = deferred()
    const started: string[] = []
    void prover.runBackground(() => proof.promise)
    const queued = prover.runBackground(async () => void started.push("background"))
    const user = prover.runUserFlow(async () => {
      started.push("user")
      await flow.promise
    })
    proof.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(["user"])
    flow.resolve()
    await Promise.all([user, queued])
    expect(started).toEqual(["user", "background"])
  })

  it("reads busy while a background proof is reserved, and idle once it ends", async () => {
    const proof = deferred()
    const tracked = prover.runBackground(() => proof.promise)
    expect(prover.state.get()).toEqual({ userFlows: 0, reserved: true })
    expect(provingBusy(prover.state.get())).toBe(true)
    proof.resolve()
    await tracked
    await Promise.resolve()
    expect(provingBusy(prover.state.get())).toBe(false)
  })

  it("a failed background proof neither fails nor blocks the user flow", async () => {
    const proof = deferred()
    const tracked = prover.runBackground(() => proof.promise)
    proof.reject(died)
    // The failure still belongs to the background caller...
    await expect(tracked).rejects.toBe(died)
    // ...and the user flow sails through.
    await expect(prover.runUserFlow(async () => "ok")).resolves.toBe("ok")
  })

  it("gives the sends of two user flows one turn each: the second waits, and neither fails", async () => {
    const first = deferred()
    /** Each send's start, then its end: send n starts as 10n and ends as 10n + 1. */
    const steps: number[] = []
    const send = (n: number, held?: Promise<void>) =>
      prover.turn(async () => {
        steps.push(10 * n)
        await held
        steps.push(10 * n + 1)
      })
    const a = prover.runUserFlow(() => send(1, first.promise))
    const b = prover.runUserFlow(() => send(2))
    await flush()
    expect(steps).toEqual([10])
    first.resolve()
    await Promise.all([a, b])
    expect(steps).toEqual([10, 11, 20, 21])
  })

  it("shows the stages of the send whose turn is open, and only its", async () => {
    const hash = `0x${"ab".repeat(32)}`
    await prover.turn(async ({ stage }) => {
      stage(ProvingStage.Simulating, "first")
      stage(ProvingStage.Mining, "first", hash)
    })
    expect(prover.progress.get().stages.first).toMatchObject({
      stage: ProvingStage.Mining,
      txHash: hash,
    })
    await prover.turn(async ({ stage }) => stage(ProvingStage.Simulating, "second"))
    expect(Object.keys(prover.progress.get().stages)).toEqual(["second"])
  })

  it("shows while the open turn waits for the last send's tx", async () => {
    const seen: boolean[] = []
    await prover.turn(async ({ lastSendWait }) => {
      lastSendWait(true)
      seen.push(prover.progress.get().waitingForLastSend)
      lastSendWait(false)
    })
    expect([...seen, prover.progress.get().waitingForLastSend]).toEqual([true, false])
  })

  it("counts each passkey signature, and shows whether the last one failed", () => {
    prover.signing.start()
    expect(prover.progress.get().signing).toEqual({ started: 1, ended: 0, failed: false })
    prover.signing.end(true)
    expect(prover.progress.get().signing).toEqual({ started: 1, ended: 1, failed: true })
    prover.signing.start()
    prover.signing.end()
    expect(prover.progress.get().signing).toEqual({ started: 2, ended: 2, failed: false })
  })
})
