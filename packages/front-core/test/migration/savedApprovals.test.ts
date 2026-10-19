import { describe, expect, it, vi } from "vitest"
import { ApprovalNeededError } from "@obsidion/sdk"
import {
  ApprovalGate,
  savedChallengeSigner,
  webAuthnAssertionCodec,
} from "../../src/core/migration/savedApprovals"

function memory() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: vi.fn(async (key: string) => items.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      items.set(key, value)
    }),
  }
}

const assertion = () => ({
  signature: new Uint8Array([1, 2, 3]),
  authenticatorData: new Uint8Array([4, 5]),
  clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}'),
})

describe("saved approvals", () => {
  it("asks once per challenge and returns the saved assertion after", async () => {
    const storage = memory()
    const sign = vi.fn(async () => assertion())
    const saved = savedChallengeSigner(sign, storage, "upgrade/approvals", webAuthnAssertionCodec)
    const challenge = Buffer.from("aa".repeat(32), "hex")

    const first = await saved(challenge)
    const again = await savedChallengeSigner(
      sign,
      storage,
      "upgrade/approvals",
      webAuthnAssertionCodec,
    )(challenge)

    const bytes = (value: typeof first) => Object.values(value).map((field) => [...field])
    expect(sign).toHaveBeenCalledOnce()
    expect(bytes(again)).toEqual(bytes(first))
  })

  it("asks again for another challenge or another run's approvals", async () => {
    const storage = memory()
    const sign = vi.fn(async (_challenge: `0x${string}`) => ({ signature: "0x01" }))
    await savedChallengeSigner(sign, storage, "run-a")("0xaa")
    await savedChallengeSigner(sign, storage, "run-a")("0xbb")
    await savedChallengeSigner(sign, storage, "run-b")("0xaa")
    expect(sign).toHaveBeenCalledTimes(3)
  })

  it("asks no one once its run is cancelled, but still returns a saved approval", async () => {
    const storage = memory()
    const gate = new ApprovalGate()
    const sign = vi.fn(async (_challenge: `0x${string}`) => ({ signature: "0x01" }))
    const saved = savedChallengeSigner(sign, storage, "run", undefined, gate)
    await saved("0xaa")
    const cancel = new AbortController()
    gate.signal = cancel.signal
    cancel.abort()

    await expect(saved("0xbb")).rejects.toThrow()
    expect(await saved("0xaa")).toEqual({ signature: "0x01" })
    expect(sign).toHaveBeenCalledOnce()
  })

  it("hands the run's signal to the prompt", async () => {
    const gate = new ApprovalGate()
    gate.signal = new AbortController().signal
    const sign = vi.fn(async (_challenge: `0x${string}`, _opts?: { signal?: AbortSignal }) => ({}))
    await savedChallengeSigner(sign, memory(), "run", undefined, gate)("0xaa")
    expect(sign).toHaveBeenCalledWith("0xaa", { signal: gate.signal })
  })

  it("asks no one outside the user's own action, but still returns a saved approval", async () => {
    const storage = memory()
    const gate = new ApprovalGate()
    const sign = vi.fn(async (_challenge: `0x${string}`) => ({ signature: "0x01" }))
    const saved = savedChallengeSigner(sign, storage, "run", undefined, gate)
    await saved("0xaa")
    gate.prompts = false

    await expect(saved("0xbb")).rejects.toThrow(ApprovalNeededError)
    expect(await saved("0xaa")).toEqual({ signature: "0x01" })
    expect(sign).toHaveBeenCalledOnce()
  })

  it("saves nothing when the prompt is refused", async () => {
    const storage = memory()
    const sign = vi.fn(async () => {
      throw new Error("The operation either timed out or was not allowed")
    })
    await expect(savedChallengeSigner(sign, storage, "run")("0xaa")).rejects.toThrow("not allowed")
    expect(storage.items.size).toBe(0)
  })
})
