import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EnsClient } from "../../src/core/services/ens"
import { useEnsAddress } from "../../src/hooks/useEnsAddress"

const noAddress = () => ({ getEnsAddress: async () => null } as unknown as EnsClient)

afterEach(() => vi.useRealTimers())

describe("useEnsAddress", () => {
  it("looks a re-entered name up afresh instead of reusing the last answer", async () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ text }) => useEnsAddress(text, noAddress), {
      initialProps: { text: "alice.eth" },
    })
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(result.current).toEqual({ name: "alice.eth", state: "missing" })

    rerender({ text: "" })
    rerender({ text: "alice.eth" })
    expect(result.current).toEqual({ name: "alice.eth", state: "resolving" })
  })

  it("flags dotted text ENS rejects", () => {
    const { result } = renderHook(() => useEnsAddress("vit alik.eth", noAddress))
    expect(result.current).toEqual({ name: "vit alik.eth", state: "invalid" })
  })
})
