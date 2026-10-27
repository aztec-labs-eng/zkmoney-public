import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startTabBoundOperation } from "./support/operations"
import { BakedProfileNotice, CustomProfileNotice } from "../src/ui/ConfigNotice"
import { AppShell } from "../src/ui/AppShell"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe("BakedProfileNotice", () => {
  it("says what the wallet is running on and offers a reload", async () => {
    const reload = vi.fn()
    await act(async () => {
      root.render(<BakedProfileNotice publishedAt="2026-08-12T00:00:00.000Z" reload={reload} />)
    })

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain("configuration service could not be reached")
    expect(status?.textContent).toContain("2026")
    expect(status?.textContent).toContain("may be outdated")
    await act(async () => container.querySelector("button")!.click())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("cannot reload over a running proof", async () => {
    const reload = vi.fn()
    const end = await startTabBoundOperation()
    await act(async () => {
      root.render(<BakedProfileNotice publishedAt="2026-08-12T00:00:00.000Z" reload={reload} />)
    })
    const button = container.querySelector("button")!
    expect(button.disabled).toBe(true)
    await act(async () => end())
    expect(button.disabled).toBe(false)
  })

  it("can be dismissed so a sheet underneath stays reachable", async () => {
    await act(async () => {
      root.render(<BakedProfileNotice publishedAt="2026-08-12T00:00:00.000Z" reload={() => {}} />)
    })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click(),
    )
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})

describe("CustomProfileNotice", () => {
  it("names the address the configuration came from and links to settings", async () => {
    await act(async () => {
      root.render(
        <CustomProfileNotice
          url="https://elsewhere.example/p.json"
          settingsPath="/desktop-settings"
        />,
      )
    })

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain("https://elsewhere.example/p.json")
    expect(status?.textContent).toContain("instead of zk.money's own")
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/desktop-settings")
  })

  it("can be dismissed, and offers no link off the desktop", async () => {
    await act(async () => {
      root.render(<CustomProfileNotice url="https://elsewhere.example/p.json" />)
    })
    expect(container.querySelector("a")).toBeNull()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click(),
    )
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})

describe("AppShell", () => {
  const render = (notice?: React.ReactNode) =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/page"]}>
          <Routes>
            <Route element={<AppShell notice={notice} />}>
              <Route path="page" element={<p>the page</p>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )
    })

  it("renders the notice inside the design-system root, above the routed page", async () => {
    await render(<div data-testid="notice">snapshot</div>)
    const shell = container.querySelector(".zkm-root")!
    expect(shell.querySelector('[data-testid="notice"]')).not.toBeNull()
    expect(shell.textContent).toBe("snapshotthe page")
  })

  it("renders exactly as before when there is no notice", async () => {
    await render()
    expect(container.querySelector(".zkm-root")!.textContent).toBe("the page")
  })
})
