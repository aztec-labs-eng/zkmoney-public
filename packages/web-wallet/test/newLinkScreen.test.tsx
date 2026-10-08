import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent } from "../src/lib/analytics"
import { provingProgress } from "@obsidion/proving-progress"
import { asOperation, endSigningAndHandOff } from "./support/handOff"

let location: ReturnType<typeof useLocation>
function LocationProbe() {
  location = useLocation()
  return null
}
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAssetContext: () => ({ teeSignerError: null }),
  useBalance: () => ({
    walletAsset: { balance: 100, balanceAtomic: 100n * 10n ** 18n, decimals: 18 },
    walletBalance: "100",
    assetsLoaded: true,
  }),
  parseEscrowAmount: (s: string, d: number) => ({
    atomic: BigInt(Math.round(Number(s))) * 10n ** BigInt(d),
    human: Number(s),
  }),
}))
const allowanceGate = vi.hoisted(() => ({ reason: undefined as string | undefined }))
vi.mock("../src/features/allowance/SponsoredActionNotice", () => ({
  useSponsoredActionBlock: (enabled: boolean) => (enabled ? allowanceGate.reason : undefined),
  SponsoredActionNotice: ({ reason }: { reason?: string }) =>
    reason ? <p data-testid="sponsored-action-blocked">{reason}</p> : null,
}))
vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: () => null,
  GradientSpinner: () => null,
  GradientToggle: () => null,
  Icon: () => null,
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
  TextField: ({ value, onChange }: { value?: string; onChange: (v: string) => void }) => (
    <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
  ),
}))
vi.mock("../src/features/contacts/SendScreen", () => ({ SendScreen: () => null }))
vi.mock("../src/ui/PayModalChrome", () => ({
  PayModalChrome: ({ onBack }: { onBack?: () => void }) =>
    onBack ? <button onClick={onBack}>Back</button> : null,
}))
const deps = {}
vi.mock("../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: () => deps }))
vi.mock("../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "x" }))
const showReportableError = vi.fn()
vi.mock("../src/errors/errorModal", () => ({
  showReportableError: (...a: unknown[]) => showReportableError(...a),
}))

type Stage = (s: string) => void
type Opts = { onLink?: (l: unknown) => void; voucher?: boolean; email?: string }
const link = {
  url: "https://wallet/link#frag",
  fragment: "frag",
  amount: "25",
  status: "unclaimed",
}
const createSponsoredLink = vi.fn(
  async (_deps: unknown, _amount: string, _onStage: Stage, _opts: Opts) => ({
    ...link,
    txHash: "0xcreate",
  }),
)
const voucherAvailable = vi.fn(async () => true)
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({
  voucherAvailable: () => voucherAvailable(),
  DEFAULT_CLAIM_WINDOW_DAYS: 30,
  hasPendingDeposits: () => false,
  createSponsoredLink: asOperation(
    (...a: Parameters<typeof createSponsoredLink>) => createSponsoredLink(...a),
    "paylink-create",
  ),
}))

const ticket = vi.hoisted(() => ({
  offer: null as { threshold: string; schedule: { fee: string; minDeposit: string } } | null,
}))
vi.mock("../src/features/paylink/goldenTicketOffer", () => ({
  useGoldenTicketOffer: () => ({ offer: ticket.offer, failed: false, retry: () => {} }),
}))

const { NewLinkScreen } = await import("../src/features/paylink/NewLinkScreen")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("NewLinkScreen", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    voucherAvailable.mockResolvedValue(true)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    createSponsoredLink.mockImplementation(
      async (_d: unknown, _a: string, _s: Stage, opts: Opts) => {
        opts.onLink?.(link)
        return { ...link, txHash: "0xcreate" }
      },
    )
    await mount()
  })

  afterEach(() => {
    allowanceGate.reason = undefined
    ticket.offer = null
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const mount = () =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/create"]}>
          <LocationProbe />
          <Routes>
            <Route path="/create" element={<NewLinkScreen />} />
            <Route path="/activity" element={<div>Activity</div>} />
          </Routes>
        </MemoryRouter>,
      )
    })
  /** The ticket offer is read on mount, so a test that sets one opens the screen afresh. */
  const remount = async () => {
    act(() => root.unmount())
    root = createRoot(container)
    await mount()
  }
  const button = (title: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === title)
  const setInput = (value: string) => {
    const input = container.querySelector("input")!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }

  async function reachCreate() {
    await act(async () => setInput("25"))
    await act(async () => button("Next")?.click())
    await act(async () => button("Confirm")?.click())
    expect(button("Create paylink")).toBeDefined()
  }

  describe("the tag a ticket-sized link gives", () => {
    const GRANT = "This link can be used by a new user to get their zk.money tag for free."
    const offerAt = (dollars: bigint) => {
      ticket.offer = {
        threshold: (dollars * 10n ** 18n).toString(),
        schedule: { fee: "1", minDeposit: "0" },
      }
    }
    it("says nothing where the network issues no tickets", async () => {
      await reachCreate()
      expect(container.textContent).not.toContain("zk.money tag")
    })

    it("names only the threshold before the voucher is read, whatever the amount", async () => {
      offerAt(20n)
      await remount()
      for (const amount of ["5", "20"]) {
        await act(async () => setInput(amount))
        expect(container.textContent).toContain(
          "Links of $20 or more can be used by a new user to get their zk.money tag for free.",
        )
        expect(container.textContent).not.toContain(GRANT)
      }
      expect(voucherAvailable).not.toHaveBeenCalled()
    })

    it.each([true, false])(
      "the review promises the tag only with a voucher (%s)",
      async (voucher) => {
        offerAt(20n)
        voucherAvailable.mockResolvedValue(voucher)
        await remount()
        await reachCreate()
        expect(container.textContent?.includes(GRANT)).toBe(voucher)
      },
    )
  })

  it("holds the create, with the reason beside it, when the allowance proves it cannot be paid for", async () => {
    allowanceGate.reason = "No sponsored transactions left. Next allowance eligible in about 2 h."
    await act(async () => setInput("25"))
    await act(async () => button("Next")?.click())
    expect(container.querySelector('[data-testid="sponsored-action-blocked"]')).toBeNull()
    await act(async () => button("Confirm")?.click())
    expect(button("Create paylink")?.disabled).toBe(true)
    expect(container.querySelector('[data-testid="sponsored-action-blocked"]')?.textContent).toBe(
      allowanceGate.reason,
    )
    expect(createSponsoredLink).not.toHaveBeenCalled()
  })

  it("leaves for the link's sheet when the passkey ceremony ends, with the deposit still proving", async () => {
    let resolveCreate!: (v: unknown) => void
    createSponsoredLink.mockImplementation(
      (_deps: unknown, _amount: string, onStage: Stage, opts: Opts) => {
        onStage("building")
        opts.onLink?.(link)
        onStage("proving")
        return new Promise((r) => {
          resolveCreate = r
        }) as never
      },
    )
    await reachCreate()
    await act(async () => button("Create paylink")?.click())
    expect(location.pathname).toBe("/create")

    await act(async () => provingProgress.emitSigningStart())
    expect(container.textContent).toContain("Confirm with passkey")
    await endSigningAndHandOff()
    expect(location.pathname).toBe("/activity")
    expect(location.state).toEqual({ openPaylink: link.url })
    expect(container.textContent).toBe("Activity")
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())

    await act(async () => resolveCreate({ ...link, txHash: "0xcreate" }))
    expect(location.pathname).toBe("/activity")
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })

  it("leaves a failure past the hand-off to the create's row", async () => {
    let rejectCreate!: (e: Error) => void
    createSponsoredLink.mockImplementation((_deps, _amount, _onStage, opts) => {
      opts.onLink?.(link)
      return new Promise((_, reject) => {
        rejectCreate = reject
      }) as never
    })
    await reachCreate()
    await act(async () => button("Create paylink")?.click())
    await endSigningAndHandOff()
    expect(location.pathname).toBe("/activity")
    await act(async () => rejectCreate(new Error("boom")))
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    "preserves the voucher decision (%s) alongside the link hand-off",
    async (voucher) => {
      voucherAvailable.mockResolvedValue(voucher)
      await reachCreate()
      await act(async () => button("Create paylink")?.click())
      expect(createSponsoredLink).toHaveBeenCalledWith(
        deps,
        "25",
        expect.any(Function),
        expect.objectContaining({ voucher, onLink: expect.any(Function) }),
      )
    },
  )

  it("a create that never signs hands off when it lands", async () => {
    await reachCreate()
    await act(async () => button("Create paylink")?.click())
    await act(async () => new Promise((r) => setTimeout(r)))
    expect(location.pathname).toBe("/activity")
    expect(location.state).toEqual({ openPaylink: link.url })
    expect(container.textContent).toBe("Activity")
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })

  it("a cancelled passkey keeps the review, even with the link already prepared", async () => {
    let rejectCreate!: (e: Error) => void
    createSponsoredLink.mockImplementation(
      (_deps: unknown, _amount: string, _onStage: Stage, opts: Opts) => {
        opts.onLink?.(link)
        return new Promise((_, reject) => {
          rejectCreate = reject
        }) as never
      },
    )
    await reachCreate()
    await act(async () => button("Create paylink")?.click())
    await act(async () => provingProgress.emitSigningStart())
    await act(async () => provingProgress.emitSigningEnd(undefined, true))
    expect(location.pathname).toBe("/create")

    await act(async () => rejectCreate(new Error("NotAllowedError")))
    expect(showReportableError).toHaveBeenCalled()
    expect(button("Create paylink")).toBeDefined()
  })

  it("a failure before the hand-off fails the row and reopens the review", async () => {
    createSponsoredLink.mockRejectedValueOnce(new Error("boom"))
    await reachCreate()
    await act(async () => button("Create paylink")?.click())
    expect(showReportableError).toHaveBeenCalled()
    expect(location.pathname).toBe("/create")
    expect(button("Create paylink")).toBeDefined()
  })

  it("does not report cancellation when an unsigned create completes and navigates away", async () => {
    let resolveCreate!: (value: unknown) => void
    createSponsoredLink.mockImplementation((_deps, _amount, onStage, opts) => {
      onStage("proving")
      opts.onLink?.(link)
      return new Promise((resolve) => {
        resolveCreate = resolve
      }) as never
    })
    await reachCreate()
    await act(async () => button("Create paylink")?.click())
    await act(async () => resolveCreate({ ...link, txHash: "0xcreate" }))
    expect(location.pathname).toBe("/activity")
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })

  it("reports an accepted Cancel once while returning to confirmation", async () => {
    let continueCreate!: () => void
    createSponsoredLink.mockImplementation(async (_deps, _amount, onStage) => {
      onStage("building")
      await new Promise<void>((resolve) => {
        continueCreate = resolve
      })
      onStage("proving")
      return { ...link, txHash: "0xcreate" }
    })
    await reachCreate()
    await act(async () => button("Create paylink")?.click())
    expect(button("Cancel")?.disabled).toBe(false)
    await act(async () => button("Cancel")?.click())
    await act(async () => continueCreate())
    expect(button("Create paylink")).toBeDefined()
    await act(async () => root.render(null))
    expect(
      vi.mocked(fireEvent).mock.calls.filter(([name]) => name === "proving_cancelled"),
    ).toEqual([["proving_cancelled", { flow: "paylink-create", stage: "building" }]])
  })
  it("preserves a failure after a Cancel click that was too late to abort", async () => {
    let advance!: Stage
    let rejectCreate!: (error: Error) => void
    createSponsoredLink.mockImplementation((_deps, _amount, onStage) => {
      advance = onStage
      return new Promise((_, reject) => {
        rejectCreate = reject
      }) as never
    })
    await reachCreate()
    await act(async () => button("Create paylink")!.click())
    const cancel = button("Cancel")!
    expect(cancel.disabled).toBe(false)
    const error = new Error("Create failed")
    await act(async () => {
      advance("proving")
      // React has not yet removed the Cancel handler for the new stage.
      cancel.click()
      rejectCreate(error)
    })
    expect(showReportableError).toHaveBeenCalledWith(error, "paylink:create")
    await act(async () => root.render(null))
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })

  it("Back steps confirm → expiry → amount, and an edited expiry reaches the create", async () => {
    await reachCreate()
    await act(async () => button("Back")?.click())
    const select = container.querySelector("select")!
    await act(async () => {
      select.value = "7"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await act(async () => button("Back")?.click())
    expect(button("Next")).toBeDefined()
    expect(button("Back")).toBeUndefined()
    await act(async () => button("Next")?.click())
    await act(async () => button("Confirm")?.click())
    await act(async () => button("Create paylink")?.click())
    expect(createSponsoredLink.mock.calls[0]![3]).toMatchObject({ expiryDays: 7 })
  })

  it("offers no email lock, so the link it creates carries no email", async () => {
    await act(async () => setInput("25"))
    await act(async () => button("Next")?.click())
    expect(container.textContent).toContain("Link expiry")
    expect(container.textContent).not.toContain("Protect payment")
    await act(async () => button("Confirm")?.click())
    await act(async () => button("Create paylink")?.click())
    expect(createSponsoredLink).toHaveBeenCalledOnce()
    expect(createSponsoredLink.mock.calls[0]![3].email).toBeUndefined()
  })
})
