/** /activity shows the account Home's "View all" came from: Savings' feed with `?account=savings`. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Icon: ({ name }: { name: string }) => <i data-icon={name} />,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  activityCsv: vi.fn(() => "main"),
  savingsCsv: vi.fn(() => "savings"),
}))
vi.mock("../src/features/requests/RequestsUnavailableNotice", () => ({
  RequestsUnavailableNotice: () => <p>Requests unavailable</p>,
}))
vi.mock("../src/features/requests/NonContactRequestsScreen", () => ({
  NonContactRequestsEntry: () => <p>Requests from people not in your contacts</p>,
}))
vi.mock("../src/ui/screens/useActivityEntries", () => ({
  useActivityEntries: () => ({
    entries: [
      { id: "main", ts: 1, direction: "in", pending: false, node: <div key="m">Main row</div> },
    ],
    savingsEntries: [
      { id: "move", ts: 1, direction: "in", pending: false, node: <div key="s">Savings row</div> },
    ],
    hydrated: true,
    savingsHydrated: true,
    requestsUnavailable: true,
    detailModals: null,
    csvSources: { transactions: [], items: [], requests: [] },
    savingsCsvSources: { moves: [], burns: new Map() },
  }),
}))
const { ActivityScreen } = await import("../src/ui/screens/ActivityScreen")
const { activityCsv, savingsCsv } = await import("@obsidion/front-core")

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const open = (path: string) =>
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <ActivityScreen />
      </MemoryRouter>,
    ),
  )

describe("ActivityScreen account", () => {
  it("lists the Savings account's moves for ?account=savings, and Main's feed otherwise", () => {
    open("/activity?account=savings")
    expect(host.textContent).toContain("Savings activity")
    expect(host.textContent).toContain("Savings row")
    expect(host.textContent).not.toContain("Main row")
    expect(host.textContent).not.toContain("Requests unavailable")
    // A router keeps its first location: a fresh mount for the plain path.
    act(() => root.unmount())
    root = createRoot(host)
    open("/activity")
    expect(host.textContent).toContain("Main row")
    expect(host.textContent).not.toContain("Savings row")
  })

  it("exports the Savings moves on ?account=savings, under their own file name", () => {
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download)
    })
    URL.createObjectURL = vi.fn(() => "blob:csv")
    URL.revokeObjectURL = vi.fn()
    open("/activity?account=savings")
    act(() => host.querySelector<HTMLButtonElement>(".ww-activity__export")!.click())
    expect(savingsCsv).toHaveBeenCalledWith({ moves: [], burns: expect.any(Map) })
    expect(activityCsv).not.toHaveBeenCalled()
    expect(downloads).toEqual([
      expect.stringMatching(/^zkmoney-savings-activity-\d{4}-\d{2}-\d{2}\.csv$/),
    ])
  })

  it("lists the outside-contacts inbox and See all contacts under Pending only", () => {
    open("/activity")
    expect(host.textContent).not.toContain("See all contacts")
    const pending = [...host.querySelectorAll("button")].find((b) => b.textContent === "Pending")!
    act(() => pending.click())
    expect(host.textContent).toContain("Requests from people not in your contacts")
    expect(host.textContent).toContain("See all contacts")
  })
})
