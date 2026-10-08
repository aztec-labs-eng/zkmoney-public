/**
 * The request pay sheet shows the per-deposit limits beside the address and in its QR sheet. A
 * fixed request over a limit keeps its amount and its address on screen, but offers neither to
 * copy nor to scan, and never suggests a second transfer to the same address.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseUnits } from "viem"
import type { RequestInlinePacket } from "@obsidion/front-core"

const SIPA = `0x${"aa".repeat(20)}`
const L1_TOKEN = `0x${"22".repeat(20)}` as const
const FEE = parseUnits("0.35", 18)

const capacity = vi.hoisted(() => ({
  availableAtomic: 40_000n * 10n ** 18n,
  readFails: false,
  globalLimitAtomic: undefined as bigint | undefined,
  epoch: 0,
  keys: [] as string[],
}))
vi.mock("../src/features/deposit/capacityStore", async () =>
  (await import("./fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox", l1ChainId: 31337 }),
}))
vi.mock("uqr", () => ({
  renderSVG: (value: string) => `<svg data-uri="${value}"></svg>`,
  encode: () => ({ size: 21, data: Array.from({ length: 21 }, () => Array(21).fill(false)) }),
}))
// About limits reads the manifest for its policy section. The allowance hook is NOT mocked: the request page has no
// AccountProvider, so the sheet must not reach useSponsoredAllowance here.
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ token: L1_TOKEN }),
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  ),
  TopNavIconButton: () => null,
}))

const { ExternalWalletPayModal } = await import("../src/features/requests/ExternalWalletPayModal")
const { depositCapacityStore } = await import("../src/features/deposit/capacityStore")
const { FAKE_ACTIVE_KEY } = await import("./fakeCapacity")

/** A new read of the active bucket, as the store's poll or Check again would make. */
const reread = async () => {
  await act(async () => {
    await depositCapacityStore(FAKE_ACTIVE_KEY).retry()
  })
  for (let i = 0; i < 3; i++) await act(async () => {})
}

/** `embedded`: the link carries the payee's address; otherwise it was resolved from the active deployment. */
function packet(amount: string, embedded = true): RequestInlinePacket {
  return {
    requestId: `0x${"0a".repeat(32)}`,
    requesterTag: "alice",
    amountAtomic: parseUnits(amount, 18),
    tokenAddress: `0x${"1b".repeat(32)}`,
    tokenDecimals: 18,
    tokenSymbol: "DAI",
    networkId: "0xrollup",
    ...(embedded ? { sipaAddress: SIPA } : {}),
  } as RequestInlinePacket
}

function result(p: RequestInlinePacket) {
  return {
    sipaAddress: SIPA,
    token: L1_TOKEN,
    decimals: 18,
    feeAtomic: FEE,
    grossAtomic: p.amountAtomic > 0n ? p.amountAtomic + FEE : 0n,
    paymentUri: `ethereum:${L1_TOKEN}@31337/transfer?address=${SIPA}`,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  capacity.availableAtomic = 40_000n * 10n ** 18n
  capacity.readFails = false
  capacity.globalLimitAtomic = undefined
  capacity.epoch += 1
  capacity.keys.length = 0
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = async (p: RequestInlinePacket) => {
  await act(async () => {
    root.render(<ExternalWalletPayModal packet={p} result={result(p)} onClose={() => {}} />)
  })
  // The capacity key, then the bucket's first read.
  for (let i = 0; i < 5; i++) await act(async () => {})
}

const buttonNamed = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))
const addressButton = () => document.querySelector<HTMLButtonElement>(`button[title="${SIPA}"]`)
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
const gotIt = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes("Got it!"),
  )!
const capacityWarning = () => document.querySelector("[data-testid='address-capacity-warning']")
const panel = () => document.querySelector("[data-testid='funding-capacity-panel']")
const aboutLimits = () => document.querySelector("dialog[aria-label='About limits']")
/** Opens the limit's details from `scope` and returns them. */
const openLimit = async (scope: ParentNode = document) => {
  await click(
    scope.querySelector("[data-testid='address-limits'] [data-testid='about-limits-link']")!,
  )
  for (let i = 0; i < 3; i++) await act(async () => {})
  return aboutLimits()!
}
const maxSend = (scope: ParentNode) =>
  scope.querySelector("[data-testid='address-limits-max-send']")?.textContent
const maxCredit = (scope: ParentNode) =>
  scope.querySelector("[data-testid='address-limits-max-credit']")?.textContent

describe("ExternalWalletPayModal limits", () => {
  it("shows the limits beside the address and in the QR sheet of a fixed request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await render(packet("100"))
    expect(document.querySelector("[data-testid='address-limits']")?.textContent).toBe(
      "Deposit limit: $2,500 incl. fees",
    )
    const details = await openLimit()
    expect(maxSend(details)).toBe("2,500 TEST")
    // The credit at the maximum send, net of the current deposit fee.
    expect(maxCredit(details)).toBe("2,499.65 TEST")
    expect(details.textContent).toContain("counts 1 TEST as $1")
    await act(async () => {
      details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    await click(buttonNamed("Show")!)
    // The link's address has no proven portal, so its capacity is unconfirmed.
    await click(gotIt())
    const qr = document.querySelector("dialog[aria-label='Payment address']")!
    expect(qr.querySelector("[data-testid='address-limits']")?.textContent).toBe(
      "Deposit limit: $2,500 incl. fees",
    )
    expect(maxSend(await openLimit(qr))).toBe("2,500 TEST")
    vi.restoreAllMocks()
  })

  it("offers a request whose send is exactly $2,500, fee included", async () => {
    await render(packet("2499.65"))
    expect(addressButton()?.disabled).toBe(false)
    expect(buttonNamed("Show")?.disabled).toBe(false)
    expect(buttonNamed("Copy")?.disabled).toBe(false)
    expect(document.querySelector("[data-testid='request-over-limit']")).toBeNull()
    expect(document.body.textContent).toContain("the requested amount plus the deposit fee")
  })

  it("holds copy and scan for a request over the limit, and keeps its address and amount", async () => {
    await render(packet("2500"))
    expect(addressButton()?.disabled).toBe(true)
    expect(addressButton()?.textContent).toContain(SIPA.slice(0, 6))
    expect(buttonNamed("Show")?.disabled).toBe(true)
    expect(buttonNamed("Copy")?.disabled).toBe(true)
    const notice = document.querySelector("[data-testid='request-over-limit']")?.textContent ?? ""
    expect(notice).toContain("Over the $2,500 limit")
    expect(notice).toContain("Ask the requester for a new request")
    expect(notice).not.toMatch(
      /send (it )?again|separate|another transfer|one transfer|split|more than one/i,
    )
    // The requested amount is shown as asked, never reduced to fit.
    expect(document.body.textContent).toContain("$2,500.00")
    expect(document.body.textContent).not.toContain("the requested amount plus the deposit fee")
  })

  it("shows the limits for an open request and leaves sharing to the payer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await render(packet("0"))
    expect(document.body.textContent).toContain("Any amount")
    expect(maxSend(await openLimit())).toBe("2,500 TEST")
    await act(async () => {
      aboutLimits()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    vi.restoreAllMocks()
    expect(buttonNamed("Copy")?.disabled).toBe(false)
    expect(buttonNamed("Show")?.disabled).toBe(false)
  })

  describe("shared capacity", () => {
    it("never takes the active bucket for a link's own address", async () => {
      await render(packet("100"))
      expect(panel()?.textContent).toContain("Capacity can't be checked for this deposit.")
      expect(panel()?.textContent).not.toContain("Checking capacity")
      expect(panel()?.querySelector("[data-testid='funding-capacity-retry']")).toBeNull()
      expect(capacity.keys).toEqual([])
      // Unconfirmed capacity warns on every copy, and never holds the payment.
      // The Copy button reads "Copied" for a moment after a copy.
      const copyAction = () => document.querySelectorAll(".ww-deposit__actions button")[1]
      for (let i = 0; i < 2; i++) {
        await click(copyAction())
        expect(capacityWarning()?.textContent).toContain("isn't confirmed")
        await click(gotIt())
      }
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2)
      expect(document.querySelector("[data-testid='request-over-limit']")).toBeNull()
    })

    it("opens About limits as unavailable for a link's own address, with no active read or Retry", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      await render(packet("100"))
      await click(panel()!.querySelector("[data-testid='about-limits-link']")!)
      const sheet = document.querySelector("dialog[aria-label='About limits']")!
      expect(
        sheet
          .querySelector("[data-testid='about-limits-capacity-toggle']")!
          .getAttribute("aria-expanded"),
      ).toBe("true")
      const section = sheet.querySelector<HTMLElement>("[data-testid='about-limits-capacity']")!
      expect(section.dataset.state).toBe("unavailable")
      expect(sheet.querySelector("[data-testid='about-limits-capacity-retry']")).toBeNull()
      expect(capacity.keys).toEqual([])
      // No account context on the request page: the allowance section says so instead of reading one.
      const sponsorship = sheet.querySelector<HTMLElement>(
        "[data-testid='about-limits-sponsorship']",
      )!
      expect(sponsorship.dataset.state).toBe("no-account")
      vi.restoreAllMocks()
    })

    it("opens About limits on the active bucket for an address resolved just now", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      await render(packet("100", false))
      const sheet = await openLimit()
      const section = sheet.querySelector<HTMLElement>("[data-testid='about-limits-capacity']")!
      expect(section.dataset.state).toBe("fresh")
      expect(section.textContent).toContain("40,000 TEST")
      vi.restoreAllMocks()
    })

    it("checks an address resolved from the active deployment against its bucket", async () => {
      await render(packet("100", false))
      expect(capacity.keys.length).toBeGreaterThan(0)
      // A fitting payment adds nothing; a fit is not a promise.
      expect(panel()?.className).toContain("ww-capacity--quiet")
      await click(buttonNamed("Copy")!)
      expect(capacityWarning()).toBeNull()
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    })

    it("holds copy and scan when known capacity can't take the fixed amount, and keeps it", async () => {
      capacity.availableAtomic = 50n * 10n ** 18n
      await render(packet("100", false))
      expect(addressButton()?.disabled).toBe(true)
      expect(buttonNamed("Show")?.disabled).toBe(true)
      expect(buttonNamed("Copy")?.disabled).toBe(true)
      expect(panel()?.textContent).toContain(
        "This payment needs 100 TEST; 50 TEST is available now.",
      )
      // The capacity line says why; the hold says what it pauses, without repeating it.
      expect(document.querySelector("[data-testid='request-over-limit']")?.textContent).toBe(
        "Copy and scan are paused until this payment fits current capacity.",
      )
      expect(document.body.textContent).toContain("$100.00")
    })

    it("warns before sharing an open request's address while capacity is zero", async () => {
      capacity.availableAtomic = 0n
      await render(packet("0", false))
      await click(buttonNamed("Show")!)
      expect(capacityWarning()?.textContent).toContain("No network capacity is available right now")
    })

    it("names the most that fits current capacity for an open request", async () => {
      capacity.availableAtomic = 500n * 10n ** 18n
      await render(packet("0", false))
      expect(document.querySelector("[data-testid='address-capacity-detail']")?.textContent).toBe(
        "To fit current capacity, send at most 500.35 TEST.",
      )
    })

    it("closes the QR and holds copy when a fixed payment stops fitting while it is open", async () => {
      await render(packet("100", false))
      await click(buttonNamed("Show")!)
      expect(document.querySelector("dialog[aria-label='Payment address']")).not.toBeNull()
      capacity.availableAtomic = 50n * 10n ** 18n
      await reread()
      expect(document.querySelector("dialog[aria-label='Payment address']")).toBeNull()
      expect(buttonNamed("Copy")?.disabled).toBe(true)
      expect(buttonNamed("Show")?.disabled).toBe(true)
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain("$100.00")
    })

    it("asks again on each copy inside the QR while capacity is unconfirmed", async () => {
      await render(packet("100"))
      await click(buttonNamed("Show")!)
      await click(gotIt())
      const qrCopy = () => document.querySelector(".ww-qr-card__label")!
      for (let i = 1; i <= 2; i++) {
        await click(qrCopy())
        expect(capacityWarning()).not.toBeNull()
        expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(i - 1)
        await click(gotIt())
        expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(i)
      }
    })

    it("does not act on a warning once the fixed payment is known not to fit", async () => {
      capacity.readFails = true
      await render(packet("100", false))
      await click(buttonNamed("Copy")!)
      expect(capacityWarning()).not.toBeNull()
      capacity.readFails = false
      capacity.availableAtomic = 50n * 10n ** 18n
      await reread()
      // Acknowledging whatever is still open must not copy the held address.
      const ack = document.querySelector("dialog[aria-label='Network capacity']")
      if (ack) await click(gotIt())
      expect(document.querySelector("dialog[aria-label='Network capacity']")).toBeNull()
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
      expect(buttonNamed("Copy")?.disabled).toBe(true)
    })

    it("says a fixed payment above the bucket's ceiling can never fit, with no wait", async () => {
      capacity.globalLimitAtomic = 50n * 10n ** 18n
      capacity.availableAtomic = 50n * 10n ** 18n
      await render(packet("100", false))
      expect(panel()?.textContent).toContain(
        "can't fit the network's deposit capacity, even when it is full",
      )
      expect(panel()?.querySelector("[data-testid='funding-capacity-retry']")).toBeNull()
      const notice = document.querySelector("[data-testid='request-over-limit']")?.textContent
      expect(notice).toBe("Ask the requester for a new request with a smaller amount.")
      expect(notice).not.toContain("Check again later")
      expect(buttonNamed("Copy")?.disabled).toBe(true)
    })

    it("keeps the warning's words if the reading improves while it is open", async () => {
      capacity.readFails = true
      await render(packet("100", false))
      await click(buttonNamed("Copy")!)
      capacity.readFails = false
      await reread()
      expect(capacityWarning()?.textContent).toContain("isn't confirmed")
      await click(gotIt())
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    })
  })
})
