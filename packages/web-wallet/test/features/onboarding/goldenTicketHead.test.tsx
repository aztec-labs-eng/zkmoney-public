/** Guards: the ticket intro hands the signup form back, and is saved as seen only after. */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GoldenTicketIntro } from "../../../src/features/onboarding/steps/GoldenTicketHead"
import { testCore } from "../../support/page"
import { openTestSession } from "../../support/session"

const ONE = 10n ** 18n

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

/** A phone-width screen whose `(min-width: 960px)` query can be made to match later. */
function stubPhoneScreen() {
  let narrow = true
  const listeners = new Map<string, () => void>()
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      if (query.includes("max-width")) return narrow
      if (query.includes("min-width")) return !narrow
      return false
    },
    addEventListener: (_: string, fn: () => void) => listeners.set(query, fn),
    removeEventListener: () => listeners.delete(query),
  }))
  return {
    widen: () => {
      narrow = false
      listeners.get("(min-width: 960px)")?.()
    },
  }
}

async function renderIntro(onGone: () => void) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <GoldenTicketIntro amount={25n * ONE} tokenDecimals={18} tokenSymbol="DAI" onGone={onGone} />,
    ),
  )
  return { container, unmount: () => act(async () => root.unmount()) }
}

describe("GoldenTicketIntro", () => {
  beforeEach(() => void openTestSession())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("hands the form back when the screen widens past the art breakpoint", async () => {
    const screen = stubPhoneScreen()
    const onGone = vi.fn()
    const { container, unmount } = await renderIntro(onGone)
    expect(container.querySelector(".ww-ticket-intro")).not.toBeNull()
    await act(async () => screen.widen())
    expect(onGone).toHaveBeenCalledTimes(1)
    expect(container.querySelector(".ww-ticket-intro")).toBeNull()
    await unmount()
  })

  it("is seen once it hands the form back, not while it covers it", async () => {
    const screen = stubPhoneScreen()
    const { unmount } = await renderIntro(() => {})
    await testCore().database.write(async () => {})
    expect(testCore().device.get().ticketIntroSeen).toBe(false)
    await act(async () => screen.widen())
    await testCore().database.write(async () => {})
    expect(testCore().device.get().ticketIntroSeen).toBe(true)
    await unmount()
  })

  it("hands the form back once the leaving animation's time is up, even when none ran", async () => {
    vi.useFakeTimers()
    stubPhoneScreen()
    const onGone = vi.fn()
    const { container, unmount } = await renderIntro(onGone)
    await act(async () => container.querySelector("button")!.click())
    expect(onGone).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(800))
    expect(onGone).toHaveBeenCalledTimes(1)
    await unmount()
  })
})
