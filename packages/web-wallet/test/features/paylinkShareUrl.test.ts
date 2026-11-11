// @vitest-environment node
/** A link is shared as its short form: a paylink when it carries a seed, a request by its key. */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { decodeLinkFragment, encodePaylinkInline, LinkKind } from "@obsidion/sdk"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { paylinkRowShareUrl, shortRequestUrl } from "../../src/features/shortLinks"
import { defaultConfig } from "../support/page"

const ORIGIN = "https://wallet.zk.money"
beforeEach(() => vi.stubGlobal("location", { origin: ORIGIN }))
afterEach(() => vi.unstubAllGlobals())

it("shares a seeded link as its short link, and one that does not decode as it is", async () => {
  const seed = Uint8Array.from({ length: 16 }, (_, i) => i)
  const seeded = `${ORIGIN}/link#${encodePaylinkInline({
    secret: Fr.random(),
    paylinkType: "paylinkDirect",
    classId: Fr.random(),
    chainId: 1,
    rollupVersion: 7,
    fallbackKeyHash: Fr.random(),
    seed,
  })}`
  const shared = paylinkRowShareUrl(seeded, defaultConfig.network)
  expect(decodeLinkFragment(shared.slice(shared.indexOf("#") + 1))).toEqual({
    kind: LinkKind.Paylink,
    seed,
  })
  const garbled = `${ORIGIN}/link#not-a-paylink`
  expect(paylinkRowShareUrl(garbled, defaultConfig.network)).toBe(garbled)
})

it("shares a request's short link on the request path, carrying its seed", async () => {
  const seed = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
  const url = shortRequestUrl(seed, defaultConfig.network)
  expect(url.startsWith(`${ORIGIN}/request#`)).toBe(true)
  expect(decodeLinkFragment(url.slice(url.indexOf("#") + 1))).toEqual({
    kind: LinkKind.Request,
    seed,
  })
})
