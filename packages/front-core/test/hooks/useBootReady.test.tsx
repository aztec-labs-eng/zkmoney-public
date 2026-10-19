import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { bootPriority } from "../../src/core/services/transactions/bootPriority"
import { useBootReady } from "../../src/hooks/useBootReady"

afterEach(() => vi.restoreAllMocks())

describe("useBootReady", () => {
  it("turns ready when the reader's wait releases", async () => {
    let release!: () => void
    vi.spyOn(bootPriority, "isReady").mockReturnValue(false)
    const wait = vi
      .spyOn(bootPriority, "whenReady")
      .mockReturnValue(new Promise<void>((r) => (release = r)))
    const { result } = renderHook(() => useBootReady("savings"))
    expect(result.current).toBe(false)
    expect(wait).toHaveBeenCalledWith("savings")

    await act(async () => release())
    expect(result.current).toBe(true)
  })

  it("is ready on first render once the stage was reached", () => {
    vi.spyOn(bootPriority, "isReady").mockReturnValue(true)
    const wait = vi.spyOn(bootPriority, "whenReady")
    const { result } = renderHook(() => useBootReady("savings"))
    expect(result.current).toBe(true)
    expect(wait).not.toHaveBeenCalled()
  })
})
