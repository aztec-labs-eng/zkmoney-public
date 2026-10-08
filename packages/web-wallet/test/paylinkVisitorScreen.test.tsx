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
/** What the bell was handed: how it opens entries, and which it shows. */
const bell: {
  openEntry?: (entry: unknown) => (() => void) | null
  scope?: { entry: (entry: unknown) => boolean; operation: (id: string) => boolean }
} = {}
const stashClaimLink = vi.fn()
const fireEvent = vi.fn()

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
/** Whether the link's ticket signup already has a registration or a saved account. */
const resumable = { value: false }
vi.mock("../src/features/paylink/ticketContinuation", () => ({
  ticketSignupCommitted: () => committed.value,
  ticketSignupResumable: () => resumable.value,
}))
/** L2 tip seconds; undefined = the clock has not been read. Links default to an open window. */
const chain: { now: number | undefined } = { now: 1_000 }
vi.mock("../src/features/paylink/chainTime", () => ({ usePolledChainSeconds: () => chain.now }))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
const aztec: { obsidionWallet?: { node: unknown } } = {}
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => aztec,
}))
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }))
vi.mock("../src/features/paylink/ClaimProgressModal", () => ({
  ClaimProgressModal: ({ record }: { record: { localId: string } }) => (
    <div data-testid="receipt">{record.localId}</div>
  ),
  hasClaimReceipt: (record: { phase: string }) => record.phase === "done",
}))
vi.mock("../src/features/notifications/NotificationsMount", () => ({
  NotificationsMount: () => <div data-testid="producers" />,
}))
vi.mock("../src/ui/NotificationsBell", () => ({
  NotificationsBell: (props: typeof bell) => {
    Object.assign(bell, props)
    return <div data-testid="bell" />
  },
}))
vi.mock("../src/lib/analytics", () => ({ fireEvent }))
vi.mock("../src/features/paylink/paylinkExit", () => ({ cashOutLink: vi.fn() }))
vi.mock("../src/ui/screens/WithdrawalDetailModal", () => ({
  withdrawalStatus: () => ({ label: "Releasing on Ethereum", badge: "pending" }),
}))
vi.mock("../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({
    actions,
    children,
  }: {
    actions?: React.ReactNode
    children?: React.ReactNode
  }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
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
  ClaimToL1Modal: ({
    onClose,
    onClaimInstead,
  }: {
    onClose: () => void
    onClaimInstead?: () => void
  }) => (
    <div data-testid="cash-out">
      <button onClick={onClose}>close</button>
      {onClaimInstead && <button onClick={onClaimInstead}>claim instead</button>}
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
const { getOperationStore } = await import("../src/features/operations/operations")
const { provingProgress } = await import("@obsidion/proving-progress")

const link = (over: Record<string, unknown> = {}) =>
  ({
    url: "http://test/link#frag",
    fragment: "frag",
    amount: "25",
    status: "unclaimed",
    flavor: "direct",
    claimableFrom: 0,
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
  resumable.value = false
  offer.value = null
  offer.failed = false
  voucher.error = undefined
  voucher.uses = 0
  voucher.deps = { _id: "deps" }
  withdrawal.record = undefined
  bell.openEntry = undefined
  bell.scope = undefined
  chain.now = 1_000
  delete aztec.obsidionWallet
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

type Props = Parameters<typeof PaylinkVisitorScreen>[0]
const render = (props: Omit<Props, "onRetryStatus"> & Partial<Props>) =>
  act(() => root.render(<PaylinkVisitorScreen onRetryStatus={vi.fn()} {...props} />))

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
      // No ticket on offer: the visitor turned down only a paid account.
      expect(fireEvent).toHaveBeenCalledWith("paylink_visitor_chose", {
        choice: "ethereum",
        ticket: false,
      })

      act(() => button("close")!.click())
      expect(testId("cash-out")).toBeNull()
      expect(button("Claim to an Ethereum wallet")).toBeTruthy()
    },
  )

  it("withholds the Ethereum claim until its window is known to be open", () => {
    voucher.uses = 1
    chain.now = undefined
    render({ link: link() })
    expect(button("Claim to an Ethereum wallet")?.disabled).toBe(true)

    chain.now = 1_000
    render({ link: link({ claimableFrom: 1_000 }) })
    expect(button("Claim to an Ethereum wallet")?.disabled).toBe(true)
    expect(button("Claim to an Ethereum wallet")?.textContent).toContain("Ready to claim in 0:30")

    render({ link: link({ claimableFrom: 970 }) })
    expect(button("Claim to an Ethereum wallet")?.disabled).toBe(false)
  })

  it("counts down on the device clock to the block that opens the claim", async () => {
    vi.useFakeTimers()
    try {
      // 72s slots from genesis 0; the device clock reads 1000.
      vi.setSystemTime(1_000_000)
      aztec.obsidionWallet = {
        node: { getL1Constants: async () => ({ l1GenesisTime: 0n, slotDuration: 72 }) },
      }
      voucher.uses = 1
      chain.now = 1_008
      const at = () => render({ link: link({ claimableFrom: 1_100 }) })
      const eth = () => button("Claim to an Ethereum wallet")!
      await act(async () => at())
      // Opens at 1130: the slot-16 block (1152). How early it lands is not known yet.
      expect(eth().textContent).toContain("Ready to claim in about 2:32")
      act(() => vi.advanceTimersByTime(52_000))
      expect(eth().textContent).toContain("Ready to claim in about 1:40")
      // The slot-15 block lands 28s before its timestamp: the opening block will too.
      chain.now = 1_080
      at()
      expect(eth().textContent).toContain("Ready to claim in 1:12")
      expect(eth().textContent).not.toContain("about")
      act(() => vi.advanceTimersByTime(72_000))
      expect(eth().textContent).toContain("Ready to claim any moment now")
      expect(eth().disabled).toBe(true)
      chain.now = 1_152
      at()
      expect(eth().disabled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("offers a re-read when the status read ended without the claim window", () => {
    voucher.uses = 1
    const onRetryStatus = vi.fn()
    render({ link: link({ claimableFrom: undefined }), onRetryStatus })
    act(() => button("Claim to an Ethereum wallet")!.click())
    expect(onRetryStatus).toHaveBeenCalledOnce()
    expect(testId("cash-out")).toBeNull()
  })

  it("reports the Ethereum choice without a ticket flag while the offer is unknown", () => {
    voucher.uses = 1
    offer.value = undefined
    render({ link: link() })
    act(() => button("Claim to an Ethereum wallet")!.click())
    expect(fireEvent).toHaveBeenCalledWith("paylink_visitor_chose", { choice: "ethereum" })
  })

  it("reports a turned-down free account on the Ethereum choice", () => {
    voucher.uses = 1
    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link() })
    act(() => button("Claim to an Ethereum wallet")!.click())
    expect(fireEvent).toHaveBeenCalledWith("paylink_visitor_chose", {
      choice: "ethereum",
      ticket: true,
    })
  })

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
    // The link pays fees out of the payment, so the option promises privacy and speed, never "free".
    expect(container.textContent).toContain("Instant. Your balance stays private.")
    expect(container.textContent).not.toContain("Free and instant")

    act(() => button("Receive to zk.money")!.click())

    expect(stashTicketSignup).toHaveBeenCalledWith({
      fragment: "frag",
      threshold: "1",
      schedule: { fee: "5", minDeposit: "0" },
      memo: "Pizza dinner",
      // The page's own read of the note, in base units, so the signup's split is priced at once.
      amount: (25n * 10n ** 18n).toString(),
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

  it("with a ticket on offer, the account option waits for the voucher read; a signup then keeps its page", () => {
    voucher.uses = undefined
    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link() })
    // The ticket's claim is paid by the voucher, so the option promises nothing before the read.
    expect(button("Receive to zk.money")?.disabled).toBe(true)
    expect(container.textContent).toContain("Checking what this link pays for")
    act(() => button("Receive to zk.money")!.click())
    expect(testId("ticket-signup")).toBeNull()

    voucher.uses = 1
    render({ link: link() })
    expect(button("Receive to zk.money")?.disabled).toBe(false)
    expect(container.textContent).toContain("Instant. Your balance stays private.")
    act(() => button("Receive to zk.money")!.click())
    expect(testId("ticket-signup")).toBeTruthy()
    expect(stashTicketSignup).toHaveBeenCalledOnce()

    // A read that later answers none does not swap the wizard under the visitor.
    voucher.uses = 0
    render({ link: link() })
    expect(testId("ticket-signup")).toBeTruthy()
    expect(testId("signup")).toBeNull()
    expect(clearTicketSignup).not.toHaveBeenCalled()
  })

  it("a spent voucher opens the ordinary signup even with a ticket on offer", () => {
    voucher.uses = 0
    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link() })
    expect(testId("signup")).toBeTruthy()
    expect(testId("ticket-signup")).toBeNull()
    expect(stashTicketSignup).not.toHaveBeenCalled()
    expect(fireEvent).not.toHaveBeenCalledWith("paylink_visitor_chose", expect.anything())
  })

  it("a failed voucher read with a ticket on offer retries from the account option", () => {
    voucher.uses = undefined
    voucher.error = "Could not check withdrawal availability"
    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link() })
    expect(button("Receive to zk.money")?.disabled).toBe(false)
    expect(container.textContent).toContain("Couldn't check what this link pays for")
    act(() => button("Receive to zk.money")!.click())
    expect(voucher.retry).toHaveBeenCalledOnce()
    expect(testId("signup")).toBeNull()
    expect(testId("ticket-signup")).toBeNull()
    expect(stashTicketSignup).not.toHaveBeenCalled()
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
    expect(container.textContent).not.toContain("Instant. Your balance")
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
    expect(container.textContent).not.toContain("Instant. Your balance")
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

  describe("the ticket's threshold, checked before the signup starts", () => {
    const ONE = 10n ** 18n
    const ticketOffer = (threshold: bigint) => ({
      threshold: threshold.toString(),
      schedule: { fee: "5", minDeposit: "0" },
    })
    /** Nothing a ticket signup starts with happened. */
    const nothingStarted = () => {
      expect(stashTicketSignup).not.toHaveBeenCalled()
      expect(clearTicketSignup).not.toHaveBeenCalled()
      expect(fireEvent).not.toHaveBeenCalledWith("paylink_visitor_chose", expect.anything())
      expect(testId("ticket-signup")).toBeNull()
      expect(testId("signup")).toBeNull()
    }

    it("a note below the threshold keeps the ticket signup shut and names the minimum", () => {
      voucher.uses = 1
      offer.value = ticketOffer(30n * ONE)
      render({ link: link() })
      const account = button("Receive to zk.money")!
      expect(account.disabled).toBe(true)
      expect(account.textContent).toContain(
        "This payment is below the $30 minimum for a new account.",
      )
      expect(account.textContent).not.toContain("Instant. Your balance")
      act(() => account.click())
      nothingStarted()

      // The Ethereum claim is still there, without a way back into the signup.
      expect(button("Claim to an Ethereum wallet")?.disabled).toBe(false)
      act(() => button("Claim to an Ethereum wallet")!.click())
      expect(testId("cash-out")).toBeTruthy()
      expect(button("claim instead")).toBeUndefined()
    })

    it.each([
      ["one wei below", 25n * ONE + 1n, false],
      ["exactly at", 25n * ONE, true],
      ["above", 25n * ONE - 1n, true],
    ] as const)(
      "a $25 note %s the threshold may start the ticket signup: %s",
      (_, threshold, ok) => {
        voucher.uses = 1
        offer.value = ticketOffer(threshold)
        render({ link: link() })
        expect(button("Receive to zk.money")?.disabled).toBe(!ok)
        act(() => button("Receive to zk.money")!.click())
        if (!ok) return nothingStarted()
        expect(stashTicketSignup).toHaveBeenCalledWith(
          expect.objectContaining({
            threshold: threshold.toString(),
            amount: (25n * ONE).toString(),
          }),
        )
        expect(testId("ticket-signup")).toBeTruthy()
      },
    )

    it("waits for the note's amount, then retries the status read that stopped without it", () => {
      voucher.uses = 1
      offer.value = ticketOffer(ONE)
      const onRetryStatus = vi.fn()
      const unread = link({ amount: undefined, claimableFrom: undefined })
      render({ link: unread, statusSettled: false, onRetryStatus })
      const account = () => button("Receive to zk.money")!
      expect(account().disabled).toBe(true)
      expect(account().textContent).toContain("Checking what this link pays for")
      expect(account().querySelector('[data-testid="spinner"]')).toBeTruthy()
      act(() => account().click())
      nothingStarted()

      render({ link: unread, statusSettled: true, onRetryStatus })
      expect(account().disabled).toBe(false)
      expect(account().textContent).toContain("Couldn't check what this link pays for")
      act(() => account().click())
      expect(onRetryStatus).toHaveBeenCalledOnce()
      nothingStarted()

      render({ link: link(), onRetryStatus })
      act(() => account().click())
      expect(stashTicketSignup).toHaveBeenCalledOnce()
      expect(testId("ticket-signup")).toBeTruthy()
    })

    it("the cash-out's way back to an account starts nothing on an unread amount", () => {
      voucher.uses = 1
      offer.value = ticketOffer(ONE)
      render({ link: link({ amount: undefined }), statusSettled: false })
      act(() => button("Claim to an Ethereum wallet")!.click())
      act(() => button("claim instead")!.click())
      expect(stashTicketSignup).not.toHaveBeenCalled()
      expect(fireEvent).not.toHaveBeenCalledWith("paylink_visitor_chose", {
        choice: "account",
        ticket: true,
      })
      expect(testId("ticket-signup")).toBeNull()
      expect(testId("cash-out")).toBeTruthy()
    })

    it.each([
      ["below the threshold", link()],
      ["not read", link({ amount: undefined })],
    ])(
      "a link whose ticket signup already bound an account resumes it with the note %s",
      (_, open) => {
        voucher.uses = 1
        offer.value = ticketOffer(30n * ONE)
        resumable.value = true
        render({ link: open })
        expect(button("Receive to zk.money")?.disabled).toBe(false)
        act(() => button("Receive to zk.money")!.click())
        expect(stashTicketSignup).toHaveBeenCalledOnce()
        expect(testId("ticket-signup")).toBeTruthy()
      },
    )

    it("without tickets on offer the ordinary signup needs no amount", () => {
      voucher.uses = 1
      offer.value = null
      render({ link: link({ amount: undefined }), statusSettled: false })
      expect(button("Receive to zk.money")?.disabled).toBe(false)
      act(() => button("Receive to zk.money")!.click())
      expect(clearTicketSignup).toHaveBeenCalledOnce()
      expect(stashTicketSignup).not.toHaveBeenCalled()
      expect(testId("signup")).toBeTruthy()
    })

    it("a voucherless link below the threshold still opens the ordinary signup", () => {
      voucher.uses = 0
      offer.value = ticketOffer(30n * ONE)
      render({ link: link() })
      expect(testId("signup")).toBeTruthy()
      expect(stashTicketSignup).not.toHaveBeenCalled()
    })
  })

  it("without a ticket offer the account option promises privacy, not a free tag", () => {
    voucher.uses = 1
    offer.value = null
    render({ link: link() })
    expect(container.textContent).not.toContain("Instant. Your balance")
    expect(container.textContent).toContain("Create an account to receive it")
  })

  it("withholds the cash-out until the enclave co-signer is connected", () => {
    voucher.uses = 1
    voucher.deps = undefined
    render({ link: link() })

    expect(button("Claim to an Ethereum wallet")!.hasAttribute("disabled")).toBe(true)
    expect(container.textContent).toContain("Connecting…")
  })

  it("captions the Ethereum claim without quoting a fee", () => {
    voucher.uses = 1
    render({ link: link() })

    expect(container.textContent).toContain("Slower. Public onchain payment.")
    expect(container.textContent).not.toMatch(/fee/i)
  })

  it.each([
    ["claimed", "This link is no longer available"],
    ["expired", "This link has expired"],
  ] as const)("says a %s link is closed, and offers nothing to do", (status, title) => {
    voucher.uses = 0
    render({ link: link({ status }) })

    expect(container.textContent).toContain(title)
    expect(button("Claim to an Ethereum wallet")).toBeUndefined()
    expect(button("Receive to zk.money")).toBeUndefined()
  })

  it("tells the holder who cashed it out that the money is theirs and moving", () => {
    // The escrow is spent, so the chain reads "claimed" — which about their own withdrawal would
    // say someone else took it.
    voucher.uses = 0
    withdrawal.record = {
      recipient: `0x${"dd".repeat(20)}`,
      phase: "finalizing_l1",
      l2TxHash: `0x${"0a".repeat(32)}`,
    }
    render({ link: link({ status: "claimed" }) })

    expect(container.textContent).toContain("You withdrew")
    expect(container.textContent).toContain("Releasing on Ethereum")
    expect(container.textContent).toContain("Ethereum releases the funds on its own")
    expect(container.textContent).not.toContain("already claimed")
    expect(testId("signup")).toBeNull()
    // The page is the row: no sheet waits on the chain over it.
    expect(testId("receipt")).toBeNull()
    expect(button("View receipt")).toBeUndefined()
    expect(testId("bell")).toBeTruthy()
  })

  it("names the amount off the withdrawal once the spent escrow can't say it", () => {
    // A reload reads the spent note, which no longer carries an amount. The record's `amount` is
    // net of the fee; the page keeps the link's figure.
    voucher.uses = 0
    withdrawal.record = {
      recipient: `0x${"dd".repeat(20)}`,
      amount: "24.65",
      rawAmount: (25n * 10n ** 18n).toString(),
      phase: "finalizing_l1",
      l2TxHash: `0x${"0a".repeat(32)}`,
    }
    render({ link: link({ status: "claimed", amount: undefined }) })

    expect(container.textContent).toContain("You withdrew")
    expect(container.textContent).toContain("$25")
    expect(container.textContent).not.toContain("$24.65")
  })

  it("promises Ethereum's release only once the burn is sent", () => {
    voucher.uses = 0
    withdrawal.record = { recipient: `0x${"dd".repeat(20)}`, phase: "submitting" }
    render({ link: link({ status: "claimed" }) })

    expect(container.textContent).toContain("You withdrew")
    expect(container.textContent).not.toContain("Ethereum releases")
  })

  it("says on the page whether it may close, off the cash-out's operation", async () => {
    const store = getOperationStore()
    await store.begin({
      operationId: "op-visit",
      flow: "paylink-claim-l1",
      summary: "$5",
      scope: null,
    })
    voucher.uses = 0
    withdrawal.record = {
      localId: "w1",
      recipient: `0x${"dd".repeat(20)}`,
      phase: "submitting",
      operationId: "op-visit",
    }
    render({ link: link({ status: "claimed" }) })
    expect(container.textContent).toContain("Keep this page open until it's sent")

    await act(async () => {
      provingProgress.emitTxHashSaved("op-visit", `0x${"cd".repeat(32)}`)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(container.textContent).toContain("Sent · You can close this page")
    store.release("op-visit")
    await store.remove("op-visit")
  })

  it("an ended cash-out opens its receipt from the page and from the bell", () => {
    voucher.uses = 0
    withdrawal.record = { localId: "w1", recipient: `0x${"dd".repeat(20)}`, phase: "done" }
    render({ link: link({ status: "claimed" }) })
    expect(testId("producers")).toBeTruthy()

    act(() => button("View receipt")!.click())
    expect(testId("receipt")?.textContent).toBe("w1")
    act(() =>
      root.render(
        <PaylinkVisitorScreen link={link({ status: "claimed" })} onRetryStatus={() => {}} />,
      ),
    )

    const own = { target: { type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId: "w1" } }
    expect(bell.openEntry!(own)).toBeTypeOf("function")
  })

  it("the bell shows this link's cash-out only: a shared browser's other entries stay out", () => {
    voucher.uses = 0
    withdrawal.record = {
      localId: "w1",
      operationId: "op-mine",
      recipient: `0x${"dd".repeat(20)}`,
      phase: "finalizing_l1",
    }
    render({ link: link({ status: "claimed" }) })
    const withdrawalEntry = (sourceId: string) => ({
      id: `bridge:withdrawal:${sourceId}`,
      target: { type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId },
    })
    const scope = bell.scope!
    expect(scope.entry(withdrawalEntry("w1"))).toBe(true)
    expect(scope.entry({ id: "operation:op-mine", target: { type: "transfer.pending" } })).toBe(
      true,
    )
    // Another visitor's cash-out on this browser, and everything that is not this cash-out.
    expect(scope.entry(withdrawalEntry("w0"))).toBe(false)
    expect(scope.entry({ id: "operation:op-other", target: { type: "transfer.pending" } })).toBe(
      false,
    )
    expect(
      scope.entry({
        id: "bridge:deposit:0xsipa",
        target: { type: "bridge.txDetail", bridgeKind: "deposit", sourceId: "w1" },
      }),
    ).toBe(false)
    expect(
      scope.entry({ id: "transfer:receive:0xabc", target: { type: "transfer.txDetail" } }),
    ).toBe(false)
    expect(scope.operation("op-mine")).toBe(true)
    expect(scope.operation("op-other")).toBe(false)
  })

  it("with no cash-out of this link, the bell shows nothing", () => {
    render({ link: link() })
    const scope = bell.scope!
    expect(
      scope.entry({
        id: "bridge:withdrawal:w0",
        target: { type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId: "w0" },
      }),
    ).toBe(false)
    expect(scope.operation("op-any")).toBe(false)
    expect(bell.openEntry!({ target: { type: "transfer.pending" } })).toBeNull()
  })
})
