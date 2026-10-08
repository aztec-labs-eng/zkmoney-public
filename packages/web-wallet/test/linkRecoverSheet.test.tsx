/**
 * The creator-recovery confirm sheet: it names the recovery, says what to expect of the race, runs
 * the matching submit leg, and maps a lost race to the shared already-spent copy instead of a
 * reportable stack.
 */
import React, { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { PAYLINK_ALREADY_SPENT_MESSAGE } from "@obsidion/front-core"
import { asOperation, endSigningAndHandOff } from "./support/handOff"

const h = vi.hoisted(() => ({
  recoverSponsoredLink: vi.fn(),
  showErrorModal: vi.fn(),
  showReportableError: vi.fn(),
  fireEvent: vi.fn(),
}))

vi.mock("../src/features/paylink/sponsoredPaylink", () => ({
  recoverSponsoredLink: (...args: unknown[]) =>
    asOperation(h.recoverSponsoredLink, "paylink-reclaim")(...args),
}))
vi.mock("../src/errors/errorModal", () => ({
  showErrorModal: h.showErrorModal,
  showReportableError: h.showReportableError,
}))
vi.mock("../src/lib/analytics", () => ({ fireEvent: h.fireEvent, failureCode: () => "unknown" }))
// The DS drags in liquid-glass optics jsdom can't render; this test is about the sheet's content.
vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}
      <span>{value}</span>
    </div>
  ),
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
  }: {
    title: string
    isDisabled?: boolean
    onClick?: () => void
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  GradientSpinner: () => null,
  TopNavIconButton: () => null,
  Icon: () => null,
}))

const { LinkRecoverModal } = await import("../src/features/paylink/LinkRecoverModal")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const DEPS = {} as never
const CREATED_MS = Date.UTC(2026, 4, 1, 12, 0)

describe("LinkRecoverModal", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)

  const onClose = vi.fn()
  const render = (action: "reclaim" | "cancel", deps: unknown = DEPS) =>
    // `deps` is passed through as-is; pass null (not undefined) for the still-loading case, or the
    // default parameter takes over.
    act(async () => {
      root.render(
        <LinkRecoverModal
          action={action}
          deps={deps as never}
          fragment="frag"
          amount="30 DAI"
          createdMs={CREATED_MS}
          untilClaimableSec={Math.floor(CREATED_MS / 1000) + 86_400}
          onClose={onClose}
        />,
      )
    })

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    h.recoverSponsoredLink.mockResolvedValue(undefined)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("tells a reclaimer the window closed and what a last-moment claim means", async () => {
    await render("reclaim")
    expect(container.textContent).toContain("claim window on this link has closed")
    expect(container.textContent).toContain("come back to your balance")
    expect(container.textContent).toContain("fails harmlessly")
    expect(container.textContent).toContain("30 DAI")
    expect(button("Reclaim funds")).toBeTruthy()
  })

  it("tells a canceller nobody has claimed the link yet", async () => {
    await render("cancel")
    expect(container.textContent).toContain("Nobody has claimed this link yet")
    expect(container.textContent).toContain("come back to your balance")
    expect(button("Cancel link")).toBeTruthy()
  })

  it("waits out a new link's create without reading as this link", async () => {
    let finish!: () => void
    const creating = asOperation(
      () => new Promise<void>((resolve) => (finish = resolve)),
      "paylink-create",
    )()
    await render("cancel")
    const waiting = button("Waiting for your new paylink to be created")
    expect(waiting?.disabled).toBe(true)
    await act(async () => {
      finish()
      await creating
    })
    expect(button("Cancel link")?.disabled).toBe(false)
  })

  it("runs the refund leg for a reclaim and closes once it lands", async () => {
    await render("reclaim")
    await act(async () => button("Reclaim funds")!.click())
    expect(h.recoverSponsoredLink).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("hands the recovery to the bell at the passkey", async () => {
    let settle!: (hash: string) => void
    h.recoverSponsoredLink.mockImplementation(() => new Promise((resolve) => (settle = resolve)))
    await act(async () => {
      root.render(
        <LinkRecoverModal
          action="reclaim"
          deps={DEPS}
          fragment="frag"
          amount="30 DAI"
          createdMs={CREATED_MS}
          onClose={onClose}
        />,
      )
    })
    await act(async () => button("Reclaim funds")!.click())
    expect(container.textContent).toContain("Keep this tab open")
    await endSigningAndHandOff()
    expect(onClose).toHaveBeenCalledOnce()

    await act(async () => settle("0xrefund"))
  })

  it("runs the cancel leg for a cancel", async () => {
    await render("cancel")
    await act(async () => button("Cancel link")!.click())
    expect(h.recoverSponsoredLink).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("maps a lost race to the shared already-spent copy, not a stack", async () => {
    h.recoverSponsoredLink.mockRejectedValue(new Error("Existing nullifier 0x1234"))
    await render("cancel")
    await act(async () => button("Cancel link")!.click())
    expect(h.showErrorModal).toHaveBeenCalledWith(
      expect.objectContaining({ message: PAYLINK_ALREADY_SPENT_MESSAGE }),
    )
    expect(h.showReportableError).not.toHaveBeenCalled()
    // Back on the form, so the user can re-check the link's status.
    expect(button("Cancel link")).toBeTruthy()
  })

  it("keeps every other failure reportable", async () => {
    h.recoverSponsoredLink.mockRejectedValue(new Error("network unreachable"))
    await render("reclaim")
    await act(async () => button("Reclaim funds")!.click())
    expect(h.showReportableError).toHaveBeenCalledOnce()
    expect(h.showErrorModal).not.toHaveBeenCalled()
    expect(h.fireEvent).toHaveBeenCalledWith(
      "action_failed",
      expect.objectContaining({ action: "paylink:reclaim" }),
    )
  })

  it("refuses to submit before the wallet finishes loading", async () => {
    await render("cancel", null)
    await act(async () => button("Cancel link")!.click())
    expect(h.recoverSponsoredLink).not.toHaveBeenCalled()
    expect(h.showReportableError).toHaveBeenCalledOnce()
  })
})
