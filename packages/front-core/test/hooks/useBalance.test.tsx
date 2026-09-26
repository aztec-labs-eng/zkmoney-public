import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { Asset } from "../../src/types/tokens"

const assetContext = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

vi.mock("src/contexts", () => ({
  useAssetContext: () => assetContext.value,
}))

const { useBalance } = await import("../../src/hooks/useBalance")
const { globalEventEmitter } = await import("../../src/core/services/GlobalEventEmitter")

const asset = (over: Partial<Asset>): Asset => ({
  name: "DAI",
  symbol: "DAI",
  address: "0xaaa",
  decimals: 18,
  balance: 0,
  publicBalance: 0,
  privateBalance: 0,
  balanceAtomic: 0n,
  price: 1,
  change: 0,
  changeAmount: 0,
  logo: "dai.png",
  ...over,
})

function render(ctx: Record<string, unknown>) {
  assetContext.value = ctx
  return renderHook(() => useBalance()).result.current
}

describe("useBalance", () => {
  it("holds the placeholder while a fresh device's first sync pass runs", () => {
    const live = asset({ address: "0xlive", balance: 12 })
    const ctx = { assets: [live], liveAssetsLoaded: true, activeTokenAddress: "0xlive" }
    const end = globalEventEmitter.beginSyncCatchUp()
    expect(render(ctx).balanceKnown).toBe(false)
    end()
    expect(render(ctx).balanceKnown).toBe(true)
  })

  it("reports the balance at the active token address", () => {
    const stale = asset({ address: "0xstale", balance: 999 })
    const live = asset({ address: "0xlive", balance: 12 })

    const result = render({
      assets: [stale, live],
      liveAssetsLoaded: true,
      activeTokenAddress: "0xlive",
    })

    expect(result.walletBalance).toBe("12.00")
    expect(result.balanceKnown).toBe(true)
  })

  it("holds the loading state when a cold cache is ambiguous", () => {
    // Two cached rows, no address yet: the selector declines to guess, and the
    // hook must not present that as a confident zero — the placeholder stays up.
    const result = render({
      assets: [
        asset({ address: "0xstale", balance: 999 }),
        asset({ address: "0xlive", balance: 12 }),
      ],
      liveAssetsLoaded: false,
      activeTokenAddress: null,
    })

    expect(result.walletAsset).toBeNull()
    expect(result.balanceKnown).toBe(false)
    expect(result.assetsLoaded).toBe(false)
  })

  it("reports a real zero once a live fetch completes without finding the token", () => {
    // Empty accounts have their zero-balance assets filtered out, so "no asset"
    // after a successful fetch is the truth, not an unknown.
    const result = render({
      assets: [],
      liveAssetsLoaded: true,
      activeTokenAddress: "0xlive",
    })

    expect(result.walletAsset).toBeNull()
    expect(result.walletBalance).toBe("0.00")
    expect(result.balanceKnown).toBe(true)
  })

  it("renders a lone cached row before the token address resolves", () => {
    const result = render({
      assets: [asset({ address: "0xlive", balance: 7 })],
      liveAssetsLoaded: false,
      activeTokenAddress: null,
    })

    expect(result.walletBalance).toBe("7.00")
    expect(result.balanceKnown).toBe(true)
    // Still not a live figure — overspend gating must keep distrusting it.
    expect(result.assetsLoaded).toBe(false)
  })

  it("reports nothing known on a fresh install with no cache", () => {
    const result = render({ assets: null, liveAssetsLoaded: false, activeTokenAddress: null })

    expect(result.walletAsset).toBeNull()
    expect(result.balanceKnown).toBe(false)
  })
})
