/**
 * The portal's cut is one read shared by every screen that prices a fee, so what is pinned is the
 * cache: one read per portal however many callers ask and however the address is cased, a transient
 * RPC failure retried rather than reported, and a read that fails every attempt leaving nothing
 * cached behind. Each case uses its own portal, which is what keeps the cache entries apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, PublicClient } from "viem"

const readFpcFundingCutMock = vi.fn(async (..._args: unknown[]) => 0n)

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readFpcFundingCut: (...args: unknown[]) => readFpcFundingCutMock(...args),
}))

import { fpcFundingCut } from "../src/features/fees/fpcFundingCut"

const CUT = 250_000_000_000_000_000n
const client = {} as PublicClient
const portal = (byte: string) => `0x${byte.repeat(20)}` as Address

describe("fpcFundingCut", () => {
  beforeEach(() => {
    readFpcFundingCutMock.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("reads once for every caller on the same portal, however it is cased", async () => {
    readFpcFundingCutMock.mockResolvedValue(CUT)
    const address = portal("AB")

    const values = await Promise.all([
      fpcFundingCut(client, address),
      fpcFundingCut(client, address.toLowerCase() as Address),
      fpcFundingCut(client, address),
    ])

    expect(values).toEqual([CUT, CUT, CUT])
    expect(readFpcFundingCutMock).toHaveBeenCalledTimes(1)
  })

  it("retries a failed attempt and answers the callers that are waiting", async () => {
    readFpcFundingCutMock.mockRejectedValueOnce(new Error("RPC unavailable")).mockResolvedValue(CUT)

    const pending = fpcFundingCut(client, portal("cd"))
    await vi.advanceTimersByTimeAsync(500)

    await expect(pending).resolves.toBe(CUT)
    expect(readFpcFundingCutMock).toHaveBeenCalledTimes(2)
  })

  it("rejects after three attempts and drops the cache, so the next call reads again", async () => {
    readFpcFundingCutMock.mockRejectedValue(new Error("RPC unavailable"))
    const address = portal("ef")

    const rejected = expect(fpcFundingCut(client, address)).rejects.toThrow("RPC unavailable")
    await vi.advanceTimersByTimeAsync(1_500)
    await rejected
    expect(readFpcFundingCutMock).toHaveBeenCalledTimes(3)

    readFpcFundingCutMock.mockResolvedValue(CUT)
    await expect(fpcFundingCut(client, address)).resolves.toBe(CUT)
    expect(readFpcFundingCutMock).toHaveBeenCalledTimes(4)
  })
})
