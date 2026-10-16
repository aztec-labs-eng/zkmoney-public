/**
 * `getRetiredRollupSources` must never cache a promise that can hang forever: a stalled fetch
 * would otherwise pin every later sign-in attempt on the same stuck promise.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  loadRetiredRollupSources: vi.fn(),
}))
vi.mock("@obsidion/core/oxide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/core/oxide")>()),
  loadRetiredRollupSources: h.loadRetiredRollupSources,
}))

import { Network } from "@obsidion/core/constants"
import { ASSET_TUPLE_TIMEOUT_MS, getRetiredRollupSources } from "../src/config/oxideTuple"
import type { WebWalletConfig } from "../src/config/env"

const CONFIG = {
  oxideProfile: { manifestUrl: "https://oxide.example/manifest.json", portal: "0xabc" },
  network: Network.TESTNET,
} as unknown as WebWalletConfig

describe("getRetiredRollupSources", () => {
  afterEach(() => {
    vi.useRealTimers()
    h.loadRetiredRollupSources.mockReset()
  })

  it("waits as long as a portal tuple fetch before rejecting a stalled fetch", async () => {
    vi.useFakeTimers()
    h.loadRetiredRollupSources.mockReturnValue(new Promise(() => {}))

    let error: unknown
    const settled = getRetiredRollupSources(CONFIG).catch((e: unknown) => {
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
    const first = expect(getRetiredRollupSources(CONFIG)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(ASSET_TUPLE_TIMEOUT_MS)
    await first

    vi.useRealTimers()
    h.loadRetiredRollupSources.mockResolvedValueOnce([])
    await expect(getRetiredRollupSources(CONFIG)).resolves.toEqual([])
  })
})
