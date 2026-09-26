import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useAddContactSheet } from "../../src/hooks/useAddContactSheet"
import type { RegistryTagResolution } from "../../src/core"

const L2_ADDRESS = "0x2cb424c9829710e462cbfe9b65e168be6d88eda507dd3e8a1b38b56f4df3cb12"

const resolved: RegistryTagResolution = {
  status: "resolved",
  account: "0x00000000000000000000000000000000000000aa",
  l2Address: L2_ADDRESS,
  rollupId: "1",
  sipaStealthPublicKey: { x: 1n, y: 2n },
  xmtpAddress: "0x00000000000000000000000000000000000000b0",
}

function setup(overrides: Partial<Parameters<typeof useAddContactSheet>[0]> = {}) {
  const args = {
    addContact: vi.fn().mockResolvedValue({ success: true }),
    getContacts: vi.fn().mockResolvedValue([]),
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    resolveTag: vi.fn().mockResolvedValue(resolved),
    ...overrides,
  }
  const rendered = renderHook(() => useAddContactSheet(args))
  return { args, ...rendered }
}

const submit = (tag: string, name = "") => ({ tag, name })

describe("useAddContactSheet", () => {
  it("resolves and saves a found tag: idle → resolving → success, sheet closes", async () => {
    let release!: (value: RegistryTagResolution) => void
    const pending = new Promise<RegistryTagResolution>((r) => (release = r))
    const { args, result } = setup({ resolveTag: vi.fn().mockReturnValue(pending) })

    act(() => {
      result.current.open("bob")
    })
    expect(result.current.sheetProps.visible).toBe(true)

    let submitDone!: Promise<void>
    act(() => {
      submitDone = result.current.sheetProps.onSubmit(submit("@Bob.zk.money", "Bobby"))
    })
    await waitFor(() => expect(result.current.sheetProps.isResolving).toBe(true))

    release(resolved)
    await act(() => submitDone)

    expect(args.resolveTag).toHaveBeenCalledWith("bob")
    expect(args.addContact).toHaveBeenCalledWith("Bobby", L2_ADDRESS, undefined, undefined, "bob")
    expect(args.refreshContacts).toHaveBeenCalled()
    expect(result.current.sheetProps.visible).toBe(false)
    expect(result.current.sheetProps.errorMessage).toBe("")
  })

  it("shows not-found error when the tag does not resolve", async () => {
    const { args, result } = setup({
      resolveTag: vi.fn().mockResolvedValue({ status: "notFound" }),
    })

    await act(() => result.current.sheetProps.onSubmit(submit("bob")))

    expect(result.current.sheetProps.errorMessage).toBe("No user found for @bob.zk.money")
    expect(args.addContact).not.toHaveBeenCalled()
  })

  it("shows stale-rollup error when the tag has not upgraded", async () => {
    const { args, result } = setup({
      resolveTag: vi.fn().mockResolvedValue({ status: "staleRollup" }),
    })

    await act(() => result.current.sheetProps.onSubmit(submit("bob")))

    expect(result.current.sheetProps.errorMessage).toBe(
      "@bob.zk.money hasn't upgraded to the current network yet",
    )
    expect(args.addContact).not.toHaveBeenCalled()
  })

  it("rejects a duplicate tag before resolving", async () => {
    const { args, result } = setup({
      getContacts: vi.fn().mockResolvedValue([{ name: "Bob", address: L2_ADDRESS, tag: "bob" }]),
    })

    await act(() => result.current.sheetProps.onSubmit(submit("bob")))

    expect(result.current.sheetProps.errorMessage).toBe("@bob.zk.money is already in your contacts")
    expect(args.resolveTag).not.toHaveBeenCalled()
  })

  it("rejects adding your own tag", async () => {
    const { args, result } = setup({ ownTag: "@Bob.zk.money" })

    await act(() => result.current.sheetProps.onSubmit(submit("bob")))

    expect(result.current.sheetProps.errorMessage).toBe("@bob.zk.money is your own tag")
    expect(args.resolveTag).not.toHaveBeenCalled()
    expect(args.addContact).not.toHaveBeenCalled()
  })

  it("surfaces addContact failure as an error", async () => {
    const { result } = setup({
      addContact: vi.fn().mockResolvedValue({ success: false, errors: "storage full" }),
    })

    await act(() => result.current.sheetProps.onSubmit(submit("bob")))

    expect(result.current.sheetProps.errorMessage).toBe("storage full")
    expect(result.current.sheetProps.visible).toBe(false)
  })
})
