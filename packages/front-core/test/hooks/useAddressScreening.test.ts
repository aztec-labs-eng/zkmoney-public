import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useAddressScreening } from "../../src/hooks/useAddressScreening"
import type { AddressScreener, ScreeningVerdict } from "../../src/core"

const A = "0xAaBbCcDdEeFf00112233445566778899aAbBcCdD"
const B = "0x1111111111111111111111111111111111111111"

/** Screener whose responses resolve only when the test releases them, for staleness ordering. */
function gatedScreener() {
  const pending = new Map<string, (v: ScreeningVerdict) => void>()
  const screener: AddressScreener = {
    screen: (address) => new Promise((resolve) => pending.set(address.toLowerCase(), resolve)),
  }
  return {
    screener,
    release: (address: string, v: ScreeningVerdict) => pending.get(address.toLowerCase())!(v),
  }
}

describe("useAddressScreening", () => {
  it("reports compliant / blocked with the reason", async () => {
    const blockedReason = { code: "sanctioned", message: "Address is sanctioned" }
    const screener: AddressScreener = {
      screen: async (address) =>
        address === A ? { compliant: true } : { compliant: false, reason: blockedReason },
    }
    const { result } = renderHook(() => useAddressScreening(screener))

    await act(() => result.current.screen(A))
    expect(result.current.lastScreened).toEqual({ address: A.toLowerCase(), status: "compliant" })

    await act(() => result.current.screen(B))
    expect(result.current.lastScreened).toEqual({
      address: B,
      status: "blocked",
      reason: blockedReason,
    })
  })

  it("reports error when the screener throws — verdict unknown, not a pass", async () => {
    const screener: AddressScreener = {
      screen: () => Promise.reject(new Error("network down")),
    }
    const { result } = renderHook(() => useAddressScreening(screener))
    await act(() => result.current.screen(A))
    expect(result.current.lastScreened).toEqual({ address: A.toLowerCase(), status: "error" })
  })

  it("an empty address resets", async () => {
    const screener: AddressScreener = { screen: async () => ({ compliant: true }) }
    const { result } = renderHook(() => useAddressScreening(screener))
    await act(() => result.current.screen(A))
    expect(result.current.lastScreened).not.toBeNull()
    await act(() => result.current.screen("  "))
    expect(result.current.lastScreened).toBeNull()
  })

  it("a stale response never overwrites the latest call's", async () => {
    const { screener, release } = gatedScreener()
    const { result } = renderHook(() => useAddressScreening(screener))

    let first: Promise<void>
    let second: Promise<void>
    act(() => {
      first = result.current.screen(A)
      second = result.current.screen(B)
    })
    expect(result.current.lastScreened).toEqual({ address: B, status: "screening" })

    // The superseded call resolving late must be discarded.
    await act(async () => {
      release(A, { compliant: false })
      await first
    })
    expect(result.current.lastScreened).toEqual({ address: B, status: "screening" })

    await act(async () => {
      release(B, { compliant: true })
      await second
    })
    expect(result.current.lastScreened).toEqual({ address: B, status: "compliant" })
  })
})
