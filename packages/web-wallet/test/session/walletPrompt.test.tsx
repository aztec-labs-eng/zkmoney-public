// @vitest-environment node
/** How the page's one wallet request refuses a second while the wallet holds the first. */
import { beforeEach, describe, expect, it } from "vitest"
import {
  createWalletPrompt,
  WalletPromptOpenError,
  type WalletPrompt,
} from "../../src/session/walletPrompt"

describe("the page's wallet request", () => {
  let prompt: WalletPrompt
  beforeEach(() => void (prompt = createWalletPrompt()))
  const open = () => prompt.request.get() !== undefined

  it("refuses a second request while the first is open, and allows one once it settles", () => {
    const first = prompt.begin()
    expect(open()).toBe(true)
    expect(() => prompt.begin()).toThrow(WalletPromptOpenError)
    prompt.settle(first)
    expect(open()).toBe(false)
    prompt.begin()
    expect(open()).toBe(true)
  })

  it("marks a cancelled request abandoned until the wallet answers, and refuses a new one", () => {
    const token = prompt.begin()
    expect(prompt.cancelled(token)).toBe(false)
    expect(prompt.openElsewhere()).toBeUndefined()
    prompt.cancel()
    expect(prompt.cancelled(token)).toBe(true)
    expect(open()).toBe(true)
    expect(prompt.openElsewhere()).toBeDefined()
    expect(() => prompt.begin()).toThrow(WalletPromptOpenError)
    prompt.settle(token)
    expect(open()).toBe(false)
    expect(prompt.openElsewhere()).toBeUndefined()
    expect(prompt.cancelled(token)).toBe(false)
  })

  it("ignores a settle for a request it never issued", () => {
    const token = prompt.begin()
    prompt.settle(token + 1)
    prompt.settle(undefined)
    expect(open()).toBe(true)
  })
})
