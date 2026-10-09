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
  Shimmer: ({ children }: { children: React.ReactNode }) => <div data-skeleton>{children}</div>,
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
  const { GOLDEN_TICKET_BRIDGE_REMAINDER, goldenTicketQuote, WITHDRAW_RELAYER_TIP } = await import(
    "@obsidion/core/constants"
  )
  const goldenTicketBurn = (
    schedule: { fee: bigint; min: bigint },
    cuts: { withdrawalCut: bigint; depositCut: bigint },
    proverTip: bigint,
  ) =>
    goldenTicketQuote(schedule, {
      ...cuts,
      relayerTip: WITHDRAW_RELAYER_TIP,
      proverTip,
      bridgeRemainder: GOLDEN_TICKET_BRIDGE_REMAINDER,
    })
  return {
    goldenTicketBurn,
    goldenTicketCoverage: (
      noteAmount: bigint,
      schedule: { fee: bigint; min: bigint },
      cuts: { withdrawalCut: bigint; depositCut: bigint },
      proverTip: bigint,
    ) => {
      const quote = goldenTicketBurn(schedule, cuts, proverTip)
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
    isPaylinkWindowNotOpenRevert: (e: unknown) => isWindowRevert(e),
    INTERRUPTED_ERRORS: {},
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
const claimLinkToL1 = vi.fn(async (..._a: unknown[]) => ({}))
const planLinkClaimSwap = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({
  claimLinkToL1: (...a: unknown[]) => claimLinkToL1(...a),
  planLinkClaimSwap: (...a: unknown[]) => planLinkClaimSwap(...a),
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
type L1ModalProps = {
  node?: unknown
  onConfirm: (choice: Record<string, unknown>, onStage: () => void) => Promise<unknown>
  planSwap: (...a: unknown[]) => Promise<unknown>
}
const l1Modal: { props?: L1ModalProps } = {}
vi.mock("../src/features/paylink/ClaimToL1Modal", () => ({
  ClaimToL1Modal: (props: L1ModalProps) => {
    l1Modal.props = props
    return null
  },
}))

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
/** A registration whose terms name the link exists, whatever its phase. */
const committed = { value: false }
const ticketSignupContinuation = vi.fn(
  (_fragment: string, _l2: string | undefined, _withdrawals: unknown) => continuation.value,
)
/** Listeners on the open registrations; a test fires them as the store would. */
const registrationListeners = new Set<() => void>()
vi.mock("../src/features/paylink/ticketContinuation", () => ({
  ticketSignupContinuation: (f: string, l2: string | undefined, w: unknown) =>
    ticketSignupContinuation(f, l2, w),
  ticketSignupCommitted: () => committed.value,
  onTicketRegistrationsChanged: (listener: () => void) => {
    registrationListeners.add(listener)
    return () => registrationListeners.delete(listener)
  },
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
const publishStalled = { value: false }
vi.mock("../src/features/onboarding/webRegistration", () => ({
  useRegistrationPublishStalled: () => publishStalled.value,
}))
const oweBroadcast = vi.hoisted(() => vi.fn())
vi.mock("../src/features/broadcasts/useOweRegistrationBroadcast", () => ({
  useOweRegistrationBroadcast: oweBroadcast,
}))
vi.mock("../src/features/broadcasts/BroadcastStatusRow", () => ({
  BroadcastStatusRow: ({ address }: { address: string }) => (
    <span data-testid="broadcast-status">{address}</span>
  ),
}))
const withdrawals: { list: unknown[] } = { list: [] }
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => ({ list: () => withdrawals.list, onListChanged: () => () => {} }),
}))
const navigate = vi.fn()
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }))
const commitTip = vi.fn((_account: string, _tag: string, _tip: bigint) => {})
vi.mock("../src/features/onboarding/registrationTerms", () => ({
  useDepositSkim: () => 5n,
  useSweepDeductions: () => ({ skim: 0n, fpcCut: 10n }),
  commitRegistrationProverTip: (account: string, tag: string, tip: bigint) =>
    commitTip(account, tag, tip),
  useRegistrationTerms: () => null,
  committedProverTip: () => 0n,
}))
/** The tip the review decides; its quote and decision have a suite of their own. */
const reviewTip: { value: bigint | undefined } = { value: 10n ** 18n }
vi.mock("../src/features/withdraw/speedChoice", () => ({ SpeedRow: () => null }))
vi.mock("../src/features/paylink/registrationProverTip", () => ({
  useRegistrationSpeed: ({
    active,
    onCommit,
  }: {
    active: boolean
    onCommit: (tip: bigint, speed: string) => void
  }) => {
    const tip = active ? reviewTip.value : undefined
    React.useEffect(() => {
      if (tip !== undefined) onCommit(tip, "faster")
    }, [tip])
    return {
      choice: {
        loading: false,
        speed: "faster",
        setSpeed: () => {},
        settled: false,
        pricedTip: 0n,
      },
      outcome: { proverTip: 0n },
      proverTip: tip,
    }
  },
}))
vi.mock("../src/features/onboarding/steps/ClaimReviewStep", () => ({
  ClaimReviewStep: ({
    quote,
    memo,
    error,
    notices,
    claimable = true,
    busy = false,
    status,
    onClaim,
    onClose,
  }: {
    quote?: { paylink?: bigint; youReceive?: bigint; provingFee: bigint }
    memo?: string
    error?: string
    notices?: React.ReactNode
    claimable?: boolean
    busy?: boolean
    status?: string
    onClaim: () => void
    onClose: () => void
  }) => (
    <div data-testid="claim-review">
      <span>
        {quote
          ? `paylink ${quote.paylink} receive ${quote.youReceive} proving ${quote.provingFee}`
          : "pricing"}
      </span>
      {memo && <span>{memo}</span>}
      {status && <span>{status}</span>}
      {error && <span role="alert">{error}</span>}
      {notices}
      {busy ? (
        <span>working</span>
      ) : (
        <>
          <button onClick={onClose}>Close</button>
          <button disabled={!claimable} onClick={onClaim}>
            Claim
          </button>
        </>
      )}
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
const fireEvent = vi.fn()
vi.mock("../src/lib/analytics", () => ({
  fireEvent: (...a: unknown[]) => fireEvent(...a),
  failureCode: () => "x",
}))

const { useClaimLinkFlow, resetRunningClaimsForTests } = await import(
  "../src/features/paylink/useClaimLinkFlow"
)
const { takeClaimPromptRequest } = await import("../src/features/paylink/claimPrompt")
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
  // Read with the escrow note; an open window unless a test says otherwise.
  claimableFrom: 0,
}
const emailLink = { ...directLink, flavor: "email", email: "satoshi@gmail.com", commitment: "0x2a" }
const emailLock = {
  paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
  email: "satoshi@gmail.com",
  commitment: "0x2a",
}

function Harness({
  fragment,
  onDone,
  requested = false,
}: {
  fragment: string | null
  onDone: () => void
  requested?: boolean
}) {
  return <div>{useClaimLinkFlow(fragment, onDone, requested).modal}</div>
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
    publishStalled.value = false
    delete aztec.obsidionWallet
    delete contracts.contractService
    claimSponsoredLink.mockImplementation(async () => "0xclaimtx")
    paylinkDeps = undefined
    chainNowRef.now = 1_000
    isWindowRevert.mockReturnValue(false)
    continuation.value = null
    fireEvent.mockClear()
    resetRunningClaimsForTests()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const button = (title: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === title)
  // The value cell of the ConfirmationSheetDetailRow mock.
  const detail = (label: string) =>
    [...container.querySelectorAll("span")].find((s) => s.textContent === label)?.nextElementSibling

  async function render(fragment: string | null = "frag") {
    await act(async () => {
      root.render(<Harness fragment={fragment} onDone={onDone} />)
    })
  }

  it("hands the claim-to-L1 review this wallet's node, and its prover tip to the burn", async () => {
    const node = {}
    aztec.obsidionWallet = { node }
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    l1Modal.props = undefined
    await render()
    await act(async () => button("Claim to an Ethereum wallet instead")!.click())
    expect(l1Modal.props!.node).toBe(node)
    await l1Modal.props!.planSwap("0xr", "USDC", { relayerTip: 1n }, 100n, 7n)
    expect(planLinkClaimSwap.mock.calls[0]!.at(-1)).toBe(7n)
    await act(async () => {
      await l1Modal.props!.onConfirm(
        { recipient: "0xr", screener: {}, receiveAsset: "DAI", proverTip: 7n },
        () => {},
      )
    })
    expect(claimLinkToL1.mock.calls[0]![10]).toBe(7n)
  })

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
  it("holds the amount, note and Accept until the escrow note is read", async () => {
    decodeLink.mockReturnValue({ ...directLink, amount: undefined, claimableFrom: undefined })
    let resolveView: (v: unknown) => void = () => {}
    viewLink.mockReturnValue(new Promise((r) => (resolveView = r)))
    aztec.obsidionWallet = {}
    contracts.contractService = {}
    await render()
    expect(container.textContent).not.toContain("$")
    expect(detail("Note")?.querySelector("[data-skeleton]")).not.toBeNull()
    // The note carries the claim window, so nothing is claimable until it is read.
    expect(button("Accept")).toBeUndefined()
    await act(async () => button("Checking…")?.click())
    expect(claimSponsoredLink).not.toHaveBeenCalled()
    await act(async () => resolveView({ ...directLink, amount: "5" }))
    expect(button("Accept")).toBeDefined()
    expect(container.textContent).toContain("$5")
    expect(container.querySelector("[data-skeleton]")).toBeNull()
    expect(detail("Note")?.textContent).toBe("—")
  })

  it("offers a re-read, never Accept, when the read ends without the claim window", async () => {
    decodeLink.mockReturnValue({ ...directLink, amount: undefined, claimableFrom: undefined })
    viewLink.mockRejectedValueOnce(new Error("node down"))
    aztec.obsidionWallet = {}
    contracts.contractService = {}
    await render()
    expect(button("Accept")).toBeUndefined()
    viewLink.mockResolvedValueOnce({ ...directLink, amount: "5" })
    await act(async () => button("Try again")?.click())
    expect(viewLink).toHaveBeenCalledTimes(2)
    expect(button("Accept")).toBeDefined()
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
    expect(container.textContent).toContain("Preparing transaction…")
    expect(container.textContent).not.toContain("Proving")
    expect(container.textContent).toContain("Keep this tab open")
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
    expect(container.textContent).toContain("Preparing transaction…")

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
    expect(container.textContent).toContain("Preparing transaction…")

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
    expect(fireEvent).toHaveBeenCalledWith("action_failed", { action: "paylink:claim", code: "x" })
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
    // The user's choice, not a failure.
    expect(fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
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

  describe("a ticket-funded signup entering Home", () => {
    const ONE = 10n ** 18n
    const ready = {
      stash: {
        fragment: "frag",
        amount: (20n * ONE).toString(),
        memo: "Pizza dinner",
        schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
      },
      record: { phase: "awaiting_deposit", account: "0xacct", tag: "taga" },
      activation: { state: "ready", schedule: { fee: ONE / 2n, min: 0n } },
    }
    /** The account is open, the chain clock read, and the escrow note read: the window is known. */
    const entered = (link: Record<string, unknown> = { ...directLink, claimableFrom: 0 }) => {
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      aztec.obsidionWallet = {}
      contracts.contractService = {}
      chainNowRef.now = 1_800_000_000
      viewLink.mockResolvedValue(link)
      continuation.value = ready
    }
    const held = (state: string) => {
      entered()
      continuation.value = { ...ready, activation: { state, stash: ready.stash } }
    }
    const settle = () => act(async () => new Promise((r) => setTimeout(r)))
    const cancelled = () => Object.assign(new Error("Cancelled"), { name: "NotAllowedError" })
    /** Home again with the same link: the flow mounts afresh, as when the activation sheet asks. */
    const remount = async () => {
      await render(null)
      await render()
    }
    const review = () => container.querySelector('[data-testid="claim-review"]')
    beforeEach(() => {
      takeClaimPromptRequest()
    })

    it("claims the link by itself, with the registration burn, and hands off to the bell at once", async () => {
      entered()
      withdrawals.list = [{ recipient: "0xsipa", phase: "done" }]
      await render()
      expect(ticketSignupContinuation).toHaveBeenCalledWith("frag", "0xme", withdrawals.list)
      expect(review()).toBeNull()
      expect(button("Accept")).toBeUndefined()
      expect(claimSponsoredLink).toHaveBeenCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
        { fundRegistration: true },
      )
      expect(onDone).toHaveBeenCalledOnce()
      await settle()
      // The link stays stashed: its review reports the claim and the registration from here.
      expect(clearClaimStash).not.toHaveBeenCalled()
      expect(takeClaimPromptRequest()).toBeNull()
      // No review, no fresh quote: the burn carries the tip the signup committed.
      expect(commitTip).not.toHaveBeenCalled()
    })

    it("opens the review on request whatever the claim's state, working while a claim runs", async () => {
      entered()
      claimSponsoredLink.mockReturnValueOnce(new Promise(() => {}))
      await render(null)
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      // Home's own try went out and handed off; the asked-for review reports it at work, priced at
      // the tip that claim burns rather than a fresh quote.
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(review()).not.toBeNull()
      expect(container.textContent).toContain("Claiming")
      expect(container.textContent).toContain("proving 0")
      expect(button("Claim")).toBeUndefined()
    })

    it("lets the link go once its registration has moved past the claim", async () => {
      entered()
      continuation.value = null
      committed.value = true
      try {
        await render()
        expect(clearClaimStash).toHaveBeenCalledWith("frag")
        expect(onDone).toHaveBeenCalled()
        expect(claimSponsoredLink).not.toHaveBeenCalled()
      } finally {
        committed.value = false
      }
    })

    it("shows the review, not a claim, for a link that closed before Home's first try", async () => {
      for (const status of ["claimed", "expired"] as const) {
        // `decodeLink` knows neither the window nor the close: the escrow read brings both.
        entered({ ...directLink, status, claimableFrom: 0 })
        decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
        await render()
        await settle()
        expect(claimSponsoredLink).not.toHaveBeenCalled()
        // The closed link is said where the payment is reviewed, with nothing to claim.
        expect(review()).not.toBeNull()
        expect(takeClaimPromptRequest()).toBeNull()
        await render(null)
      }
    })

    it("waits for the escrow read and the claim window before its one try", async () => {
      let resolveView: (v: unknown) => void = () => {}
      entered()
      // `decodeLink` knows no window: nothing is tried on that alone.
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      viewLink.mockReturnValue(new Promise((r) => (resolveView = r)))
      chainNowRef.now = 1_800_000_000
      await render()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(review()).toBeNull()

      await act(async () => resolveView({ ...directLink, claimableFrom: 1_800_000_100 }))
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(onDone).not.toHaveBeenCalled()

      chainNowRef.now = 1_800_000_130
      await render()
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(onDone).toHaveBeenCalledOnce()
    })

    it("a claim that fails reports itself and asks Home for the review again", async () => {
      entered()
      claimSponsoredLink.mockRejectedValueOnce(new Error("Transaction simulation failed"))
      await render()
      await settle()
      expect(showReportableError).toHaveBeenCalledWith(
        expect.any(Error),
        "paylink:claim",
        expect.objectContaining({ title: "Claim failed" }),
      )
      expect(takeClaimPromptRequest()).toBe("frag")
      expect(clearClaimStash).not.toHaveBeenCalled()
    })

    it("tries once per page: a cancelled passkey keeps the link stashed, and Home then shows the review with its Claim", async () => {
      entered()
      claimSponsoredLink.mockRejectedValueOnce(cancelled())
      await render()
      await settle()
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(clearClaimStash).not.toHaveBeenCalled()
      expect(showReportableError).not.toHaveBeenCalled()
      expect(fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
      // Home is asked to show the link again: the review, with its Claim.
      expect(takeClaimPromptRequest()).toBe("frag")

      await remount()
      expect(review()).not.toBeNull()
      expect(container.textContent).toContain("Pizza dinner")
      // 20 - (0.5 fee + 10 wei return-deposit cut + 0.01 remainder + 10 wei withdrawal cut + 0.1
      // relayer + 1 prover)
      expect(container.textContent).toContain(`receive ${18_390_000_000_000_000_000n - 20n}`)
      expect(container.textContent).toContain(`proving ${10n ** 18n}`)
      // The tip on screen is the one the claim burns.
      expect(commitTip).toHaveBeenCalledWith("0xacct", "taga", 10n ** 18n)
      expect(container.textContent).not.toContain("Accept to receive funds")
      await act(async () => button("Claim")!.click())
      expect(claimSponsoredLink).toHaveBeenCalledTimes(2)
      expect(claimSponsoredLink).toHaveBeenLastCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
        { fundRegistration: true },
      )
    })

    it("prices the review at the tip it commits, and holds the price while that tip is quoted", async () => {
      held("renew")
      const asked = () =>
        act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      try {
        reviewTip.value = 0n
        await asked()
        await settle()
        // 20 - (0.5 fee + 10 wei return-deposit cut + 0.01 remainder + 10 wei withdrawal cut + 0.1
        // relayer)
        expect(container.textContent).toContain(`receive ${19_390_000_000_000_000_000n - 20n}`)
        expect(container.textContent).toContain("proving 0")
        expect(commitTip).toHaveBeenCalledWith("0xacct", "taga", 0n)
        reviewTip.value = undefined
        await render(null)
        await asked()
        expect(container.textContent).toContain("pricing")
      } finally {
        reviewTip.value = 10n ** 18n
      }
    })

    it("claims once the address is published, on the registrations' own change", async () => {
      held("unpublished")
      await render()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(review()).toBeNull()
      expect(onDone).not.toHaveBeenCalled()

      continuation.value = ready
      await act(async () => registrationListeners.forEach((listener) => listener()))
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(onDone).toHaveBeenCalledOnce()
    })

    it("an email-locked link waits for the tap: its sign-in needs the gesture", async () => {
      entered({ ...emailLink, claimableFrom: 0 })
      decodeLink.mockReturnValue(emailLink)
      await render()
      await settle()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(review()).not.toBeNull()
      expect(onDone).not.toHaveBeenCalled()
    })

    it("shows the review with a re-read while the claim window is unread, then claims by itself once read", async () => {
      entered()
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      viewLink.mockRejectedValueOnce(new Error("node down"))
      await render()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(button("Claim")!.disabled).toBe(true)
      expect(container.textContent).toContain("Couldn't check when this link can be claimed.")
      viewLink.mockResolvedValueOnce(directLink)
      await act(async () => button("Try again")!.click())
      expect(viewLink).toHaveBeenCalledTimes(2)
      // The window read open, Home's own claim starts with no tap.
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(onDone).toHaveBeenCalledOnce()
    })

    it("Close keeps the link stashed: the signup's funding waits for its claim", async () => {
      entered({ ...emailLink, claimableFrom: 0 })
      decodeLink.mockReturnValue(emailLink)
      await render()
      await act(async () => button("Close")!.click())
      expect(onDone).toHaveBeenCalledOnce()
      expect(clearClaimStash).not.toHaveBeenCalled()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
    })

    it("owes the broadcast of a ticket's address that is not published, so Home can claim into it", async () => {
      held("unpublished")
      await render()
      expect(oweBroadcast).toHaveBeenLastCalledWith(ready.record, true)
      held("ready")
      await render()
      expect(oweBroadcast).toHaveBeenLastCalledWith(ready.record, false)
    })

    it("a review asked for while the address publishes shows where the broadcast stands, not the hold", async () => {
      held("unpublished")
      continuation.value = {
        ...ready,
        activation: { state: "unpublished", stash: ready.stash },
        record: { ...ready.record, sipaAddress: "0xsipa" },
      }
      await render(null)
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      expect(container.querySelector('[data-testid="broadcast-status"]')?.textContent).toBe(
        "0xsipa",
      )
      expect(container.textContent).not.toContain("Your deposit address is not published yet")
      expect(button("Check registration")).toBeUndefined()
      expect(button("Claim")?.disabled).toBe(true)

      // A stalled publish no longer retries itself: the hold sends the user to the registration.
      publishStalled.value = true
      await render(null)
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      expect(container.querySelector('[data-testid="broadcast-status"]')).toBeNull()
      expect(container.textContent).toContain("Your deposit address is not published yet")
      expect(button("Check registration")).toBeDefined()
    })

    it("a blocked, lapsed, unpublished or already-burning signup claims nothing and shows nothing: the hero says why", async () => {
      for (const state of ["blocked", "renew", "unpublished", "submitted"]) {
        held(state)
        await render()
        expect(review()).toBeNull()
        expect(button("Accept")).toBeUndefined()
        expect(claimSponsoredLink).not.toHaveBeenCalled()
        expect(onDone).not.toHaveBeenCalled()
      }
    })

    it("the review re-reads the signup at the click: terms that lapsed after the render claim nothing", async () => {
      entered()
      claimSponsoredLink.mockRejectedValueOnce(cancelled())
      await render()
      await settle()
      await remount()
      expect(button("Claim")?.disabled).toBe(false)
      continuation.value = { ...ready, activation: { state: "renew", stash: ready.stash } }
      await act(async () => button("Claim")!.click())
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/fresh quote/)
      expect(button("Claim")?.disabled).toBe(true)
      await act(async () => button("Check registration")!.click())
      expect(navigate).toHaveBeenCalledWith("/claim/taga")
      expect(clearClaimStash).not.toHaveBeenCalled()
    })

    it("a review rebuilt without the signup's own note read takes the amount and memo from the link", async () => {
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      continuation.value = {
        ...ready,
        stash: { fragment: "frag", schedule: ready.stash.schedule },
      }
      decodeLink.mockReturnValue({ ...emailLink, amount: "20", memo: "From the link" })
      await render()
      expect(container.textContent).toContain("From the link")
      expect(container.textContent).toContain(`receive ${18_390_000_000_000_000_000n - 20n}`)
    })

    it("a link this account's signup did not leave claims the ordinary way", async () => {
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      await render()
      expect(review()).toBeNull()
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

  it.each([
    ["claimed", "This link is no longer available"],
    ["expired", "This link has expired"],
  ] as const)("a %s link offers no claim actions", async (status, title) => {
    decodeLink.mockReturnValue({ ...directLink, status })
    await render()
    expect(container.textContent).toContain(title)
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

describe("ClaimProvingModal", () => {
  it("offers Cancel with no warning while nothing has moved, then the warning", async () => {
    const { ClaimProvingModal } = await import("../src/features/paylink/ClaimLinkModal")
    const container = document.createElement("div")
    const root = createRoot(container)
    await act(async () =>
      root.render(<ClaimProvingModal beat="signing-in" onCancel={vi.fn()} onLeave={vi.fn()} />),
    )
    expect(container.textContent).toContain("Signing in with Google")
    expect(container.textContent).toContain("Cancel")
    expect(container.textContent).not.toContain("Keep this tab open")
    await act(async () => root.render(<ClaimProvingModal beat="proving-jwt" onLeave={vi.fn()} />))
    expect(container.textContent).toContain("Keep this tab open")
    act(() => root.unmount())
  })

  it("shows the local-passkey line up to the prompt, for a passkey that answered remotely", async () => {
    const { ClaimProvingModal } = await import("../src/features/paylink/ClaimLinkModal")
    const { walletStorage } = await import("../src/platform/storage/walletStorage")
    const { setActiveCredentialId } = await import("../src/platform/storage/activeStorage")
    localStorage.removeItem("webwallet.local-passkey-hint-shown")
    const entry = { credentialId: "cred", rpId: "localhost", createdAt: 1, answered: "remote" }
    await walletStorage.batch(() => {
      walletStorage.setItem(
        "obsidion.obsidion_web_passkey_identity_map",
        JSON.stringify({ version: 1, entries: { cred: entry } }),
      )
      setActiveCredentialId("cred")
    })
    const container = document.createElement("div")
    const root = createRoot(container)
    await act(async () => root.render(<ClaimProvingModal onLeave={vi.fn()} />))
    expect(container.textContent).toContain("If your passkey has synced to this computer")
    await act(async () => provingProgress.emitSigningStart())
    expect(container.textContent).toContain("If your passkey has synced to this computer")
    expect(localStorage.getItem("webwallet.local-passkey-hint-shown")).toBe("1")
    act(() => root.unmount())
    localStorage.removeItem("webwallet.local-passkey-hint-shown")
  })
})
