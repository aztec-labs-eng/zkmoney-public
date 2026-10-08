import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AboutLimitsFacts } from "../src/features/limits/aboutLimitsView"

vi.mock("@obsidion/web-ds", () => ({
  Icon: ({ name }: { name: string }) => <svg data-icon={name} />,
}))

const { AboutLimitsContent } = await import("../src/features/limits/AboutLimitsContent")

const E18 = 10n ** 18n
const format = { time: (ms: number) => `time:${ms}` }
const observation = {
  available: 500n * E18,
  ceiling: 50_000n * E18,
  ratePerSecond: 578_703_703_703_703_703n,
  decimals: 18,
  tokenSymbol: "DAI",
  observedAt: 1_000,
}
const facts = (overrides: Partial<AboutLimitsFacts> = {}): AboutLimitsFacts => ({
  product: {
    deposit: { maximumUsd: "2500", basis: "sent-including-fees" },
    withdrawal: { maximumUsd: "2500", basis: "debited-including-fees" },
    valuation: { tokens: ["DAI", "USDC", "USDT"] },
  },
  capacity: { state: "fresh", observation },
  sponsorship: { state: "renewal-unknown", maxTx: 100, refillPeriodSeconds: 86_400 },
  ...overrides,
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = (props: React.ComponentProps<typeof AboutLimitsContent>) =>
  act(async () => root.render(<AboutLimitsContent format={format} {...props} />))

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe("AboutLimitsContent", () => {
  it("renders the three controls as named regions with machine-readable states", async () => {
    await render({ facts: facts() })
    const regions = [...container.querySelectorAll("section")].map((section) => ({
      name: document.getElementById(section.getAttribute("aria-labelledby")!)?.textContent,
      testId: section.dataset.testid,
      state: section.dataset.state,
    }))
    expect(regions).toEqual([
      { name: "Maximum per transaction", testId: "about-limits-operation", state: "known" },
      { name: "Shared deposit capacity", testId: "about-limits-capacity", state: "fresh" },
      {
        name: "Sponsored transactions",
        testId: "about-limits-sponsorship",
        state: "renewal-unknown",
      },
    ])
    expect(byTestId("about-limits-sponsorship-state")?.textContent).toBe("Renewal status unknown")
  })

  it("announces the capacity state without announcing the check time", async () => {
    await render({ facts: facts() })
    const status = byTestId("about-limits-capacity-state")!
    expect(status.getAttribute("role")).toBe("status")
    expect(status.textContent).toBe("Capacity up to date")
    expect(byTestId("about-limits-capacity")?.textContent).toContain("time:1000")

    const later = { ...observation, observedAt: 61_000 }
    await render({ facts: facts({ capacity: { state: "fresh", observation: later } }) })
    expect(byTestId("about-limits-capacity-state")).toBe(status)
    expect(status.textContent).toBe("Capacity up to date")
    expect(byTestId("about-limits-capacity")?.textContent).toContain("time:61000")

    await render({ facts: facts({ capacity: { state: "stale", observation } }) })
    expect(status.textContent).toBe("Capacity out of date")
  })

  it("pairs every state label with an icon hidden from assistive technology", async () => {
    await render({
      facts: facts({ capacity: { state: "unavailable" }, sponsorship: { state: "spent" } }),
    })
    for (const id of ["about-limits-capacity-state", "about-limits-sponsorship-state"]) {
      const status = byTestId(id)!
      expect(status.textContent?.trim()).not.toBe("")
      expect(status.querySelector('[aria-hidden="true"] svg[data-icon]')).not.toBeNull()
    }
    expect(byTestId("about-limits-capacity-state")?.textContent).toBe(
      "Capacity could not be checked.",
    )
  })

  it("offers Check again for a failed read and calls the supplied retry", async () => {
    const retry = vi.fn()
    await render({ facts: facts({ capacity: { state: "unavailable" } }), onRetryCapacity: retry })
    const button = byTestId("about-limits-capacity-retry") as HTMLButtonElement
    expect(button.tagName).toBe("BUTTON")
    expect(button.type).toBe("button")
    expect(button.textContent).toBe("Check again")
    expect(byTestId("about-limits-capacity")?.contains(button)).toBe(true)
    await act(async () => button.click())
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it("hides Check again for a current read or when no retry is supplied", async () => {
    await render({ facts: facts(), onRetryCapacity: vi.fn() })
    expect(byTestId("about-limits-capacity-retry")).toBeNull()
    await render({ facts: facts({ capacity: { state: "stale", observation } }) })
    expect(byTestId("about-limits-capacity-retry")).toBeNull()
  })

  it("keeps keyboard focus in the section when a retry succeeds", async () => {
    await render({
      facts: facts({ capacity: { state: "stale", observation } }),
      onRetryCapacity: vi.fn(),
    })
    const button = byTestId("about-limits-capacity-retry")!
    button.focus()
    await act(async () => button.click())
    await render({ facts: facts(), onRetryCapacity: vi.fn() })
    expect(byTestId("about-limits-capacity-retry")).toBeNull()
    expect(document.activeElement).toBe(byTestId("about-limits-capacity-state"))
    expect(byTestId("about-limits-capacity-state")?.tabIndex).toBe(-1)
  })

  it("does not take focus back after the user moved it elsewhere", async () => {
    const elsewhere = document.createElement("button")
    document.body.appendChild(elsewhere)
    await render({ facts: facts({ capacity: { state: "unavailable" } }), onRetryCapacity: vi.fn() })
    const button = byTestId("about-limits-capacity-retry")!
    button.focus()
    await act(async () => button.click())
    elsewhere.focus()
    await render({ facts: facts(), onRetryCapacity: vi.fn() })
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  it("shows no capacity amount when the read failed", async () => {
    await render({ facts: facts({ capacity: { state: "unavailable", observation } }) })
    const capacity = byTestId("about-limits-capacity")!
    expect(capacity.querySelector("dl")).toBeNull()
    expect(capacity.textContent).not.toMatch(/\d DAI/)
  })

  it("presents rows as a description list", async () => {
    await render({ facts: facts() })
    const rows = [...byTestId("about-limits-operation")!.querySelectorAll("dl > div")].map(
      (row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent],
    )
    expect(rows).toEqual([
      ["Per deposit", "$2,500 sent, incl. fees"],
      ["Per withdrawal", "$2,500 from balance, incl. fees"],
    ])
  })

  it("shows only the capacity explanation when no source is connected", async () => {
    await render({ facts: facts({ capacity: undefined }), onRetryCapacity: vi.fn() })
    const capacity = byTestId("about-limits-capacity")!
    expect(capacity.dataset.state).toBe("general")
    expect(byTestId("about-limits-capacity-state")).toBeNull()
    expect(byTestId("about-limits-capacity-retry")).toBeNull()
    expect(capacity.textContent).toContain("It does not reset at midnight.")
  })

  it("offers Check again for a failed allowance read and keeps focus when it succeeds", async () => {
    const retry = vi.fn()
    await render({
      facts: facts({ sponsorship: { state: "unavailable" } }),
      onRetrySponsorship: retry,
    })
    const button = byTestId("about-limits-sponsorship-retry")!
    button.focus()
    await act(async () => button.click())
    expect(retry).toHaveBeenCalledTimes(1)
    await render({
      facts: facts({ sponsorship: { state: "available", uses: 4, renews: true } }),
      onRetrySponsorship: retry,
    })
    expect(byTestId("about-limits-sponsorship-retry")).toBeNull()
    expect(document.activeElement).toBe(byTestId("about-limits-sponsorship-state"))
  })
})

describe("AboutLimitsContent topics", () => {
  const toggle = (id: string) => byTestId(`${id}-toggle`)!
  const body = (id: string) =>
    document.getElementById(toggle(id).getAttribute("aria-controls")!) as HTMLElement

  it("expands every section when no topic is given", async () => {
    await render({ facts: facts() })
    for (const id of [
      "about-limits-operation",
      "about-limits-capacity",
      "about-limits-sponsorship",
    ]) {
      expect(toggle(id).getAttribute("aria-expanded")).toBe("true")
      expect(body(id).hidden).toBe(false)
    }
  })

  it("puts the requested topic first and expanded, and the others collapsed", async () => {
    await render({ facts: facts(), topic: "sponsorship" })
    const order = [...container.querySelectorAll("section")].map(
      (section) => section.dataset.testid,
    )
    expect(order).toEqual([
      "about-limits-sponsorship",
      "about-limits-operation",
      "about-limits-capacity",
    ])
    expect(toggle("about-limits-sponsorship").getAttribute("aria-expanded")).toBe("true")
    expect(body("about-limits-sponsorship").hidden).toBe(false)
    for (const id of ["about-limits-operation", "about-limits-capacity"]) {
      expect(toggle(id).getAttribute("aria-expanded")).toBe("false")
      expect(body(id).hidden).toBe(true)
    }
  })

  it("keeps a collapsed section's state and retry visible, and opens it on activation", async () => {
    const retry = vi.fn()
    await render({
      facts: facts({ capacity: { state: "unavailable" } }),
      topic: "limit",
      onRetryCapacity: retry,
    })
    expect(body("about-limits-capacity").hidden).toBe(true)
    expect(byTestId("about-limits-capacity-state")?.textContent).toContain(
      "Capacity could not be checked.",
    )
    await act(async () => byTestId("about-limits-capacity-retry")!.click())
    expect(retry).toHaveBeenCalledTimes(1)

    await act(async () => toggle("about-limits-capacity").click())
    expect(toggle("about-limits-capacity").getAttribute("aria-expanded")).toBe("true")
    expect(body("about-limits-capacity").hidden).toBe(false)
    await act(async () => toggle("about-limits-capacity").click())
    expect(body("about-limits-capacity").hidden).toBe(true)
  })

  it("shows the calling surface's lines in their own section only", async () => {
    await render({
      facts: facts(),
      topic: "capacity",
      details: {
        capacity: <p data-testid="own-capacity-line">Recheck before each transfer.</p>,
        limit: <p data-testid="own-limit-line">At most 2,500 DAI here.</p>,
      },
    })
    expect(body("about-limits-capacity").contains(byTestId("own-capacity-line"))).toBe(true)
    expect(body("about-limits-operation").contains(byTestId("own-limit-line"))).toBe(true)
    // A section's own lines come before its general rows and notes.
    expect(body("about-limits-capacity").firstElementChild).toBe(byTestId("own-capacity-line"))
  })
})
