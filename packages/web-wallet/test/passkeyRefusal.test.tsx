/** One refusal row per policy error, and the two that offer no retry. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    testId,
    onClick,
  }: {
    title: string
    testId?: string
    onClick?: () => void
  }) => (
    <button data-testid={testId} onClick={onClick}>
      {title}
    </button>
  ),
}))

const { PasskeyRefusal, refusalFor } = await import("../src/features/identity/PasskeyRefusal")
const errors = await import("@obsidion/passkey-web")

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
})

const POLICY_ERRORS = [
  errors.PhoneRequiredError,
  errors.LocalPasskeyRequiredError,
  errors.DeviceBoundPasskeyError,
  errors.NoPrfError,
  errors.SingleSaltProviderError,
  errors.NoWalletForPasskeyError,
  errors.PhoneUnreachableError,
  errors.RotatedCredentialError,
  errors.AmbiguousPasskeyError,
]

describe("refusalFor", () => {
  it("names every policy error with its own title", () => {
    const titles = new Set<string>()
    for (const Ctor of POLICY_ERRORS) {
      const row = refusalFor(new Ctor())
      expect(row.title).not.toBe(refusalFor({ name: "SomethingElse" }).title)
      titles.add(row.title)
    }
    expect(refusalFor(new errors.UnsupportedProviderError("manager")).title).toContain(
      "isn't supported",
    )
    // Raised by onboarding, not the auth service, so keyed by name like every other row.
    expect(refusalFor({ name: "PasskeyMismatchError" })).toEqual({
      title: "This passkey opens a different account",
      retry: true,
    })
    expect(titles.size).toBeGreaterThan(5)
  })

  it("offers no retry where another attempt cannot help", () => {
    expect(refusalFor(new errors.RotatedCredentialError()).retry).toBe(false)
    expect(refusalFor(new errors.AmbiguousPasskeyError()).retry).toBe(false)
    expect(refusalFor(new errors.PhoneRequiredError()).retry).toBe(true)
    expect(refusalFor({ name: "error" }).retry).toBe(true)
  })
})

describe("PasskeyRefusal", () => {
  it("renders the title, the error's own message, the reason and a retry", async () => {
    const onRetry = vi.fn()
    const error = new errors.PhoneRequiredError()
    await act(async () =>
      root.render(<PasskeyRefusal error={error} onRetry={onRetry} exits={<i>exit</i>} />),
    )
    const pane = container.querySelector<HTMLElement>('[data-testid="passkey-refused"]')!
    expect(pane.dataset.reason).toBe("PhoneRequiredError")
    expect(container.textContent).toContain("Use your phone")
    expect(container.textContent).toContain(error.message)
    expect(container.textContent).toContain("exit")
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="passkey-retry"]')!.click(),
    )
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("hides the retry for a rotated credential", async () => {
    await act(async () =>
      root.render(
        <PasskeyRefusal error={new errors.RotatedCredentialError()} onRetry={() => {}} />,
      ),
    )
    expect(container.querySelector('[data-testid="passkey-retry"]')).toBeNull()
    expect(container.textContent).toContain("key changed")
  })
})
