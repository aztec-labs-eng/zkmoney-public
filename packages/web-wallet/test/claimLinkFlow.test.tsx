import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { provingProgress } from "@obsidion/proving-progress"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { PAYLINK_NOT_CLAIMABLE_YET_MESSAGE } from "../src/features/paylink/claimWindow"
import { asOperation, endSigningAndHandOff } from "./support/handOff"

vi.mock("../src/features/operations/operations", async () =>
  (await import("./support/fakeOperations")).fakeOperationsModule(),
)
vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  ),
  GradientSpinner: () => <i data-icon="spinner" />,
  Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
}))

const isWindowRevert = vi.fn((_e: unknown) => false)
vi.mock("@obsidion/front-core", async () => {
  // The ticket quote is core's real arithmetic under front-core's tips; the wallet runtime around
  // it is stubbed, since this suite's sdk mock carries none of it.
  const {
    GOLDEN_TICKET_BRIDGE_REMAINDER,
    GOLDEN_TICKET_PROVER_TIP,
    goldenTicketQuote,
    WITHDRAW_RELAYER_TIP,
  } = await import("@obsidion/core/constants")
  const goldenTicketBurn = (
    schedule: { fee: bigint; min: bigint },
    cuts: { withdrawalCut: bigint; depositCut: bigint },
  ) =>
    goldenTicketQuote(schedule, {
      ...cuts,
      relayerTip: WITHDRAW_RELAYER_TIP,
      proverTip: GOLDEN_TICKET_PROVER_TIP,
      bridgeRemainder: GOLDEN_TICKET_BRIDGE_REMAINDER,
    })
  return {
    goldenTicketBurn,
    goldenTicketCoverage: (
      noteAmount: bigint,
      schedule: { fee: bigint; min: bigint },
      cuts: { withdrawalCut: bigint; depositCut: bigint },
    ) => {
      const quote = goldenTicketBurn(schedule, cuts)
      const immediate = noteAmount - quote.burn
      return {
        ...quote,
        noteAmount,
        immediate,
        eventual: immediate + quote.returned,
        covers: noteAmount > quote.burn,
      }
    },
    isPaylinkWindowRevert: (e: unknown) => isWindowRevert(e),
    useAztecContext: () => aztec,
    useContractServiceContext: () => contracts,
    formatDateLabel: () => "Today",
    formatTimeLabel: () => "14:32",
    TxInFlightError: class TxInFlightError extends Error {
      constructor(readonly txHash: string, cause?: unknown) {
        super(cause instanceof Error ? cause.message : String(cause))
      }
    },
  }
})

// Status deps: set by the tests that need the note read; empty means viewLink never runs.
const aztec: { obsidionWallet?: unknown } = {}
const contracts: { contractService?: unknown } = {}
type Stage = (s: string) => void
const decodeLink = vi.fn()
const viewLink = vi.fn()
const claimSponsoredLink = vi.fn(
  async (_deps: unknown, _fragment: string, _setStage: Stage, _proof?: unknown) => "0xclaimtx",
)
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({
  decodeLink: (f: string) => decodeLink(f),
  viewLink: (...a: unknown[]) => viewLink(...a),
  claimSponsoredLink: asOperation(
    (...a: Parameters<typeof claimSponsoredLink>) => claimSponsoredLink(...a),
    "paylink-claim",
  ),
}))
const obtainEmailClaimProof = vi.fn(
  async (_account: unknown, _params: unknown, _s: Stage) => "proof",
)
// The withdraw-to-Ethereum modal pulls in the notifications panel and web storage; out of scope here.
vi.mock("../src/features/paylink/ClaimToL1Modal", () => ({ ClaimToL1Modal: () => null }))

vi.mock("../src/features/paylink/emailClaim", () => ({
  obtainEmailClaimProof: (...a: Parameters<typeof obtainEmailClaimProof>) =>
    obtainEmailClaimProof(...a),
}))
const chainNowRef: { now: number | undefined } = { now: undefined }
vi.mock("../src/features/paylink/chainTime", () => ({
  usePolledChainSeconds: () => chainNowRef.now,
}))
let paylinkDeps: unknown
vi.mock("../src/features/paylink/usePaylinkDeps", () => ({
  usePaylinkDeps: () => paylinkDeps,
}))
const clearClaimStash = vi.fn()
vi.mock("../src/features/paylink/claimStash", () => ({
  clearClaimStash: (fragment?: string) => clearClaimStash(fragment),
}))
/** The ticket signup this account left at its review, or null for an ordinary claim. */
const continuation: { value: unknown } = { value: null }
const ticketSignupContinuation = vi.fn(
  (_fragment: string, _l2: string | undefined, _withdrawals: unknown) => continuation.value,
)
vi.mock("../src/features/paylink/ticketContinuation", () => ({
  ticketSignupContinuation: (f: string, l2: string | undefined, w: unknown) =>
    ticketSignupContinuation(f, l2, w),
  ticketHoldNotice: (state: string, tag: string) =>
    state === "blocked"
      ? "this payment's ticket did not waive the tag price"
      : state === "renew"
      ? `The reservation for @${tag} needs a fresh quote`
      : state === "unpublished"
      ? "Your deposit address is not published yet"
      : state === "submitted"
      ? "This payment is already claimed"
      : undefined,
}))
const withdrawals: { list: unknown[] } = { list: [] }
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => ({ list: () => withdrawals.list }),
}))
const navigate = vi.fn()
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }))
vi.mock("../src/features/onboarding/registrationTerms", () => ({
  useDepositSkim: () => 5n,
  useSweepDeductions: () => ({ skim: 0n, fpcCut: 10n }),
}))
vi.mock("../src/features/onboarding/steps/ClaimReviewStep", () => ({
  ClaimReviewStep: ({
    quote,
    memo,
    error,
    notices,
    claimable = true,
    onClaim,
    onClose,
  }: {
    quote: { paylink?: bigint; youReceive?: bigint; slice: bigint }
    memo?: string
    error?: string
    notices?: React.ReactNode
    claimable?: boolean
    onClaim: () => void
    onClose: () => void
  }) => (
    <div data-testid="claim-review">
      <span>{`paylink ${quote.paylink} receive ${quote.youReceive} slice ${quote.slice}`}</span>
      {memo && <span>{memo}</span>}
      {error && <span role="alert">{error}</span>}
      {notices}
      <button onClick={onClose}>Close</button>
      <button disabled={!claimable} onClick={onClaim}>
        Claim
      </button>
    </div>
  ),
}))
vi.mock("@obsidion/sdk", () => ({
  EmailMismatchError: class EmailMismatchError extends Error {
    constructor(opts?: { lockedTo?: string }) {
      super(`This link is locked to ${opts?.lockedTo}. Sign in with that account and try again.`)
    }
  },
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox", nodeUrl: "http://node" }),
}))
vi.mock("../src/lib/explorer", () => ({
  l2TxUrl: (_n: string, _u: string, hash: string) => `https://explorer/${hash}`,
}))
const showErrorModal = vi.fn()
const showReportableError = vi.fn()
vi.mock("../src/errors/errorModal", () => ({
  showErrorModal: (...a: unknown[]) => showErrorModal(...a),
  showReportableError: (...a: unknown[]) => showReportableError(...a),
}))
vi.mock("../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "x" }))

const { useClaimLinkFlow, resetRunningClaimsForTests } = await import(
  "../src/features/paylink/useClaimLinkFlow"
)
const { EmailMismatchError } = await import("@obsidion/sdk")
const { TxInFlightError } = (await import("@obsidion/front-core")) as unknown as {
  TxInFlightError: new (txHash: string, cause?: unknown) => Error
}

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const directLink = {
  url: "https://wallet/link#frag",
  fragment: "frag",
  amount: "100",
  status: "unclaimed",
  flavor: "direct",
  txHash: "0x0093c3aabbccddee",
}
const emailLink = { ...directLink, flavor: "email", email: "satoshi@gmail.com", commitment: "0x2a" }
const emailLock = {
  paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
  email: "satoshi@gmail.com",
  commitment: "0x2a",
}

function Harness({ fragment, onDone }: { fragment: string | null; onDone: () => void }) {
  return <div>{useClaimLinkFlow(fragment, onDone).modal}</div>
}

describe("useClaimLinkFlow", () => {
  let container: HTMLDivElement
  let root: Root
  const onDone = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    decodeLink.mockReturnValue(directLink)
    delete aztec.obsidionWallet
    delete contracts.contractService
    claimSponsoredLink.mockImplementation(async () => "0xclaimtx")
    paylinkDeps = undefined
    chainNowRef.now = undefined
    isWindowRevert.mockReturnValue(false)
    continuation.value = null
    resetRunningClaimsForTests()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const button = (title: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === title)

  async function render(fragment: string | null = "frag") {
    await act(async () => {
      root.render(<Harness fragment={fragment} onDone={onDone} />)
    })
  }

  it("renders the direct flavor with Decline / Accept and the funding tx", async () => {
    await render()
    expect(container.textContent).toContain("Unclaimed")
    expect(container.textContent).toContain("$100")
    expect(container.textContent).toContain("Claim your payment")
    expect(container.textContent).toContain("Accept to receive funds in your account")
    expect(button("Decline")).toBeDefined()
    expect(button("Accept")).toBeDefined()
    expect(container.textContent).toContain("Today, 14:32")
    const link = container.querySelector<HTMLAnchorElement>("a.ww-request-detail__hash")
    expect(link?.href).toBe("https://explorer/0x0093c3aabbccddee")
  })

  // The fragment's amount is unsigned text; only the escrow note's figure is ever shown.
  it("shows no amount until the escrow note is read", async () => {
    decodeLink.mockReturnValue({ ...directLink, amount: undefined })
    let resolveView: (v: unknown) => void = () => {}
    viewLink.mockReturnValue(new Promise((r) => (resolveView = r)))
    aztec.obsidionWallet = {}
    contracts.contractService = {}
    await render()
    expect(container.textContent).not.toContain("$")
    expect(button("Accept")).toBeDefined()
    await act(async () => resolveView({ ...directLink, amount: "5" }))
    expect(container.textContent).toContain("$5")
  })

  it("shows a countdown instead of Accept while the grace window is open", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    chainNowRef.now = 1_800_000_000
    decodeLink.mockReturnValue({ ...directLink, claimableFrom: 1_800_000_100 })
    await render()
    expect(container.textContent).toContain("Ready to claim in 2:10")
    expect(button("Accept")).toBeUndefined()
    expect(claimSponsoredLink).not.toHaveBeenCalled()
  })

  it("holds Accept until chain time is known on a link with a grace window", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    chainNowRef.now = undefined
    decodeLink.mockReturnValue({ ...directLink, claimableFrom: 1_800_000_100 })
    await render()
    expect(button("Accept")).toBeUndefined()
    expect(button("Checking…")).toBeDefined()
    await act(async () => button("Checking…")?.click())
    expect(claimSponsoredLink).not.toHaveBeenCalled()
  })

  it("offers Accept once chain time clears from_claimable plus the margin", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    chainNowRef.now = 1_800_000_130
    decodeLink.mockReturnValue({ ...directLink, claimableFrom: 1_800_000_100 })
    await render()
    expect(button("Accept")).toBeDefined()
    expect(container.textContent).not.toContain("Ready to claim in")
  })

  it("Decline clears the stash and hands control back without claiming", async () => {
    await render()
    await act(async () => button("Decline")?.click())
    expect(onDone).toHaveBeenCalledOnce()
    expect(clearClaimStash).toHaveBeenCalledOnce()
    expect(claimSponsoredLink).not.toHaveBeenCalled()
  })

  it("renders the email flavor with Google as the only sign-in", async () => {
    decodeLink.mockReturnValue({
      ...directLink,
      flavor: "email",
      email: "satoshi@gmail.com",
      // The Google button waits for the escrow read; a commitment marks it done.
      commitment: "0x1",
    })
    await render()
    expect(container.textContent).toContain(
      "Confirm satoshi@gmail.com to securely receive funds in your account",
    )
    expect(button("Claim with Google")).toBeDefined()
    // Apple sign-in has no web flow yet; a button that can only say "not available" is not offered.
    expect(button("Claim with Apple")).toBeUndefined()
    expect(claimSponsoredLink).not.toHaveBeenCalled()
  })

  it("hands off to the bell once the passkey ceremony ends", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    let resolveClaim!: (hash: string) => void
    claimSponsoredLink.mockImplementation(
      async (_deps: unknown, _fragment: string, advance: Stage) => {
        advance("building")
        advance("proving")
        return new Promise<string>((r) => {
          resolveClaim = r
        })
      },
    )

    await render()
    await act(async () => button("Accept")?.click())
    // The sheet holds the user through the beats that need them (never the proof); the row
    // mirrors each stage.
    expect(container.textContent).toContain("Preparing transaction...")
    expect(container.textContent).not.toContain("Proving")
    expect(container.textContent).toContain("Don't close this screen")
    expect(container.textContent).not.toContain("Claim your payment")
    expect(onDone).not.toHaveBeenCalled()

    await act(async () => provingProgress.emitSigningStart())
    expect(container.textContent).toContain("Confirm with passkey")
    await endSigningAndHandOff()
    expect(onDone).toHaveBeenCalledOnce()

    // The proof finishes under the bell; the operation settles on the tx.
    await act(async () => root.render(<Harness fragment={null} onDone={onDone} />))
    await act(async () => resolveClaim("0xclaimtx"))
    expect(clearClaimStash).toHaveBeenCalledOnce()
    expect(onDone).toHaveBeenCalledOnce()
  })

  it("a claim that never signs hands off when it lands", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    await render()
    await act(async () => button("Accept")?.click())
    await act(async () => new Promise((r) => setTimeout(r)))
    expect(onDone).toHaveBeenCalledOnce()
    expect(clearClaimStash).toHaveBeenCalledOnce()
  })

  it("a second Accept in the same batch does not start a second claim", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    let resolveClaim!: (hash: string) => void
    claimSponsoredLink.mockImplementation(
      () =>
        new Promise<string>((r) => {
          resolveClaim = r
        }),
    )
    await render()
    await act(async () => {
      button("Accept")?.click()
      button("Accept")?.click()
    })
    expect(claimSponsoredLink).toHaveBeenCalledOnce()
    await act(async () => resolveClaim("0xclaimtx"))
  })

  it("a remount during an in-flight claim shows nothing instead of re-prompting", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    let resolveClaim!: (hash: string) => void
    let advance!: Stage
    claimSponsoredLink.mockImplementation(
      (_deps: unknown, _fragment: string, onStage: Stage) =>
        new Promise<string>((r) => {
          advance = onStage
          resolveClaim = r
        }),
    )
    await render()
    await act(async () => button("Accept")?.click())
    await act(async () => advance("building"))
    expect(container.textContent).toContain("Preparing transaction...")

    // Leave Home and come back while the stash still holds the fragment.
    await act(async () => root.unmount())
    root = createRoot(container)
    onDone.mockClear()
    await render()
    expect(button("Accept")).toBeUndefined()
    expect(container.textContent).not.toContain("Claiming payment")
    expect(onDone).toHaveBeenCalledOnce()

    // The original call keeps feeding the row.
    await act(async () => advance("submitting"))
    await act(async () => resolveClaim("0xclaimtx"))
    expect(claimSponsoredLink).toHaveBeenCalledOnce()
  })

  it("a claim that outlives its prompt clears only its own stash entry", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    let resolveClaim!: (hash: string) => void
    claimSponsoredLink.mockImplementation(
      async (_deps: unknown, _fragment: unknown, setStage: unknown) => {
        const hash = await new Promise<string>((r) => {
          resolveClaim = r
        })
        ;(setStage as (s: string) => void)("submitting")
        return hash
      },
    )
    await render("fragA")
    await act(async () => button("Accept")?.click())
    expect(container.textContent).toContain("Preparing transaction...")

    // The user lands on another link while A is still proving.
    decodeLink.mockReturnValue({ ...directLink, fragment: "fragB", amount: "7" })
    await render("fragB")
    expect(container.textContent).toContain("$7")
    expect(container.textContent).toContain("Accept to receive funds")

    await act(async () => resolveClaim("0xclaimtx"))
    expect(clearClaimStash).toHaveBeenCalledWith("fragA")
    expect(clearClaimStash).not.toHaveBeenCalledWith("fragB")
    // B's prompt is untouched by A settling.
    expect(container.textContent).not.toContain("Submitting to the network")
    expect(button("Accept")).toBeDefined()
    expect(onDone).not.toHaveBeenCalled()
  })

  it("a claim that fails before the hand-off reopens the prompt behind the failure sheet", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    const failure = new Error("boom")
    claimSponsoredLink.mockRejectedValueOnce(failure)
    await render()
    await act(async () => button("Accept")?.click())
    expect(showReportableError).toHaveBeenCalledWith(failure, "paylink:claim", {
      title: "Claim failed",
      message: "boom",
    })
    expect(showErrorModal).not.toHaveBeenCalled()
    expect(button("Accept")).toBeDefined()
    expect(clearClaimStash).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it("a cached email proof that fails at the claim stage explains itself, and the prompt retries", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    decodeLink.mockReturnValue(emailLink)
    // The proof comes from the cache: no Google or email-proving stage before the claim.
    const failure = new Error("Transaction simulation failed")
    claimSponsoredLink.mockImplementationOnce(async (_deps, _fragment, advance) => {
      advance("building")
      throw failure
    })
    await render()
    await act(async () => button("Claim with Google")?.click())
    expect(obtainEmailClaimProof).toHaveBeenCalledWith(
      "0xme",
      emailLock,
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(claimSponsoredLink).toHaveBeenCalledWith(
      paylinkDeps,
      "frag",
      expect.any(Function),
      "proof",
    )
    expect(showReportableError).toHaveBeenCalledWith(failure, "paylink:claim", {
      title: "Claim failed",
      message: "Transaction simulation failed",
    })
    expect(showErrorModal).not.toHaveBeenCalled()
    expect(button("Claim with Google")).toBeDefined()
    expect(clearClaimStash).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()

    // The same unclaimed link claims again on its cached proof, under a fresh operation.
    await act(async () => button("Claim with Google")?.click())
    await act(async () => new Promise((r) => setTimeout(r)))
    expect(obtainEmailClaimProof).toHaveBeenCalledTimes(2)
    expect(claimSponsoredLink).toHaveBeenCalledTimes(2)
    expect(claimSponsoredLink).toHaveBeenLastCalledWith(
      paylinkDeps,
      "frag",
      expect.any(Function),
      "proof",
    )
    expect(clearClaimStash).toHaveBeenCalledWith("frag")
    expect(onDone).toHaveBeenCalledOnce()
  })

  it("a claim that fails after signing reports through the row alone", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    let rejectClaim!: (e: unknown) => void
    claimSponsoredLink.mockImplementation(async (_deps, _fragment, advance) => {
      advance("building")
      advance("proving")
      return new Promise<string>((_, reject) => {
        rejectClaim = reject
      })
    })
    await render()
    await act(async () => button("Accept")?.click())
    await act(async () => provingProgress.emitSigningStart())
    await endSigningAndHandOff()
    expect(onDone).toHaveBeenCalledOnce()

    // Lands before Home has re-rendered without the fragment: still no prompt, no sheet.
    await act(async () => rejectClaim(new Error("boom")))
    expect(showReportableError).not.toHaveBeenCalled()
    expect(showErrorModal).not.toHaveBeenCalled()
    expect(button("Accept")).toBeUndefined()
    expect(container.textContent).not.toContain("Claim your payment")
    await act(async () => root.render(<Harness fragment={null} onDone={onDone} />))
    expect(container.textContent).toBe("")
    expect(onDone).toHaveBeenCalledOnce()
    expect(clearClaimStash).not.toHaveBeenCalled()
  })

  it("a passkey cancellation restores the prompt with no failure sheet", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    const cancelled = Object.assign(new Error("Cancelled"), { name: "NotAllowedError" })
    claimSponsoredLink.mockRejectedValueOnce(cancelled)
    await render()
    await act(async () => button("Accept")?.click())
    expect(showReportableError).not.toHaveBeenCalled()
    expect(showErrorModal).not.toHaveBeenCalled()
    expect(button("Accept")).toBeDefined()
    expect(onDone).not.toHaveBeenCalled()
  })

  it("an email mismatch keeps its own sheet", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    decodeLink.mockReturnValue(emailLink)
    const mismatch = new EmailMismatchError({ lockedTo: "satoshi@gmail.com" })
    obtainEmailClaimProof.mockRejectedValueOnce(mismatch)
    await render()
    await act(async () => button("Claim with Google")?.click())
    expect(showErrorModal).toHaveBeenCalledWith({
      title: "Email mismatch",
      message: "This link is locked to satoshi@gmail.com. Sign in with that account and try again.",
      context: "paylink:claim",
    })
    expect(showReportableError).not.toHaveBeenCalled()
    expect(claimSponsoredLink).not.toHaveBeenCalled()
    expect(button("Claim with Google")).toBeDefined()
  })

  it("a claim-window revert keeps its own explanation", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    isWindowRevert.mockReturnValue(true)
    claimSponsoredLink.mockRejectedValueOnce(new Error("Assertion failed: not claimable yet"))
    await render()
    await act(async () => button("Accept")?.click())
    expect(showErrorModal).toHaveBeenCalledWith({
      title: "Not claimable yet",
      message: PAYLINK_NOT_CLAIMABLE_YET_MESSAGE,
      context: "paylink:claim",
    })
    expect(showReportableError).not.toHaveBeenCalled()
    expect(button("Accept")).toBeDefined()
  })

  describe("a ticket signup left at its review", () => {
    const ONE = 10n ** 18n
    const ready = {
      stash: {
        fragment: "frag",
        amount: (20n * ONE).toString(),
        memo: "Pizza dinner",
        schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
      },
      record: { phase: "awaiting_deposit", tag: "taga" },
      activation: { state: "ready", schedule: { fee: ONE / 2n, min: 0n } },
    }
    const left = () => {
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      continuation.value = ready
    }
    const held = (state: string) => {
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      continuation.value = { ...ready, activation: { state, stash: ready.stash } }
    }

    it("prompts with the review split, and claims with the registration burn", async () => {
      left()
      withdrawals.list = [{ recipient: "0xsipa", phase: "done" }]
      await render()
      expect(ticketSignupContinuation).toHaveBeenCalledWith("frag", "0xme", withdrawals.list)
      expect(container.querySelector('[data-testid="claim-review"]')).not.toBeNull()
      expect(container.textContent).toContain("Pizza dinner")
      // 20 - (0.5 fee + 10 wei return-deposit cut + 0.01 remainder + 10 wei withdrawal cut + 0.1
      // relayer + 1 prover)
      expect(container.textContent).toContain(`receive ${18_390_000_000_000_000_000n - 20n}`)
      expect(container.textContent).not.toContain("Accept to receive funds")

      await act(async () => button("Claim")!.click())
      expect(claimSponsoredLink).toHaveBeenCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
        { fundRegistration: true },
      )
      await act(async () => new Promise((r) => setTimeout(r)))
      expect(clearClaimStash).toHaveBeenCalledWith("frag")
    })

    it("Close keeps the link stashed: the signup's funding waits for its claim", async () => {
      left()
      await render()
      await act(async () => button("Close")!.click())
      expect(onDone).toHaveBeenCalledOnce()
      expect(clearClaimStash).not.toHaveBeenCalled()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
    })

    it("a signup whose renewed quote the link cannot pay shows the refusal and claims nothing", async () => {
      held("blocked")
      await render()
      expect(container.querySelector('[data-testid="claim-review"]')).not.toBeNull()
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/did not waive/)
      expect(button("Claim")?.disabled).toBe(true)
      expect(button("Accept")).toBeUndefined()
      await act(async () => button("Claim")!.click())
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      await act(async () => button("Close")!.click())
      expect(onDone).toHaveBeenCalledOnce()
      expect(clearClaimStash).not.toHaveBeenCalled()
    })

    it("a lapsed or unpublished signup shows why, offers the registration page, and claims nothing", async () => {
      held("renew")
      await render()
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/fresh quote/)
      expect(button("Claim")?.disabled).toBe(true)
      expect(button("Accept")).toBeUndefined()
      await act(async () => button("Check registration")!.click())
      expect(onDone).toHaveBeenCalledOnce()
      expect(navigate).toHaveBeenCalledWith("/claim/taga")
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(clearClaimStash).not.toHaveBeenCalled()

      held("unpublished")
      await render()
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/not published/)
      expect(button("Claim")?.disabled).toBe(true)
      expect(button("Check registration")).toBeDefined()

      // A burn already on its way: nothing to claim, and no registration page to send to.
      held("submitted")
      await render()
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/already claimed/)
      expect(button("Claim")?.disabled).toBe(true)
      expect(button("Check registration")).toBeUndefined()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
    })

    it("re-reads the signup at the click: terms that lapsed after the render claim nothing", async () => {
      left()
      await render()
      expect(button("Claim")?.disabled).toBe(false)
      continuation.value = { ...ready, activation: { state: "renew", stash: ready.stash } }
      await act(async () => button("Claim")!.click())
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/fresh quote/)
      expect(button("Claim")?.disabled).toBe(true)
    })

    it("a review rebuilt without the signup's own note read takes the amount and memo from the link", async () => {
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      continuation.value = {
        ...ready,
        stash: { fragment: "frag", schedule: ready.stash.schedule },
      }
      decodeLink.mockReturnValue({ ...directLink, amount: "20", memo: "From the link" })
      await render()
      expect(container.textContent).toContain("From the link")
      expect(container.textContent).toContain(`receive ${18_390_000_000_000_000_000n - 20n}`)
    })

    it("a link this account's signup did not leave claims the ordinary way", async () => {
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      await render()
      expect(container.querySelector('[data-testid="claim-review"]')).toBeNull()
      await act(async () => button("Accept")!.click())
      expect(claimSponsoredLink).toHaveBeenCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
      )
    })
  })

  // The stash exists to re-offer Accept after a reload. A claim the node already has must leave
  // it, or the reload offers to spend a note this wallet has spent.
  it("a claim left in flight clears its stash and hands off", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    claimSponsoredLink.mockRejectedValueOnce(new TxInFlightError("0xclaim", new Error("offline")))
    await render()
    await act(async () => button("Accept")?.click())
    expect(clearClaimStash).toHaveBeenCalled()
    expect(showReportableError).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
  })

  it("an already-claimed link offers no claim actions", async () => {
    decodeLink.mockReturnValue({ ...directLink, status: "claimed" })
    await render()
    expect(container.textContent).toContain("This link has been used")
    expect(button("Accept")).toBeUndefined()
    expect(button("Go to wallet")).toBeDefined()
  })

  it("closes itself when the fragment does not decode", async () => {
    decodeLink.mockImplementation(() => {
      throw new Error("bad fragment")
    })
    await render()
    expect(onDone).toHaveBeenCalled()
    expect(clearClaimStash).toHaveBeenCalled()
  })
})
