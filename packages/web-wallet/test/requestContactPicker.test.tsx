/** New request → A contact: who the request can go to. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const contacts = [
  { id: "1", name: "sam", tag: "sam", address: "0x1", addressKind: "aztec-l2" },
  { id: "2", name: "Bank", tag: "0xabc", address: "0xabc", addressKind: "ethereum-l1" },
]
vi.mock("@obsidion/front-core", () => ({
  useContactsDirectory: () => ({ contacts }),
  useStore: (store: { get(): unknown }) => store.get(),
  normalizeTag: (s: string) => s.trim().replace(/^@/, "").toLowerCase() || null,
}))
vi.mock("../src/platform/session", () => ({ useSession: () => ({ contactActivity: { get: () => ({}) } }) }))
vi.mock("../src/features/contacts/recentPeople", () => ({ recentPeople: (c: unknown[]) => c }))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "river" }),
}))

const { RequestContactPicker } = await import("../src/features/receive/RequestContactPicker")

describe("RequestContactPicker", () => {
  let container: HTMLDivElement
  let root: Root
  const onRequest = vi.fn()
  const text = () => container.textContent ?? ""
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))
  const type = (value: string) =>
    act(async () => {
      const input = container.querySelector<HTMLInputElement>("input")!
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      set.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })

  beforeEach(async () => {
    onRequest.mockClear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(<RequestContactPicker onRequest={onRequest} />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("offers zk.money contacts only", async () => {
    expect(text()).toContain("@sam")
    expect(text()).not.toContain("Bank")
    await act(async () => button("@sam")!.click())
    expect(onRequest).toHaveBeenCalledWith("sam")
  })

  it("shows Sending… on the request on its way and ignores other taps", async () => {
    await act(async () => root.render(<RequestContactPicker sending="sam" onRequest={onRequest} />))
    expect(button("@sam")!.textContent).toContain("Sending…")
    await act(async () => button("@sam")!.click())
    expect(onRequest).not.toHaveBeenCalled()
  })

  it("offers a typed @tag that is not a contact, but never your own", async () => {
    await type("@maya")
    await act(async () => button("@maya")!.click())
    expect(onRequest).toHaveBeenCalledWith("maya")
    await type("@river")
    expect(button("@river")).toBeUndefined()
  })
})
