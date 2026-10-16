/** The card shown in an app's built-in browser before any passkey request. */
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
}))

const { InAppBrowserNotice } = await import("../src/features/identity/InAppBrowserNotice")
const { subscribeErrorModal } = await import("../src/errors/errorModal")
const { stashClaimLink } = await import("../src/features/paylink/claimStash")

const UA = {
  android:
    "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
  // A phone's Chrome far behind stable, with no marker: the card's mode decides what it is.
  androidChromeStale:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  androidXStale:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 TwitterAndroid",
  iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
  iosInstagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 370.0.0.0.0 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 000000000)",
}
const startUrl = window.location.href

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  window.history.replaceState(null, "", startUrl)
  sessionStorage.clear()
})

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)
const escape = () => byTestId("open-in-browser")
const link = () => byTestId("open-in-browser-link")

function as(userAgent: string, address: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
  window.history.replaceState(null, "", address)
}

async function show(ui: ReactNode) {
  await act(async () =>
    root.render(<MemoryRouter initialEntries={[{ pathname: "/" }]}>{ui}</MemoryRouter>),
  )
}

describe("InAppBrowserNotice", () => {
  it("on iPhone: the title, the line, a Safari link, the exits, a report", async () => {
    as(UA.iosInstagram, "/enter?handle=alice")
    await show(<InAppBrowserNotice exits={<i>exit</i>} mode="leave" reportContext="enter" />)
    expect(byTestId("in-app-notice")).not.toBeNull()
    expect(container.textContent).toContain("Passkeys don't work in this app's browser")
    expect(container.textContent).toContain(
      "zk.money uses a passkey to create and open your account.",
    )
    expect(link()!.getAttribute("href")).toBe(
      `x-safari-http://${window.location.host}/enter?handle=alice`,
    )
    expect(container.textContent).toContain("exit")
    expect(byTestId("passkey-report")).not.toBeNull()
  })

  it("on Android: the same title and a Chrome link, with no way to try here", async () => {
    as(UA.android, "/enter")
    await show(<InAppBrowserNotice mode="leave" reportContext="enter" />)
    expect(container.textContent).toContain("Passkeys don't work in this app's browser")
    expect(link()!.getAttribute("href")).toContain("intent://")
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Copy link",
      "Report this issue",
    ])
  })

  it("in X's app, Copy link leads and the app's menu follows", async () => {
    as(UA.iosX, "/enter")
    await show(<InAppBrowserNotice mode="leave" reportContext="enter" />)
    expect(link()).toBeNull()
    expect(buttonNamed("Copy link")!.className).toContain("zkm-primary-btn--gradient")
    expect(escape()!.textContent).toContain("Or tap ⋮ next to the web address at the bottom")
  })

  it("with a payment in the fragment, gives the menu hint instead of a link", async () => {
    as(UA.iosInstagram, "/link#secret-frag")
    await show(<InAppBrowserNotice mode="leave" reportContext="onboarding" />)
    expect(escape()!.dataset.escape).toBe("hint")
    expect(link()).toBeNull()
    expect(container.innerHTML).not.toContain("secret")
  })

  it("with a flow that lives in this browser's storage, says to open the link again", async () => {
    as(UA.iosInstagram, "/enter")
    stashClaimLink("frag-1")
    await show(<InAppBrowserNotice mode="leave" reportContext="enter" />)
    expect(escape()!.dataset.escape).toBe("reopen")
    expect(link()).toBeNull()
    expect(container.textContent).toContain("Open the link you were sent again")
  })

  const PLAY = "https://play.google.com/store/apps/details?id=com.android.chrome"
  const maybeLink = () => byTestId("update-chrome-maybe")

  it("with a flow in the router's memory, says to open the link again too", async () => {
    as(UA.androidChromeStale, "/enter")
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[{ pathname: "/enter", state: { from: "paylink" } }]}>
          <InAppBrowserNotice mode="leave" reportContext="enter" />
        </MemoryRouter>,
      ),
    )
    expect(escape()!.dataset.escape).toBe("reopen")
    expect(link()).toBeNull()
    expect(container.textContent).toContain("Open the link you were sent again")
    expect(buttonNamed("Copy link")).toBeUndefined()
  })

  it("when the brands say nothing: the in-app card, plus the update line with a store link", async () => {
    as(UA.androidChromeStale, "/enter")
    await show(<InAppBrowserNotice mode="leave-or-update" reportContext="enter" />)
    expect(container.textContent).toContain("Passkeys don't work in this app's browser")
    expect(link()!.getAttribute("href")).toContain("intent://")
    expect(container.textContent).toContain("Or tap ⋯ in this app")
    expect(maybeLink()!.getAttribute("href")).toBe(PLAY)
    expect(maybeLink()!.textContent).toBe("Play Store")
    expect(container.textContent).toContain(
      "If you're already in Chrome, update it from the Play Store and open this page again, or use another browser.",
    )
  })

  it("the update line follows X's Copy-link-first variant, the menu hint and the reopen line too", async () => {
    as(UA.androidXStale, "/enter")
    await show(<InAppBrowserNotice mode="leave-or-update" reportContext="enter" />)
    expect(link()).toBeNull()
    expect(buttonNamed("Copy link")!.className).toContain("zkm-primary-btn--gradient")
    expect(maybeLink()!.getAttribute("href")).toBe(PLAY)

    act(() => root.unmount())
    root = createRoot(container)
    as(UA.androidChromeStale, "/link#secret-frag")
    await show(<InAppBrowserNotice mode="leave-or-update" reportContext="onboarding" />)
    expect(escape()!.dataset.escape).toBe("hint")
    expect(maybeLink()!.getAttribute("href")).toBe(PLAY)
    expect(container.innerHTML).not.toContain("secret")

    act(() => root.unmount())
    root = createRoot(container)
    as(UA.androidChromeStale, "/enter")
    stashClaimLink("frag-2")
    await show(<InAppBrowserNotice mode="leave-or-update" reportContext="enter" />)
    expect(escape()!.dataset.escape).toBe("reopen")
    expect(maybeLink()!.getAttribute("href")).toBe(PLAY)
    expect(container.textContent).not.toContain(window.location.origin)
  })

  it("the report carries the user agent, the one thing that can show a wrong match", async () => {
    as(UA.iosInstagram, "/enter")
    const reports: { title: string; message: string; context?: string; showReport?: boolean }[] = []
    const unsubscribe = subscribeErrorModal((payload) => {
      reports.push(payload)
    })
    try {
      await show(<InAppBrowserNotice mode="leave" reportContext="enter" />)
      await act(async () => byTestId("passkey-report")!.click())
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        title: "In-app browser notice",
        message: UA.iosInstagram,
        context: "enter",
        showReport: true,
      })
    } finally {
      unsubscribe()
    }
  })
})
