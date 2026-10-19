import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const viewLink = vi.fn()
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({
  viewLink: (...a: unknown[]) => viewLink(...a),
  decodeLink: (fragment: string) => ({ fragment, status: "unclaimed", flavor: "direct" }),
}))
// Fake fragments never decode; the cache only needs a stable name for one.
vi.mock("../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))

import { stashTicketSignup } from "../src/features/paylink/claimStash"
import { seededLink, watchLink } from "../src/features/paylink/linkStatus"

const deps = {} as never
const unknownTiming = { status: "unclaimed" as const }
const known = { status: "unclaimed" as const, claimableFrom: 1_800_000_100 }

describe("watchLink", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
  })
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
    expect(settled.mock.calls).toEqual([[false]])
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
    expect(settled.mock.calls).toEqual([[false]])

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

describe("the tab's read of a link", () => {
  const read = {
    status: "unclaimed" as const,
    amount: "25",
    claimableFrom: 1_800_000_100,
    claimableUntil: 1_800_086_500,
    memo: "Pizza dinner",
    senderTag: "river",
    txHash: "0xfund",
    email: "never@cached.example",
    tokenAddress: "0xtoken",
  }
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("shows a reload what the last read found, and keeps reading past a miss for the rest of the note", async () => {
    expect(seededLink("frag").amount).toBeUndefined()
    viewLink.mockResolvedValueOnce(read)
    watchLink(deps, "frag", vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    // A reload: the link opens with the amount, window, memo, sender and funding tx, and nothing else.
    expect(seededLink("frag")).toEqual({
      fragment: "frag",
      status: "unclaimed",
      flavor: "direct",
      amount: "25",
      claimableFrom: 1_800_000_100,
      claimableUntil: 1_800_086_500,
      memo: "Pizza dinner",
      senderTag: "river",
      txHash: "0xfund",
    })
    expect(JSON.stringify(sessionStorage)).not.toContain("never@cached.example")

    // Its read misses the note: the window stands, and the link is read again for what was not
    // kept (the token, the email and its commitment).
    viewLink.mockResolvedValueOnce(unknownTiming).mockResolvedValueOnce(read)
    const onLink = vi.fn()
    const settled = vi.fn()
    watchLink(deps, "frag", onLink, vi.fn(), settled)
    await vi.advanceTimersByTimeAsync(0)
    expect(onLink).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: "25", claimableFrom: 1_800_000_100 }),
    )
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onLink).toHaveBeenLastCalledWith(read)
    expect(settled.mock.calls).toEqual([[true]])
    expect(viewLink).toHaveBeenCalledTimes(3)
  })

  it("says the note went unread when every read misses it, though the earlier read fills the window", async () => {
    viewLink.mockResolvedValueOnce(read)
    watchLink(deps, "frag", vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    viewLink.mockResolvedValue(unknownTiming)
    const onLink = vi.fn()
    const settled = vi.fn()
    watchLink(deps, "frag", onLink, vi.fn(), settled)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onLink).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: "25", claimableFrom: 1_800_000_100 }),
    )
    expect(onLink.mock.lastCall?.[0]).not.toHaveProperty("tokenAddress")
    expect(settled.mock.calls).toEqual([[false]])
  })

  it("forgets a link once it reads as claimed", async () => {
    viewLink.mockResolvedValueOnce(read).mockResolvedValueOnce({ status: "claimed" })
    watchLink(deps, "frag", vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    watchLink(deps, "frag", vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(seededLink("frag").amount).toBeUndefined()
  })

  it("seeds a ticket signup's link off the visitor page's read on its marker", () => {
    stashTicketSignup({
      fragment: "frag",
      schedule: { fee: "1", minDeposit: "0" },
      amount: (25n * 10n ** 18n).toString(),
      claimableFrom: 1_800_000_100,
      senderTag: "river",
      tokenAddress: "0xtoken",
      txHash: "0xfund",
    })
    expect(seededLink("frag")).toMatchObject({
      amount: "25",
      claimableFrom: 1_800_000_100,
      senderTag: "river",
      tokenAddress: "0xtoken",
      txHash: "0xfund",
    })
    // Another link's marker seeds nothing.
    expect(seededLink("other").claimableFrom).toBeUndefined()
  })

  it("keeps the marker's token under this tab's own later read, and caches the read without it", async () => {
    stashTicketSignup({
      fragment: "frag",
      schedule: { fee: "1", minDeposit: "0" },
      claimableFrom: 1_800_000_100,
      tokenAddress: "0xtoken",
    })
    viewLink.mockResolvedValueOnce({ ...known, amount: "25" })
    watchLink(deps, "frag", vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(seededLink("frag")).toMatchObject({ amount: "25", tokenAddress: "0xtoken" })
    expect(sessionStorage.getItem("obsidion.link-read:id:frag")).not.toContain("0xtoken")
  })
})
