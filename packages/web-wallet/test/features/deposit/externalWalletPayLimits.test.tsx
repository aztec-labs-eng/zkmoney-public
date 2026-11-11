/** Guards: no copy, scan or send past limit or capacity; no second payment; the right bucket. */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseUnits } from "viem"
import type { RequestInlinePacket } from "@obsidion/front-core"
import { shortL1Addr } from "../../../src/ui/format"
import type { LinkDeployment } from "../../../src/features/requests/accountlessRequest"
import {
  MAINNET_DAI,
  MAINNET_USDC,
  mainnetTokens,
  mockLoadDepositFacts,
  singleToken,
} from "../../support/depositTokens"
import * as copy from "../../../src/features/limits/limitsCopy"
import { LIMIT, LIMIT_USD, grouped, typed } from "../../support/publicLimit"

const SIPA = `0x${"aa".repeat(20)}`
const L1_TOKEN = `0x${"22".repeat(20)}` as const
const FEE = parseUnits("0.25", 18)

const capacity = vi.hoisted(() => ({
  availableAtomic: 40_000n * 10n ** 18n,
  readFails: false,
  globalLimitAtomic: undefined as bigint | undefined,
  epoch: 0,
  keys: [] as string[],
  rowTokens: [] as (string | undefined)[],
  mainnet: false,
}))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("../../../src/features/token/useTxAmountCap", () => ({
  useTxAmountCap: () => 5166n * 10n ** 18n,
  useRowTxAmountCap: () => 5166n * 10n ** 18n,
}))
// The allowance hook is NOT mocked: the request page has no AccountProvider, so the sheet must not
// reach useSponsoredAllowance here.
// The sandbox's one-row table.
vi.mock("../../../src/features/sipa/loadDepositFacts", (importOriginal) =>
  mockLoadDepositFacts(importOriginal, () =>
    capacity.mainnet ? mainnetTokens() : singleToken(L1_TOKEN, "TEST"),
  ),
)
vi.mock("@obsidion/web-ds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/web-ds")>()),
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
    testId,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
    testId?: string
  }) => (
    <button type="button" onClick={onClick} disabled={isDisabled} data-testid={testId}>
      {title}
    </button>
  ),
  ComingSoonPill: () => null,
  RowChevron: () => null,
  Spinner: () => null,
  TopNavIconButton: () => null,
}))

const l1 = vi.hoisted(() => ({
  account: null as string | null,
}))
vi.mock("../../../src/session/useL1Wallet", () => ({ useL1Wallet: () => l1 }))
const walletSend = vi.hoisted(() => ({ props: undefined as Record<string, any> | undefined }))
vi.mock("../../../src/features/deposit/DepositFromWalletModal/DepositFromWalletModal", () => ({
  DepositFromWalletModal: (props: Record<string, any>) => {
    walletSend.props = props
    return <div data-testid="wallet-send" />
  },
}))

const { ExternalWalletPayModal } = await import(
  "../../../src/features/requests/ExternalWalletPayModal"
)
const { depositCapacityStore } = await import("../../../src/features/deposit/capacityStore")
const { FAKE_ACTIVE_KEY } = await import("../../support/fakeCapacity")
const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")
beforeEach(() => void openTestSession({ primed: { tuple: { token: L1_TOKEN } as never } }))
afterEach(closeSession)

/** A new read of the active bucket, as the store's poll or Check again would make. */
const reread = async () => {
  await act(async () => {
    await depositCapacityStore({} as never, FAKE_ACTIVE_KEY).retry()
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

function result(p: RequestInlinePacket, deployment?: LinkDeployment) {
  return {
    deployment: deployment ?? (p.sipaAddress ? "unproven" : "active"),
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
  localStorage.clear()
  l1.account = null
  walletSend.props = undefined
  capacity.availableAtomic = 40_000n * 10n ** 18n
  capacity.readFails = false
  capacity.globalLimitAtomic = undefined
  capacity.epoch += 1
  capacity.keys.length = 0
  capacity.rowTokens = []
  capacity.mainnet = false
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const buttonNamed = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
const settle = async () => {
  // The capacity key, then the bucket's first read.
  for (let i = 0; i < 5; i++) await act(async () => {})
}

/** The flow's first step on (the L1 and the request's token), then the method. */
const toMethod = () => click(document.querySelector("[data-testid='deposit-select-continue']")!)
/** The method step's "Payment address": the payee's address. */
const toAddress = async () => {
  await toMethod()
  await click(buttonNamed("Payment address")!)
}
const connectWallet = () => buttonNamed("Connect wallet")

const mount = async (p: RequestInlinePacket, r = result(p)) => {
  await act(async () => {
    root.render(
      <ExternalWalletPayModal packet={p} result={r} onClose={() => {}} onFeeChanged={() => {}} />,
    )
  })
  await settle()
}
/** `at`: the step the flow is left on. */
const render = async (
  p: RequestInlinePacket,
  deployment?: LinkDeployment,
  at: "select" | "method" | "address" = "address",
) => {
  await mount(p, result(p, deployment))
  if (at === "method") await toMethod()
  if (at === "address") await toAddress()
}
const addressButton = () => document.querySelector<HTMLButtonElement>(`button[title="${SIPA}"]`)
const gotIt = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes("Got it!"),
  )!
const capacityWarning = () => document.querySelector("[data-testid='address-capacity-warning']")
const panel = () => document.querySelector("[data-testid='funding-capacity-panel']")

describe("ExternalWalletPayModal for a swapped token", () => {
  it("reads the bucket of the row the request's token swaps into", async () => {
    capacity.mainnet = true
    const p = {
      ...packet("0", false),
      tokenSymbol: "USDC",
      tokenDecimals: 6,
    } as RequestInlinePacket
    await mount(p, {
      ...result(p, "active"),
      token: MAINNET_USDC,
      decimals: 6,
      feeAtomic: 100_000n,
      grossAtomic: 0n,
    })

    const asked = capacity.rowTokens.map((t) => t?.toLowerCase())
    expect(asked).toContain(MAINNET_DAI.toLowerCase())
    expect(asked).not.toContain(MAINNET_USDC.toLowerCase())
  })
})

describe("ExternalWalletPayModal limits", () => {
  it(`offers a request whose send is exactly ${LIMIT_USD}, fee included`, async () => {
    await render(packet(typed(LIMIT - 0.25)))
    expect(addressButton()?.disabled).toBe(false)
    expect(buttonNamed("Show")?.disabled).toBe(false)
    expect(buttonNamed("Copy")?.disabled).toBe(false)
    expect(document.querySelector("[data-testid='request-over-limit']")).toBeNull()
    expect(document.querySelector(".ww-paylink-summary__amount")?.textContent).toBe(
      `$${grouped(LIMIT, true)}`,
    )
    expect(document.querySelector("[data-testid='request-fee']")).not.toBeNull()
  })

  it("holds copy and scan for a request over the limit, and keeps its address and amount", async () => {
    await render(packet(String(LIMIT)))
    expect(addressButton()?.disabled).toBe(true)
    expect(addressButton()?.textContent).toContain(shortL1Addr(SIPA))
    expect(buttonNamed("Show")?.disabled).toBe(true)
    expect(buttonNamed("Copy")?.disabled).toBe(true)
    const notice = document.querySelector("[data-testid='request-over-limit']")?.textContent ?? ""
    expect(notice).toContain(`Over the ${LIMIT_USD} limit`)
    expect(notice).toContain("Ask the requester for a new request")
    expect(notice).not.toMatch(
      /send (it )?again|separate|another transfer|one transfer|split|more than one/i,
    )
    // The amount is shown as asked plus the fee, never reduced to fit.
    expect(document.querySelector(".ww-paylink-summary__amount")?.textContent).toBe(
      `$${grouped(LIMIT + 0.25, true)}`,
    )
  })

  describe("link deployment", () => {
    it("says an expired link has expired and offers nothing to pay it", async () => {
      await render(packet("100"), "expired", "select")
      expect(document.querySelector("[data-testid='request-expired']")?.textContent).toContain(
        "@alice",
      )
      expect(addressButton()).toBeNull()
      expect(buttonNamed("Show")).toBeUndefined()
      expect(buttonNamed("Copy")).toBeUndefined()
      expect(document.querySelector("[data-testid='deposit-select-continue']")).toBeNull()
      expect(document.body.textContent).not.toContain(SIPA)
      expect(capacity.keys).toEqual([])
    })
  })

  describe("pay with wallet", () => {
    const sendOpen = () => document.querySelector("[data-testid='wallet-send']")

    it("sends a fixed request from the connected wallet to the payee's address", async () => {
      l1.account = `0x${"ee".repeat(20)}`
      await render(packet("100"), undefined, "method")
      await click(connectWallet()!)
      expect(walletSend.props).toMatchObject({
        deposit: { address: SIPA },
        payee: "alice",
        fixedAmount: "100",
        fee: "0.25",
      })
      // The modal saves the hold before the wallet's prompt, then reports the send.
      await act(async () => walletSend.props!.onApproving("browser:1"))
      await act(async () =>
        walletSend.props!.onSent({
          address: SIPA,
          txHash: `0x${"ab".repeat(32)}`,
          amount: "100.25",
          tokenSymbol: "USDC",
        }),
      )
      expect(sendOpen()).toBeNull()
      expect(document.querySelector("[data-testid='request-sent']")?.textContent).toContain(
        "@alice",
      )
      expect(document.querySelector("[data-testid='deposit-select-continue']")).toBeNull()
      // Reopened before the transfer settles: no second payment until the payer asks for one.
      await act(async () => root.render(<></>))
      await render(packet("100"), undefined, "select")
      expect(document.querySelector("[data-testid='request-unresolved']")).not.toBeNull()
      expect(document.querySelector("[data-testid='deposit-select-continue']")).toBeNull()
      await click(buttonNamed("Pay again")!)
      await toMethod()
      expect(connectWallet()?.disabled).toBe(false)
    })

    it("is held with Copy and Show when the request is over the limit", async () => {
      l1.account = `0x${"ee".repeat(20)}`
      await render(packet(String(LIMIT)), undefined, "method")
      expect(connectWallet()?.disabled).toBe(true)
      await click(connectWallet()!)
      expect(sendOpen()).toBeNull()
    })
  })

  describe("shared capacity", () => {
    it("opens About limits as unavailable for a link's own address, with no active read or Retry", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      await render(packet("100"))
      await click(panel()!.querySelector("[data-testid='about-limits-link']")!)
      const sheet = document.querySelector(`dialog[aria-label="${copy.SHEET_TITLE}"]`)!
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

    it("warns before sharing an open request's address while capacity is zero", async () => {
      capacity.availableAtomic = 0n
      await render(packet("0", false))
      await click(buttonNamed("Show")!)
      expect(capacityWarning()?.textContent).toContain("No network capacity is available right now")
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
      expect(document.body.textContent).toContain("$100.25")
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
  })
})

describe("ExternalWalletPayModal network and coin", () => {
  const select = () =>
    document.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-select']")!

  it("keeps a fixed request on its own network and coin", async () => {
    await render(packet("10"), undefined, "select")
    expect(select().disabled).toBe(true)
    await toMethod()
    expect(document.querySelector("[data-testid='deposit-crumb']")).toBeNull()
  })

  it("lets an open request pick them", async () => {
    await render(packet("0"), undefined, "select")
    expect(select().disabled).toBe(false)
    await toMethod()
    expect(document.querySelector("[data-testid='deposit-crumb']")).not.toBeNull()
  })
})
