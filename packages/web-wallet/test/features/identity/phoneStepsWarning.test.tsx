import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type LaptopCreation, SIGN_UP_SHEET_COPY } from "@obsidion/passkey-web"
import { PhoneSteps } from "../../../src/features/identity/PhoneSteps"
import { OnboardingSpinnerBody } from "../../../src/features/onboarding/OnboardingCard"

/** The warning sits above whatever is running: the drawn-tag sheet's button, or the spinner. */
describe("the extension warning in the busy presentations", () => {
  let container: HTMLDivElement
  let root: Root
  const alert = () =>
    container.querySelector<HTMLElement>('[data-testid="phone-steps-extension-warning"]')
  const order = (after: string) =>
    alert()!.compareDocumentPosition(container.querySelector(after)!) &
    Node.DOCUMENT_POSITION_FOLLOWING

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("the running sheet shows it above its button, and only while busy", async () => {
    await act(async () =>
      root.render(
        <PhoneSteps
          reach="unknown"
          busy="Creating your passkey…"
          warning={SIGN_UP_SHEET_COPY.extensionWarning}
          tag="brisk-otter"
          onChoose={() => {}}
        />,
      ),
    )
    expect(alert()?.textContent).toBe(SIGN_UP_SHEET_COPY.extensionWarning)
    expect(alert()?.getAttribute("role")).toBe("alert")
    expect(order('[data-testid="phone-steps-loading"]')).toBeTruthy()
    await act(async () =>
      root.render(
        <PhoneSteps
          reach="unknown"
          loading
          warning={SIGN_UP_SHEET_COPY.extensionWarning}
          onChoose={() => {}}
        />,
      ),
    )
    expect(alert()).toBeNull()
  })

  it("the spinner body shows it above the spinner", async () => {
    await act(async () =>
      root.render(
        <OnboardingSpinnerBody
          label="Creating your passkey…"
          warning={SIGN_UP_SHEET_COPY.extensionWarning}
        />,
      ),
    )
    expect(alert()?.textContent).toBe(SIGN_UP_SHEET_COPY.extensionWarning)
    expect(order(".ww-invite-spinner__label")).toBeTruthy()
    await act(async () => root.render(<OnboardingSpinnerBody label="Creating your passkey…" />))
    expect(alert()).toBeNull()
  })
})

describe("the Windows Hello lines on Chrome on Windows", () => {
  const WINDOWS_CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
  const WINDOWS: LaptopCreation = {
    local: true,
    os: "windows",
    row: "windowsChrome",
    managers: ["gpm", "1password"],
    withdrawn: [],
  }
  let container: HTMLDivElement
  let root: Root
  let ua: { mockRestore: () => void }
  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const advice = () => byTestId("phone-steps-advice")!
  const show = (creation: LaptopCreation) =>
    act(async () =>
      root.render(<PhoneSteps reach="unknown" creation={creation} onChoose={() => {}} />),
    )

  beforeEach(() => {
    ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WINDOWS_CHROME_UA)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    ua.mockRestore()
  })

  it("warns under This computer, outside the live region, where the row admits Windows Hello", async () => {
    await show({ ...WINDOWS, managers: ["gpm", "windows_hello", "1password"] })
    const warning = byTestId("phone-steps-hello-warning")!
    expect(advice().contains(warning)).toBe(false)
    expect(warning.textContent).toContain(SIGN_UP_SHEET_COPY.computer.helloWarning.note)
    await act(async () => byTestId("phone-steps-choice")!.click())
    await act(async () => byTestId("phone-steps-option-phone-or-key")!.click())
    expect(byTestId("phone-steps-hello-warning")).toBeNull()
  })

  it("says on Windows 10, before the prompt, that Windows Hello can't hold the passkey", async () => {
    await show({ ...WINDOWS, windows10: true })
    expect(advice().textContent).toContain(SIGN_UP_SHEET_COPY.computer.windows10)
    expect(byTestId("phone-steps-hello-warning")).toBeNull()
  })
})
