/** The paylink explainer on the Send page: first "Send via paylink" click, and the "Open" button. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigate = vi.hoisted(() => vi.fn())
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))
vi.mock("@obsidion/front-core", () => ({ useContactsDirectory: () => ({ contacts: [] }) }))
vi.mock("../src/features/contacts/useContactActivity", () => ({ useContactActivity: () => ({}) }))
vi.mock("../src/features/contacts/recentPeople", () => ({ recentPeople: () => [] }))
const deps = vi.hoisted(() => ({ current: undefined as object | undefined }))
vi.mock("../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: () => deps.current }))
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({ voucherAvailable: vi.fn() }))

const { SendScreen } = await import("../src/features/contacts/SendScreen")
const { voucherAvailable } = await import("../src/features/paylink/sponsoredPaylink")

const TITLE = "Send funds via paylink"

describe("SendScreen paylink explainer", () => {
  let container: HTMLDivElement
  let root: Root

  const click = (text: string) =>
    act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!.click(),
    )
  const checkbox = () => container.querySelector<HTMLInputElement>("input[type='checkbox']")

  const mount = async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () =>
      root.render(
        <MemoryRouter>
          <SendScreen />
        </MemoryRouter>,
      ),
    )
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    deps.current = undefined
    await mount()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("never swaps the paylink copy while the allowance read is in flight", async () => {
    await act(async () => root.unmount())
    container.remove()
    let settle!: (ok: boolean) => void
    vi.mocked(voucherAvailable).mockReturnValue(new Promise((resolve) => (settle = resolve)))
    deps.current = {}
    await mount()

    // StableCopy keeps every wording in the layout; the shown one is the only one not aria-hidden.
    const shown = (root: Element | null) =>
      [...(root?.querySelectorAll<HTMLElement>('span[style*="grid-area"]') ?? [])].filter(
        (s) => !s.getAttribute("aria-hidden"),
      )
    const line = () => container.querySelector(".ww-send-option__text")
    expect(shown(line())).toHaveLength(0)
    await click("What is a paylink?")
    const lead = () => container.querySelector(".ww-paylink-info__lead")
    expect(shown(lead())).toHaveLength(0)
    const leadHeightBox = lead()!.querySelector("span")!
    expect(leadHeightBox.children).toHaveLength(2)

    await act(async () => settle(true))
    expect(shown(line()).map((s) => s.textContent)).toEqual([
      "Pay anyone, no account needed. They claim to zk.money or any ETH address.",
    ])
    expect(shown(lead())[0]?.textContent).toContain("no zk.money account needed")
    expect(lead()!.querySelector("span")).toBe(leadHeightBox)
  })

  it("fronts the first paylink send until Got it is pressed with the box checked", async () => {
    await click("Send via paylink")
    expect(container.textContent).toContain(TITLE)
    expect(checkbox()!.checked).toBe(true)
    await act(async () => checkbox()!.click())
    await click("Got it!")
    expect(navigate).toHaveBeenLastCalledWith("/links/new")

    navigate.mockClear()
    await click("Send via paylink")
    expect(navigate).not.toHaveBeenCalled()
    await click("Got it!")
    expect(navigate).toHaveBeenLastCalledWith("/links/new")

    navigate.mockClear()
    await click("Send via paylink")
    expect(navigate).toHaveBeenLastCalledWith("/links/new")
  })

  it("opens from the Open button without the checkbox", async () => {
    await click("What is a paylink?")
    expect(container.textContent).toContain(TITLE)
    expect(checkbox()).toBeNull()
    await click("Got it!")
    expect(container.textContent).not.toContain(TITLE)
    expect(navigate).not.toHaveBeenCalled()
  })
})
