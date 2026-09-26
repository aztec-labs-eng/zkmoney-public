/**
 * The proving gate is what keeps a background SIPA broadcast from making a user's send/withdraw
 * throw `LocalProvingInFlight`: background proofs must not start while a user flow runs, and a
 * user flow must wait out a proof already in flight rather than collide with it.
 */
import { describe, expect, it } from "vitest"
import { runUserFlow, trackBackgroundProve, userFlowActive } from "../src/features/provingGate"

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("provingGate", () => {
  it("raises the flag synchronously and lowers it when the flow settles", async () => {
    expect(userFlowActive()).toBe(false)
    const gate = deferred()
    const flow = runUserFlow(() => gate.promise)
    // Synchronous: a background prover checking in the same tick must already see the flag.
    expect(userFlowActive()).toBe(true)
    gate.resolve()
    await flow
    expect(userFlowActive()).toBe(false)
  })

  it("lowers the flag when the flow throws", async () => {
    await expect(runUserFlow(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(userFlowActive()).toBe(false)
  })

  it("holds the flag until the last concurrent flow ends", async () => {
    const a = deferred()
    const b = deferred()
    const flowA = runUserFlow(() => a.promise)
    const flowB = runUserFlow(() => b.promise)
    a.resolve()
    await flowA
    expect(userFlowActive()).toBe(true)
    b.resolve()
    await flowB
    expect(userFlowActive()).toBe(false)
  })

  it("makes a user flow wait out an in-flight background proof", async () => {
    const proof = deferred()
    void trackBackgroundProve(() => proof.promise)
    let started = false
    const flow = runUserFlow(async () => {
      started = true
    })
    await Promise.resolve()
    expect(started).toBe(false)
    proof.resolve()
    await flow
    expect(started).toBe(true)
  })

  it("a failed background proof neither fails nor blocks the user flow", async () => {
    const proof = deferred()
    const tracked = trackBackgroundProve(() => proof.promise)
    proof.reject(new Error("proof died"))
    // The failure still belongs to the background caller...
    await expect(tracked).rejects.toThrow("proof died")
    // ...and the user flow sails through.
    await expect(runUserFlow(async () => "ok")).resolves.toBe("ok")
  })
})
