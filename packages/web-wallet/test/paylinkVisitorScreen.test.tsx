/**
 * What a visitor with no account is offered on `/link#…`.
 *
 * The fork is the point: a link that can pay its own way out asks how they want the money, and one
 * that cannot must not offer a cash-out it can't fund. The signup path is unchanged for every link
 * without a voucher, which is every link created before this shipped.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

/** Per-test voucher answer: undefined = the chain read is still in flight. */
const voucher: { uses: number | undefined; deps: unknown; error?: string; retry: () => void } = {
  uses: 0,
  deps: { _id: "deps" },
  retry: vi.fn(),
}
/** A cash-out this browser already made for the link under test. */
const withdrawal: { record: unknown } = { record: undefined }
const stashClaimLink = vi.fn()
const fireEvent = vi.fn()
/** The portal's cut, answered on demand so the caption can be read before and after it lands. */
const cut = vi.hoisted(() => ({ read: async () => 250_000_000_000_000_000n }))

vi.mock("../src/features/paylink/usePaylinkDeps", () => ({
  useLinkVoucher: () => voucher,
  useLinkWithdrawal: () => withdrawal.record,
  usePaylinkKit: () => undefined,
}))
const stashTicketSignup = vi.fn()
const clearTicketSignup = vi.fn()
/** The ticket signup marker: set by stashTicketSignup, read back by the screen. */
let ticketStashed = false
/** The network's offer: null = no tickets, undefined = still loading, or failed with a retry. */
const offer: {
  value: { threshold: string; schedule: { fee: string; minDeposit: string } } | null | undefined
  failed: boolean
  retry: () => void
} = {
  value: null,
  failed: false,
  retry: vi.fn(),
}
vi.mock("../src/features/paylink/claimStash", () => ({
  stashClaimLink,
  stashTicketSignup: (...args: unknown[]) => {
    ticketStashed = true
    return stashTicketSignup(...args)
  },
  clearTicketSignup,
  peekTicketSignup: () => (ticketStashed ? { fragment: "frag" } : null),
}))
vi.mock("../src/features/paylink/goldenTicketOffer", () => ({
  useGoldenTicketOffer: () => ({ offer: offer.value, failed: offer.failed, retry: offer.retry }),
}))
/** Whether the link's ticket already bought a registration on this tab. */
const committed = { value: false }
vi.mock("../src/features/paylink/ticketContinuation", () => ({
  ticketSignupCommitted: () => committed.value,
}))
vi.mock("../src/features/fees/fpcFundingCut", () => ({ currentFpcFundingCut: () => cut.read() }))
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }))
vi.mock("../src/features/paylink/ClaimProgressModal", () => ({
  ClaimProgressModal: () => <div data-testid="progress" />,
}))
vi.mock("../src/lib/analytics", () => ({ fireEvent }))
vi.mock("../src/features/paylink/paylinkExit", () => ({ cashOutLink: vi.fn() }))
vi.mock("../src/ui/screens/WithdrawalDetailModal", () => ({
  withdrawalStatus: () => ({ label: "Releasing on Ethereum", badge: "pending" }),
}))
vi.mock("../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../src/features/onboarding/OnboardingScreen", () => ({
  OnboardingScreen: ({
    inviteHeader,
    onExit,
    ticketSignup,
  }: {
    inviteHeader?: React.ReactNode
    onExit?: () => void
    ticketSignup?: boolean
  }) => (
    <div data-testid={ticketSignup ? "ticket-signup" : "signup"}>
      {inviteHeader}
      {onExit && <button onClick={onExit}>exit</button>}
    </div>
  ),
}))
vi.mock("../src/features/paylink/ClaimToL1Modal", () => ({
  ClaimToL1Modal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="cash-out">
      <button onClick={onClose}>close</button>
    </div>
  ),
}))
// The DS drags in liquid-glass optics jsdom can't render; this test is about which CTA appears.
vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  Spinner: () => <div data-testid="spinner" />,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
}))

const { PaylinkVisitorScreen } = await import("../src/features/paylink/PaylinkVisitorScreen")

const link = (over: Record<string, unknown> = {}) =>
  ({
    url: "http://test/link#frag",
    fragment: "frag",
    amount: "25",
    status: "unclaimed",
    flavor: "direct",
    ...over,
  } as never)

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.clearAllMocks()
  ticketStashed = false
  committed.value = false
  offer.value = null
  offer.failed = false
  voucher.error = undefined
  voucher.uses = 0
  voucher.deps = { _id: "deps" }
  withdrawal.record = undefined
  cut.read = async () => 250_000_000_000_000_000n
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (props: Parameters<typeof PaylinkVisitorScreen>[0]) =>
  act(() => root.render(<PaylinkVisitorScreen {...props} />))

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))

const testId = (id: string) => container.querySelector(`[data-testid="${id}"]`)

describe("PaylinkVisitorScreen", () => {
  it.each(["direct", "email"])(
    "keeps a failed %s eligibility check out of signup and offers retry",
    (flavor) => {
      voucher.uses = undefined
      voucher.error = "Could not check withdrawal availability"
      render({ link: link({ flavor }) })
      expect(testId("signup")).toBeNull()
      expect(button("Claim to an Ethereum wallet")?.disabled).toBe(true)
      expect(button("Receive to zk.money")).toBeTruthy()
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not check")
      act(() => button("Try again")!.click())
      expect(voucher.retry).toHaveBeenCalledOnce()
    },
  )

  it("opens on signup for a link that carries no voucher", () => {
    voucher.uses = 0
    render({ link: link() })

    expect(testId("signup")).toBeTruthy()
    expect(button("Claim to an Ethereum wallet")).toBeUndefined()
    // The amount still leads, and the fragment is stashed for the claim prompt after signup.
    expect(container.textContent).toContain("$25")
    expect(stashClaimLink).toHaveBeenCalledWith("frag")
  })

  it.each(["direct", "email"])("offers both choices for a funded %s link", (flavor) => {
    voucher.uses = 1
    render({ link: link({ flavor }) })

    expect(testId("signup")).toBeNull()
    expect(button("Receive to zk.money")).toBeTruthy()
    expect(button("Claim to an Ethereum wallet")).toBeTruthy()
  })

  it("shows the choice while checking funding, without enabling withdrawal yet", () => {
    // Rendering the signup form first would either take the choice away or pull a half-typed tag
    // out from under whoever was answering it.
    voucher.uses = undefined
    render({ link: link() })

    expect(testId("spinner")).toBeTruthy()
    expect(testId("signup")).toBeNull()
    expect(button("Claim to an Ethereum wallet")?.disabled).toBe(true)
    expect(button("Receive to zk.money")).toBeTruthy()
  })

  it.each(["direct", "email"])(
    "opens the account-free %s cash-out sheet and returns to the choice",
    (flavor) => {
      voucher.uses = 1
      render({ link: link({ flavor }) })

      act(() => button("Claim to an Ethereum wallet")!.click())
      expect(testId("cash-out")).toBeTruthy()
      expect(fireEvent).toHaveBeenCalledWith("paylink_visitor_chose", { choice: "ethereum" })

      act(() => button("close")!.click())
      expect(testId("cash-out")).toBeNull()
      expect(button("Claim to an Ethereum wallet")).toBeTruthy()
    },
  )

  it("hands a visitor who picks an account to signup, and keeps them there", () => {
    voucher.uses = 1
    render({ link: link() })

    act(() => button("Receive to zk.money")!.click())

    expect(testId("signup")).toBeTruthy()
    expect(button("Claim to an Ethereum wallet")).toBeUndefined()
    expect(fireEvent).toHaveBeenCalledWith("paylink_visitor_chose", {
      choice: "account",
      ticket: false,
    })
    expect(stashTicketSignup).not.toHaveBeenCalled()
    expect(clearTicketSignup).toHaveBeenCalled()
  })

  it("on a network that issues tickets, the link pays for the signup: the three-step modal opens over this page", () => {
    voucher.uses = 1
    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link({ memo: "Pizza dinner" }) })
    expect(container.textContent).toContain("Free and instant")

    act(() => button("Receive to zk.money")!.click())

    expect(stashTicketSignup).toHaveBeenCalledWith({
      fragment: "frag",
      threshold: "1",
      schedule: { fee: "5", minDeposit: "0" },
      memo: "Pizza dinner",
    })
    expect(fireEvent).toHaveBeenCalledWith("paylink_visitor_chose", {
      choice: "account",
      ticket: true,
    })
    expect(testId("ticket-signup")).toBeTruthy()
    expect(testId("signup")).toBeNull()
    // The choice stays behind the modal, inert, and closing the first step returns to it.
    expect(button("Receive to zk.money")?.disabled).toBe(true)
    expect(button("Claim to an Ethereum wallet")?.disabled).toBe(true)
    act(() => button("exit")!.click())
    expect(testId("ticket-signup")).toBeNull()
    expect(button("Receive to zk.money")?.disabled).toBe(false)
    // Nothing was committed: the ticket intent goes, the link stays stashed for Home.
    expect(clearTicketSignup).toHaveBeenCalledOnce()
    expect(stashClaimLink).toHaveBeenCalledWith("frag")
  })

  it("leaving the page before the tag is claimed drops the ticket intent; a bought registration keeps it", () => {
    voucher.uses = 1
    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link() })
    act(() => button("Receive to zk.money")!.click())
    act(() => root.render(<div />))
    expect(clearTicketSignup).toHaveBeenCalledOnce()

    clearTicketSignup.mockClear()
    render({ link: link() })
    act(() => button("Receive to zk.money")!.click())
    committed.value = true
    act(() => root.render(<div />))
    expect(clearTicketSignup).not.toHaveBeenCalled()
  })

  it("holds the account choice until the ticket offer is read, then honours a late offer", () => {
    voucher.uses = 1
    offer.value = undefined
    render({ link: link() })
    expect(container.textContent).toContain("Checking what this link pays for")
    expect(container.textContent).not.toContain("Free and instant")
    expect(button("Receive to zk.money")?.disabled).toBe(true)
    act(() => button("Receive to zk.money")!.click())
    expect(testId("signup")).toBeNull()
    expect(testId("ticket-signup")).toBeNull()
    expect(stashTicketSignup).not.toHaveBeenCalled()
    expect(clearTicketSignup).not.toHaveBeenCalled()

    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link() })
    expect(button("Receive to zk.money")?.disabled).toBe(false)
    act(() => button("Receive to zk.money")!.click())
    expect(stashTicketSignup).toHaveBeenCalledOnce()
    expect(testId("ticket-signup")).toBeTruthy()
  })

  it("a failed offer read offers retry, and never starts the paid signup on a guess", () => {
    voucher.uses = 1
    offer.value = undefined
    offer.failed = true
    render({ link: link() })
    expect(container.textContent).toContain("Couldn't check what this link pays for")
    expect(container.textContent).not.toContain("Free and instant")
    expect(button("Receive to zk.money")?.disabled).toBe(false)
    act(() => button("Receive to zk.money")!.click())
    expect(offer.retry).toHaveBeenCalledOnce()
    expect(testId("signup")).toBeNull()
    expect(testId("ticket-signup")).toBeNull()
    expect(stashTicketSignup).not.toHaveBeenCalled()
    expect(clearTicketSignup).not.toHaveBeenCalled()
    expect(fireEvent).not.toHaveBeenCalledWith("paylink_visitor_chose", expect.anything())

    // The retry settled on a confirmed absence: the ordinary signup is the right answer now.
    offer.failed = false
    offer.value = null
    render({ link: link() })
    act(() => button("Receive to zk.money")!.click())
    expect(clearTicketSignup).toHaveBeenCalledOnce()
    expect(testId("signup")).toBeTruthy()
  })

  it("a confirmed absent offer still starts the ordinary signup", () => {
    voucher.uses = 1
    offer.value = null
    render({ link: link() })
    act(() => button("Receive to zk.money")!.click())
    expect(clearTicketSignup).toHaveBeenCalledOnce()
    expect(stashTicketSignup).not.toHaveBeenCalled()
    expect(testId("signup")).toBeTruthy()
  })

  it("without a ticket offer the account option promises privacy, not a free tag", () => {
    voucher.uses = 1
    offer.value = null
    render({ link: link() })
    expect(container.textContent).not.toContain("Free and instant")
    expect(container.textContent).toContain("Create an account to receive it")
  })

  it("withholds the cash-out until the enclave co-signer is connected", () => {
    voucher.uses = 1
    voucher.deps = undefined
    render({ link: link() })

    expect(button("Claim to an Ethereum wallet")!.hasAttribute("disabled")).toBe(true)
  })

  it("says a claimed link is spent, and offers nothing to do", () => {
    voucher.uses = 0
    render({ link: link({ status: "claimed" }) })

    expect(container.textContent).toContain("This link has been used")
    expect(button("Claim to an Ethereum wallet")).toBeUndefined()
    expect(button("Receive to zk.money")).toBeUndefined()
  })

  it("tells the holder who cashed it out that the money is theirs and moving", () => {
    // The escrow is spent, so the chain reads "claimed" — which about their own withdrawal would
    // say someone else took it.
    voucher.uses = 0
    withdrawal.record = { recipient: `0x${"dd".repeat(20)}`, phase: "finalizing_l1" }
    render({ link: link({ status: "claimed" }) })

    expect(container.textContent).toContain("You withdrew")
    expect(container.textContent).toContain("Releasing on Ethereum")
    expect(container.textContent).not.toContain("already claimed")
    expect(testId("signup")).toBeNull()
    expect(testId("progress")).toBeTruthy()
  })
})

describe("PaylinkVisitorScreen — the external claim's price", () => {
  it("names no figure until the portal's cut lands, then the whole fee", async () => {
    let landed!: (value: bigint) => void
    cut.read = () => new Promise<bigint>((resolve) => (landed = resolve))
    voucher.uses = 3
    await act(async () => root.render(<PaylinkVisitorScreen link={link()} />))

    expect(container.textContent).toContain("Slower and pays a network fee.")

    await act(async () => landed(250_000_000_000_000_000n))
    // The relayer tip (0.1) plus the cut (0.25) — what the claim actually costs.
    expect(container.textContent).toContain("Slower and pays a $0.35 fee.")
  })
})
