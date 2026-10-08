import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  ),
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
  }: {
    title: string
    isDisabled?: boolean
    onClick: () => void
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  TextField: ({
    label,
    value,
    onChange,
    error,
  }: {
    label: string
    value?: string
    onChange: (v: string) => void
    error?: string
  }) => (
    <>
      <input aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
      {error && <span role="alert">{error}</span>}
    </>
  ),
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
}))

const requestFromContact = vi.fn(async () => {})
vi.mock("../src/features/contacts/contactPay", () => ({
  requestFromContact: (...args: unknown[]) => requestFromContact(...(args as [])),
}))
vi.mock("@obsidion/front-core", async () => ({
  ...(await import("../../front-core/src/utils/validate")),
  ...(await import("../../front-core/src/utils/amountInput")),
  useAssetContext: () => ({ tokenService: {} }),
}))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "me" }),
}))
vi.mock("../src/platform/xmtp/MessagingBanner", () => ({ MessagingBanner: () => null }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "x" }))

const { RequestContactModal } = await import("../src/features/receive/RequestContactModal")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("RequestContactModal", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    requestFromContact.mockClear()
  })

  const button = (title: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === title)

  function setNativeValue(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }

  async function render(onRequested = () => {}, onClose = () => {}) {
    await act(async () => {
      root.render(
        <RequestContactModal tag="cyphergirl" onClose={onClose} onRequested={onRequested} />,
      )
    })
  }

  async function fill(label: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    await act(async () => setNativeValue(input, value))
  }

  it("gates Request funds on a positive amount, accepting a leading $", async () => {
    await render()
    expect(container.textContent).toContain("@cyphergirl.zk.money")
    expect(button("Request funds")?.disabled).toBe(true)

    await fill("Amount", "$45")
    expect(button("Request funds")?.disabled).toBe(false)
  })

  it.each([
    ["1.234", "Use up to 2 decimal places"],
    ["$1.234", "Use up to 2 decimal places"],
    ["9007199254740993", "Amount is too large"],
    ["1e3", "Enter a number"],
    ["0", "Enter an amount above $0."],
  ])("names the mistake in %s", async (input, message) => {
    await render()
    await fill("Amount", input)
    expect(container.querySelector("[role=alert]")?.textContent).toBe(message)
    expect(button("Request funds")?.disabled).toBe(true)
  })

  it.each(["1,000", "1,234", "1,23e3", "١٫٢٣٤", "9007199254740993"])(
    "blocks unsafe pasted amount %s",
    async (input) => {
      await render()
      await fill("Amount", input)
      expect(button("Request funds")?.disabled).toBe(true)
      expect(requestFromContact).not.toHaveBeenCalled()
    },
  )

  it.each(["12,34", "١٢٫٣٤", "۱۲٫۳۴", "१२.३४", "１２．３４"])(
    "submits the exact canonical amount for %s",
    async (input) => {
      await render()
      await fill("Amount", input)
      await act(async () => button("Request funds")?.click())
      expect(container.textContent).toContain("$12.34")
      await act(async () => button("Confirm request")?.click())
      expect(requestFromContact).toHaveBeenCalledWith(
        { tokenService: {} },
        expect.objectContaining({ amountDisplay: "12.34" }),
      )
    },
  )

  it("reviews then delivers the request with the trimmed note", async () => {
    const onRequested = vi.fn()
    await render(onRequested)
    await fill("Amount", "45")
    await fill("Add note (optional)", " Pizza dinner ")
    await act(async () => button("Request funds")?.click())

    expect(container.textContent).toContain("Receive")
    expect(container.textContent).toContain("$45.00")
    expect(container.textContent).toContain("Pizza dinner")

    await act(async () => button("Confirm request")?.click())
    expect(requestFromContact).toHaveBeenCalledWith(
      { tokenService: {} },
      { tag: "cyphergirl", requesterTag: "me", amountDisplay: "45", note: "Pizza dinner" },
    )
    expect(onRequested).toHaveBeenCalledOnce()
  })

  it("omits the note row and sends note undefined when left empty", async () => {
    await render()
    await fill("Amount", "10")
    await act(async () => button("Request funds")?.click())
    expect(container.textContent).not.toContain("Note")

    await act(async () => button("Confirm request")?.click())
    expect(requestFromContact).toHaveBeenCalledWith(
      { tokenService: {} },
      expect.objectContaining({ note: undefined }),
    )
  })

  it("cannot be dismissed while the request is in flight", async () => {
    let finish!: () => void
    requestFromContact.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    )
    const onClose = vi.fn()
    await render(undefined, onClose)
    await fill("Amount", "10")
    await act(async () => button("Request funds")?.click())
    expect(container.querySelector("[aria-label='Close']")).not.toBeNull()

    await act(async () => button("Confirm request")?.click())
    expect(container.querySelector("[aria-label='Close']")).toBeNull()
    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => finish())
    expect(container.querySelector("[aria-label='Close']")).not.toBeNull()
  })

  it("stays open and skips onRequested when delivery fails", async () => {
    requestFromContact.mockRejectedValueOnce(new Error("xmtp down"))
    const onRequested = vi.fn()
    await render(onRequested)
    await fill("Amount", "10")
    await act(async () => button("Request funds")?.click())
    await act(async () => button("Confirm request")?.click())

    expect(onRequested).not.toHaveBeenCalled()
    expect(button("Confirm request")).toBeDefined()
  })
})
