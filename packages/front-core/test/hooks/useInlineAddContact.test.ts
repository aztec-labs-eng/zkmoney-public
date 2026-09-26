import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useInlineAddContact } from "../../src/hooks/useInlineAddContact"
import type { RegistryTagResolution } from "../../src/core"

const L2_ADDRESS = "0x2cb424c9829710e462cbfe9b65e168be6d88eda507dd3e8a1b38b56f4df3cb12"

const resolvedFor = (l2Address: string): RegistryTagResolution => ({
  status: "resolved",
  account: "0x00000000000000000000000000000000000000aa",
  l2Address,
  rollupId: "1",
  sipaStealthPublicKey: { x: 1n, y: 2n },
  xmtpAddress: "0x00000000000000000000000000000000000000b0",
})

function setup(overrides: Partial<Parameters<typeof useInlineAddContact>[0]> = {}) {
  const args = {
    addContact: vi.fn().mockResolvedValue({ success: true }),
    getContacts: vi.fn().mockResolvedValue([]),
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    resolveTag: vi.fn().mockResolvedValue(resolvedFor(L2_ADDRESS)),
    ...overrides,
  }
  const rendered = renderHook(() => useInlineAddContact(args))
  return { args, ...rendered }
}

describe("useInlineAddContact", () => {
  it("resolveTag steps resolving → found and caches the address", async () => {
    let release!: (value: RegistryTagResolution) => void
    const pending = new Promise<RegistryTagResolution>((r) => (release = r))
    const { result } = setup({ resolveTag: vi.fn().mockReturnValue(pending) })

    act(() => {
      void result.current.resolveTag("@Bob.zk.money")
    })
    expect(result.current.lastResolved).toEqual({ tag: "bob", status: "resolving" })

    release(resolvedFor(L2_ADDRESS))
    await waitFor(() =>
      expect(result.current.lastResolved).toEqual({
        tag: "bob",
        status: "found",
        address: L2_ADDRESS,
      }),
    )
  })

  it("resolveTag reports not_found on a miss", async () => {
    const { result } = setup({ resolveTag: vi.fn().mockResolvedValue({ status: "notFound" }) })

    await act(() => result.current.resolveTag("bob"))

    expect(result.current.lastResolved).toEqual({ tag: "bob", status: "not_found" })
  })

  it("discards a stale response — only the most recent resolveTag wins", async () => {
    let releaseFirst!: (value: RegistryTagResolution) => void
    const first = new Promise<RegistryTagResolution>((r) => (releaseFirst = r))
    const resolveTag = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ status: "notFound" } as RegistryTagResolution)
    const { result } = setup({ resolveTag })

    let firstCall!: Promise<void>
    act(() => {
      firstCall = result.current.resolveTag("bob")
    })
    await act(() => result.current.resolveTag("bobby"))
    expect(result.current.lastResolved).toEqual({ tag: "bobby", status: "not_found" })

    releaseFirst(resolvedFor(L2_ADDRESS))
    await act(() => firstCall)

    // The earlier "bob" response landed after "bobby" superseded it — ignored.
    expect(result.current.lastResolved).toEqual({ tag: "bobby", status: "not_found" })
  })

  it("saveResolvedTag saves the cached address and returns the new contact", async () => {
    const { args, result } = setup()

    await act(() => result.current.resolveTag("bob"))
    let saved: unknown
    await act(async () => {
      saved = await result.current.saveResolvedTag("bob")
    })

    expect(saved).toEqual({ tag: "bob", address: L2_ADDRESS })
    expect(args.addContact).toHaveBeenCalledWith("bob", L2_ADDRESS, undefined, undefined, "bob")
    expect(args.refreshContacts).toHaveBeenCalled()
  })

  it("saveResolvedTag ignores a second call while the first is in flight", async () => {
    let release!: () => void
    const pending = new Promise<{ success: boolean }>((r) => (release = () => r({ success: true })))
    const { args, result } = setup({ addContact: vi.fn().mockReturnValue(pending) })

    await act(() => result.current.resolveTag("bob"))
    let first!: Promise<unknown>
    let second: unknown
    await act(async () => {
      first = result.current.saveResolvedTag("bob")
      second = await result.current.saveResolvedTag("bob")
    })

    expect(second).toBeNull()
    await act(async () => {
      release()
      await first
    })
    expect(args.addContact).toHaveBeenCalledTimes(1)
  })

  it("saveResolvedTag errors when the tag was never resolved", async () => {
    const { args, result } = setup()

    let saved: unknown
    await act(async () => {
      saved = await result.current.saveResolvedTag("bob")
    })

    expect(saved).toBeNull()
    expect(result.current.saveError).toBe("Tag not resolved yet")
    expect(args.addContact).not.toHaveBeenCalled()
  })

  it("saveResolvedTag returns an existing contact instead of erroring", async () => {
    const { args, result } = setup({
      getContacts: vi.fn().mockResolvedValue([{ name: "Bob", address: L2_ADDRESS, tag: "bob" }]),
    })

    await act(() => result.current.resolveTag("bob"))
    let saved: unknown
    await act(async () => {
      saved = await result.current.saveResolvedTag("bob")
    })

    expect(saved).toEqual({ tag: "bob", address: L2_ADDRESS })
    expect(result.current.saveError).toBe("")
    expect(args.addContact).not.toHaveBeenCalled()
  })

  it("saveResolvedTag rejects your own tag", async () => {
    const { args, result } = setup({ ownTag: "@Bob.zk.money" })

    await act(() => result.current.resolveTag("bob"))
    let saved: unknown
    await act(async () => {
      saved = await result.current.saveResolvedTag("bob")
    })

    expect(saved).toBeNull()
    expect(result.current.saveError).toBe("@bob.zk.money is your own tag")
    expect(args.addContact).not.toHaveBeenCalled()
  })
})
