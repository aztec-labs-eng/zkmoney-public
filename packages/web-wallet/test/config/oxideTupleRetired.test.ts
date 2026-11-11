/**
 * `retiredRollupSources` must never cache a promise that can hang forever: a stalled fetch
 * would otherwise pin every later sign-in attempt on the same stuck promise.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  loadRetiredRollupSources: vi.fn(),
  loadOxideManifestTuple: vi.fn(),
}))
vi.mock("@obsidion/core/oxide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/core/oxide")>()),
  loadRetiredRollupSources: h.loadRetiredRollupSources,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  loadOxideManifestTuple: h.loadOxideManifestTuple,
}))

import { Network } from "@obsidion/core/constants"
import { ASSET_TUPLE_TIMEOUT_MS } from "../../src/config/oxideTuple"
import { createPageChain } from "../../src/app/pageChain"
import type { WebWalletConfig } from "../../src/config/env"
import { testChain } from "../support/query"

const CONFIG = {
  oxideProfile: { manifestUrl: "https://oxide.example/manifest.json", portal: "0xabc" },
  network: Network.TESTNET,
} as unknown as WebWalletConfig

describe("retiredRollupSources", () => {
  const { retiredRollupSources } = createPageChain(CONFIG, testChain())
  afterEach(() => {
    vi.useRealTimers()
    h.loadRetiredRollupSources.mockReset()
  })

  it("waits as long as a portal tuple fetch before rejecting a stalled fetch", async () => {
    vi.useFakeTimers()
    h.loadRetiredRollupSources.mockReturnValue(new Promise(() => {}))

    let error: unknown
    const settled = retiredRollupSources.read().catch((e: unknown) => {
      error = e
    })
    await vi.advanceTimersByTimeAsync(ASSET_TUPLE_TIMEOUT_MS - 1)
    expect(error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(String(error)).toMatch(/timed out/)
  })

  it("retries on the next call instead of reusing the timed-out promise", async () => {
    vi.useFakeTimers()
    h.loadRetiredRollupSources.mockReturnValueOnce(new Promise(() => {}))
    const first = expect(retiredRollupSources.read()).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(ASSET_TUPLE_TIMEOUT_MS)
    await first

    vi.useRealTimers()
    h.loadRetiredRollupSources.mockResolvedValueOnce([])
    await expect(retiredRollupSources.read()).resolves.toEqual([])
  })
})

describe("otherManifestSources", () => {
  const WITH_V5 = {
    ...CONFIG,
    oxideProfile: { ...CONFIG.oxideProfile, portal: "0xv6" },
    sourceRollups: [
      {
        manifestUrl: "https://oxide.example/staging.v4.json",
        pins: [{ portal: "0xv5" }],
      },
    ],
  } as unknown as WebWalletConfig
  const { otherManifestSources } = createPageChain(WITH_V5, testChain())

  afterEach(() => {
    vi.useRealTimers()
    h.loadOxideManifestTuple.mockReset()
  })

  it("retries a stalled manifest on the next call", async () => {
    vi.useFakeTimers()
    h.loadOxideManifestTuple.mockReturnValueOnce(new Promise(() => {}))
    const first = expect(otherManifestSources.read()).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(ASSET_TUPLE_TIMEOUT_MS)
    await first

    vi.useRealTimers()
    h.loadOxideManifestTuple.mockResolvedValueOnce({ portal: "0xv5" })
    await expect(otherManifestSources.read()).resolves.toEqual([{ portal: "0xv5" }])
  })
})
