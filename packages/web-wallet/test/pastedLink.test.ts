import { describe, expect, it, vi } from "vitest"

// The paylink codec is the sdk's (fail-closed, own tests); here it just accepts a marker
// fragment. Partial mock — front-core (the request codec) imports the sdk for real.
vi.mock(import("@obsidion/sdk"), async (importOriginal) => ({
  ...(await importOriginal()),
  decodePaylinkInline: (fragment: string) => {
    if (fragment !== VALID) throw new Error("Invalid paylink link")
    return {} as never
  },
}))

const VALID = "AaBb123-_"

import { encodeRequestInline } from "@obsidion/front-core"
import { pastedLinkRoute } from "../src/features/paylink/pastedLink"

// A real v3 request fragment — the request codec is not mocked.
const REQUEST_FRAGMENT = encodeRequestInline({
  requestId: `0x${"0a".repeat(32)}`,
  requesterTag: "alice",
  amountAtomic: 1_000_000n,
  networkId: "0xrollup",
  tokenAddress: `0x${"1b".repeat(32)}`,
})

describe("pastedLinkRoute", () => {
  it("routes a claim URL, a web link URL, and a bare fragment", () => {
    for (const text of [
      `https://paylink.zk.money/claim#${VALID}`,
      `https://wallet.zk.money/link#${VALID}`,
      ` ${VALID} `,
    ]) {
      expect(pastedLinkRoute(text)).toBe(`/link#${VALID}`)
    }
  })

  it("routes a request URL and a bare request fragment to /request", () => {
    for (const text of [
      `https://paylink.zk.money/request#${REQUEST_FRAGMENT}`,
      REQUEST_FRAGMENT,
    ]) {
      expect(pastedLinkRoute(text)).toBe(`/request#${REQUEST_FRAGMENT}`)
    }
  })

  it("rejects text that decodes as neither", () => {
    for (const text of ["", "   ", "hello", "https://paylink.zk.money/claim#garbage", "#"]) {
      expect(pastedLinkRoute(text)).toBeNull()
    }
  })
})
