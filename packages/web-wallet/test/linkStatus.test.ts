import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const viewLink = vi.fn()
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({
  viewLink: (...a: unknown[]) => viewLink(...a),
}))

import { watchLink } from "../src/features/paylink/linkStatus"

const deps = {} as never
const unknownTiming = { status: "unclaimed" as const }
const known = { status: "unclaimed" as const, claimableFrom: 1_800_000_100 }

describe("watchLink", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("re-reads an unclaimed link until its note yields from_claimable", async () => {
    viewLink.mockResolvedValueOnce(unknownTiming).mockResolvedValueOnce(known)
    const onLink = vi.fn()
    watchLink(deps, "frag", onLink, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(onLink).toHaveBeenLastCalledWith(unknownTiming)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onLink).toHaveBeenLastCalledWith(known)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(viewLink).toHaveBeenCalledTimes(2)
  })

  it("settles after exhausting unreadable-note retries", async () => {
    viewLink.mockResolvedValue(unknownTiming)
    const settled = vi.fn()
    const stop = watchLink(deps, "frag", vi.fn(), vi.fn(), settled)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(viewLink).toHaveBeenCalledTimes(13)
    stop()
  })

  it("settles on errors but ignores an in-flight read after cancellation", async () => {
    const error = new Error("node unavailable")
    viewLink.mockRejectedValueOnce(error)
    const onError = vi.fn()
    const settled = vi.fn()
    watchLink(deps, "frag", vi.fn(), onError, settled)
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(error)
    expect(settled).toHaveBeenCalledTimes(1)

    let resolve!: (value: typeof known) => void
    viewLink.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const onLink = vi.fn()
    const stop = watchLink(deps, "frag", onLink, onError, settled)
    stop()
    resolve(known)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onLink).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it("stops on a claimed link and on cancel", async () => {
    viewLink.mockResolvedValue({ status: "claimed" })
    const onLink = vi.fn()
    watchLink(deps, "frag", onLink, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(viewLink).toHaveBeenCalledTimes(1)

    viewLink.mockResolvedValue(unknownTiming)
    const stop = watchLink(deps, "frag", onLink, () => {})
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(viewLink).toHaveBeenCalledTimes(2)
  })
})
