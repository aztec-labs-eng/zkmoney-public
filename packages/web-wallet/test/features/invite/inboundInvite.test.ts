// @vitest-environment node
/** An invite link's code waits in device storage for the signup it brought. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { captureInboundInvite, inboundInvite } from "../../../src/features/invite/inboundInvite"

let local: Map<string, string>
let refused: boolean
beforeEach(() => {
  local = new Map()
  refused = false
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refused) throw new Error("QuotaExceededError")
      local.set(key, value)
    },
    removeItem: (key: string) => void local.delete(key),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe("captureInboundInvite", () => {
  it("keeps a well-formed code from the link", () => {
    captureInboundInvite("https://zk.money/?invite=abcd1234", 0)
    expect(inboundInvite(1)).toBe("abcd1234")
  })

  it("credits nothing, and does not throw, when the storage refuses the code", () => {
    refused = true
    captureInboundInvite("https://zk.money/?invite=abcd1234", 0)
    expect(inboundInvite(1)).toBeUndefined()
  })
})
