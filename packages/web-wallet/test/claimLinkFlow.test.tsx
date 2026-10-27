import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { provingProgress } from "@obsidion/proving-progress"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { PAYLINK_NOT_CLAIMABLE_YET_MESSAGE } from "../src/features/paylink/claimWindow"
import { actionUpgradeTitle, claimUpgradeLead } from "../src/features/migration/upgradeCopy"
import { TimeoutError } from "../src/lib/withTimeout"
import { asOperation, endSigningAndHandOff } from "./support/handOff"

vi.mock("../src/features/operations/operations", async () =>
  (await import("./support/fakeOperations")).fakeOperationsModule(),
)
/** Whether a claim must wait for the upgrade, and every action a press asked for. */
const gate = vi.hoisted(() => ({ upgrade: false, asked: [] as string[] }))
vi.mock("../src/features/actionGate", () => ({
  useActionGuard: () => (action: string, run: () => void) => {
    gate.asked.push(action)
    if (!gate.upgrade) run()
  },
  useActionVerdict: () => (gate.upgrade ? "upgrade" : "open"),
}))
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
    proverTip: bigint,
    withdrawalFee: bigint,
  ) =>
    goldenTicketQuote(schedule, {
      withdrawalFee,
      relayerTip: WITHDRAW_RELAYER_TIP,
      proverTip,
      bridgeRemainder: GOLDEN_TICKET_BRIDGE_REMAINDER,
    })
  return {
    goldenTicketBurn,
    goldenTicketCoverage: (
      noteAmount: bigint,
      schedule: { fee: bigint; min: bigint },
      proverTip: bigint,
      withdrawalFee: bigint,
    ) => {
      const quote = goldenTicketBurn(schedule, proverTip, withdrawalFee)
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
      constructor(
        readonly txHash: string,
        cause?: unknown,
      ) {
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
  VoucherReadError: class VoucherReadError extends Error {},
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
  // The link's voucher read, which a registration it funds needs for the claim batch.
  useLinkVoucher: (link: unknown) => ({ uses: voucherPending.value ? undefined : link ? 1 : 0 }),
}))
/** The live sweep fee; undefined while it is read. */
const skim: { value: bigint | undefined } = { value: 5n }
/** This browser's registrations, as Home loads them. */
const registrationsLoad: { value: Promise<void> } = { value: Promise.resolve() }
/** The voucher read has not answered. */
const voucherPending = { value: false }
/** Some speed choice was asked to price its tip. */
const speedActive = { value: false }
const clearClaimStash = vi.fn()
/** The visitor page's read of the link, as the ticket marker carries it to Home. */
const ticketMarker: { value: Record<string, unknown> | null } = { value: null }
vi.mock("../src/features/paylink/claimStash", () => ({
  clearClaimStash: (fragment?: string) => clearClaimStash(fragment),
  peekTicketSignup: () => ticketMarker.value,
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
const releaseLinkDeposit = vi.fn()
/** This account's registration still waiting for its deposit, or null. */
const unfunded: { value: unknown } = { value: null }
const bindLinkDeposit = vi.fn()
vi.mock("../src/features/paylink/ticketContinuation", () => ({
  releaseLinkDeposit: (record: unknown) => releaseLinkDeposit(record),
  unfundedRegistration: () => unfunded.value,
  loadRegistrations: () => registrationsLoad.value,
  fundingRefusalCopy: (e: Error) =>
    e.name === "RegistrationFundingError" ? "the funding's copy" : undefined,
  bindLinkDeposit: (...a: unknown[]) => bindLinkDeposit(...a),
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
      : state === "submitted"
      ? "This payment is already claimed"
      : undefined,
}))
const oweBroadcast = vi.hoisted(() => vi.fn())
vi.mock("../src/features/broadcasts/useOweRegistrationBroadcast", () => ({
  useOweRegistrationBroadcast: oweBroadcast,
}))

const withdrawals: { list: unknown[] } = { list: [] }
/** The burns' load, which a reload has yet to finish. */
const withdrawalsLoad = vi.fn(async () => {})
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => ({
    list: () => withdrawals.list,
    load: () => withdrawalsLoad(),
    onListChanged: () => () => {},
  }),
}))
const navigate = vi.fn()
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }))
const commitTip = vi.fn((_account: string, _tag: string, _tip: bigint) => {})
vi.mock("../src/features/onboarding/registrationTerms", () => ({
  useDepositSkim: () => skim.value,
  commitRegistrationProverTip: (account: string, tag: string, tip: bigint) =>
    commitTip(account, tag, tip),
  useRegistrationTerms: () => null,
  committedProverTip: () => 0n,
}))
/** The tip the review decides; its quote and decision have a suite of their own. */
const reviewTip: { value: bigint | undefined } = { value: 10n ** 18n }
vi.mock("../src/features/withdraw/speedChoice", () => ({ SpeedRow: () => null }))
// The executor fee is priced in the quote's own suite; here it costs nothing so the figures stay the tips'.
vi.mock("../src/features/withdraw/withdrawalFee", () => ({ useActiveWithdrawalFee: () => 0n }))
vi.mock("../src/features/paylink/registrationProverTip", () => ({
  useRegistrationSpeed: ({
    active,
    onCommit,
  }: {
    active: boolean
    onCommit: (tip: bigint, speed: string) => void
  }) => {
    const tip = active ? reviewTip.value : undefined
    if (active) speedActive.value = true
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
      settle: () => {},
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
    settled = false,
    busy = false,
    status,
    onClaim,
    onClose,
    onHandOff,
  }: {
    quote?: { paylink?: bigint; youReceive?: bigint; provingFee: bigint; tagWaived?: boolean }
    memo?: string
    error?: string
    notices?: React.ReactNode
    claimable?: boolean
    settled?: boolean
    busy?: boolean
    status?: string
    onClaim: () => void
    onClose: () => void
    onHandOff?: () => void
  }) => (
    <div data-testid="claim-review">
      <span>
        {quote
          ? `paylink ${quote.paylink} receive ${quote.youReceive} proving ${quote.provingFee}`
          : "pricing"}
      </span>
      {quote?.tagWaived && <span>Free with ticket</span>}
      {memo && <span>{memo}</span>}
      {status && <span>{status}</span>}
      {error && <span role="alert">{error}</span>}
      {notices}
      {busy && <span>working</span>}
      {/* While the claim runs, Close takes the hand-off's leave, as the step does. */}
      <button onClick={busy ? onHandOff : onClose}>Close</button>
      {!settled && !busy && (
        <button disabled={!claimable} onClick={onClaim}>
          Claim
        </button>
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
const { setLinkFunding, takeClaimPromptRequest, useLinkFunding } = await import(
  "../src/features/paylink/claimPrompt"
)
const { useAutoClaimHold } = await import("../src/features/paylink/runningClaims")
const { VoucherReadError } = (await import(
  "../src/features/paylink/sponsoredPaylink"
)) as unknown as {
  VoucherReadError: new (message: string) => Error
}
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
  return (
    <div>
      {useClaimLinkFlow(fragment, onDone, requested).modal}
      <FundingProbe />
    </div>
  )
}

/** What the hero is told about the link and the open registration. */
function FundingProbe() {
  const funding = useLinkFunding()
  return <i data-testid="funding" data-state={funding ? funding.state : "none"} />
}

/** Home's own wiring: the stashed link, and whether an activation surface asked for its review. */
function HomeHarness({ onDone, asked: askedFirst }: { onDone: () => void; asked: boolean }) {
  const [fragment, setFragment] = React.useState<string | null>("frag")
  const [asked, setAsked] = React.useState(askedFirst)
  const flow = useClaimLinkFlow(
    fragment,
    () => {
      onDone()
      setFragment(null)
      setAsked(false)
    },
    asked,
    () => setAsked(false),
  )
  return <div>{flow.modal}</div>
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
    chainNowRef.now = 1_000
    isWindowRevert.mockReturnValue(false)
    continuation.value = null
    unfunded.value = null
    ticketMarker.value = null
    voucherPending.value = false
    registrationsLoad.value = Promise.resolve()
    skim.value = 5n
    speedActive.value = false
    setLinkFunding(null)
    fireEvent.mockClear()
    resetRunningClaimsForTests()
    gate.upgrade = false
    gate.asked = []
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const funding = () =>
    container.querySelector('[data-testid="funding"]')?.getAttribute("data-state")
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

  // This tab's earlier read (here the visitor page's, on the ticket marker) shows the amount and the
  // window at once; the link may be spent since, so only a read of it now offers the claim.
  it.each([
    ["unclaimed", true],
    ["claimed", false],
  ])(
    "offers Accept off this tab's earlier read only once a read finds it %s",
    async (status, offered) => {
      decodeLink.mockReturnValue({ ...directLink, amount: undefined, claimableFrom: undefined })
      ticketMarker.value = {
        fragment: "frag",
        amount: (20n * 10n ** 18n).toString(),
        claimableFrom: 0,
      }
      let resolveView: (v: unknown) => void = () => {}
      viewLink.mockReturnValue(new Promise((r) => (resolveView = r)))
      aztec.obsidionWallet = {}
      contracts.contractService = {}
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      await render()
      expect(container.textContent).toContain("$20")
      expect(button("Accept")).toBeUndefined()
      await act(async () => button("Checking…")?.click())
      expect(claimSponsoredLink).not.toHaveBeenCalled()

      await act(async () =>
        resolveView(
          status === "claimed" ? { ...directLink, status } : { ...directLink, amount: "20" },
        ),
      )
      expect(!!button("Accept")).toBe(offered)
      expect(!!button("Go to wallet")).toBe(!offered)
    },
  )

  it("offers a re-read when this tab's earlier read is all there is", async () => {
    decodeLink.mockReturnValue({ ...directLink, amount: undefined, claimableFrom: undefined })
    ticketMarker.value = {
      fragment: "frag",
      amount: (20n * 10n ** 18n).toString(),
      claimableFrom: 0,
    }
    viewLink.mockRejectedValueOnce(new Error("node down"))
    aztec.obsidionWallet = {}
    contracts.contractService = {}
    await render()
    expect(button("Accept")).toBeUndefined()
    viewLink.mockResolvedValueOnce({ ...directLink, amount: "20" })
    await act(async () => button("Try again")?.click())
    expect(button("Accept")).toBeDefined()
  })

  // Only a read here supplies the token (the Ethereum claim's fee) and an email link's email and
  // commitment; this tab's earlier read keeps the amount and the window, never those.
  it.each([
    ["direct", directLink, "Accept", "Accept"],
    ["email", emailLink, "Reading link…", "Claim with Google"],
  ])(
    "offers a %s link's re-read once every read misses the note this tab read before",
    async (_flavor, read, offered, claim) => {
      const decoded = { ...read, email: undefined, commitment: undefined }
      vi.useFakeTimers()
      try {
        decodeLink.mockReturnValue({ ...decoded, amount: undefined, claimableFrom: undefined })
        ticketMarker.value = {
          fragment: "frag",
          amount: (20n * 10n ** 18n).toString(),
          claimableFrom: 0,
        }
        viewLink.mockResolvedValue({ ...decoded, amount: undefined, claimableFrom: undefined })
        aztec.obsidionWallet = {}
        contracts.contractService = {}
        paylinkDeps = { account: { getAddress: () => "0xme" } }
        await render()
        expect(container.textContent).toContain("$20")
        expect(button(offered)).toBeDefined()

        await act(async () => vi.advanceTimersByTimeAsync(60_000))
        expect(viewLink).toHaveBeenCalledTimes(13)
        expect(button(offered)).toBeUndefined()
        expect(button("Claim to an Ethereum wallet instead")).toBeUndefined()
        expect(container.textContent).toContain("Couldn't check when this link can be claimed.")

        viewLink.mockResolvedValueOnce({ ...read, amount: "20", claimableFrom: 0 })
        await act(async () => button("Try again")!.click())
        expect(button("Try again")).toBeUndefined()
        expect(button(claim)).toBeDefined()
        expect(button("Claim to an Ethereum wallet instead")).toBeDefined()
      } finally {
        vi.useRealTimers()
      }
    },
  )

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

  it("asks an account that must upgrade to upgrade to claim", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    l1Modal.props = undefined
    gate.upgrade = true
    await render()
    expect(container.textContent).toContain(claimUpgradeLead)
    await act(async () => button(actionUpgradeTitle.claim)!.click())
    expect(gate.asked).toEqual(["claim"])
    expect(claimSponsoredLink).not.toHaveBeenCalled()
    expect(l1Modal.props).toBeUndefined()
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

  describe("an account whose registration still waits for its deposit", () => {
    const ONE = 10n ** 18n
    const record = {
      phase: "awaiting_deposit",
      account: "0xacct",
      tag: "brisk-otter",
      sipaAddress: "0xsipa",
    }
    /** A drawn tag's signed deposit: the sweep fee and its minimum. */
    const waiting = { record, schedule: { fee: ONE / 2n, min: ONE } }
    const opened = (link: Record<string, unknown> = directLink) => {
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      aztec.obsidionWallet = {}
      contracts.contractService = {}
      chainNowRef.now = 1_800_000_000
      viewLink.mockResolvedValue(link)
      unfunded.value = waiting
    }
    const settle = () => act(async () => new Promise((r) => setTimeout(r)))

    it("shows the split the link pays before the claim, then funds the registration with its tip", async () => {
      opened()
      await render()
      await settle()
      // The review, not the plain prompt: what the registration takes and what the wallet keeps.
      expect(container.querySelector('[data-testid="claim-review"]')).not.toBeNull()
      expect(button("Accept")).toBeUndefined()
      expect(container.textContent).toContain(`paylink ${100n * ONE}`)
      expect(container.textContent).toContain(`proving ${ONE}`)
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      await act(async () => button("Claim")!.click())
      expect(bindLinkDeposit).toHaveBeenCalledWith(
        record,
        { fragment: "frag", amount: 100n * ONE, senderTag: undefined },
        ONE,
        "faster",
      )
      expect(claimSponsoredLink).toHaveBeenCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
        { fundRegistration: true },
      )
    })

    it("prices a paid tag at its own signed fee: a golden ticket waives nothing for an entered account", async () => {
      opened()
      unfunded.value = {
        record: { ...record, tag: "maple-paid" },
        schedule: { fee: 10n * ONE, min: ONE },
      }
      await render()
      await settle()
      expect(container.textContent).not.toContain("Free with ticket")
      await act(async () => button("Claim")!.click())
      expect(bindLinkDeposit).toHaveBeenCalled()
      expect(claimSponsoredLink).toHaveBeenCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
        { fundRegistration: true },
      )
    })

    it("tells the hero it is checking until the voucher answers, then that the link pays", async () => {
      opened()
      voucherPending.value = true
      await render()
      await settle()
      expect(funding()).toBe("checking")
      expect(button("Accept")).toBeUndefined()
      expect(container.querySelector('[data-testid="claim-review"]')).toBeNull()
      // The tip is priced beside the voucher read, not after it.
      expect(speedActive.value).toBe(true)
      expect(bindLinkDeposit).not.toHaveBeenCalled()
      voucherPending.value = false
      await render()
      await settle()
      expect(funding()).toBe("review")
      expect(container.querySelector('[data-testid="claim-review"]')).not.toBeNull()
    })

    it("chooses nothing before the sweep fee is read", async () => {
      opened()
      skim.value = undefined
      await render()
      await settle()
      expect(container.querySelector('[data-testid="claim-review"]')).toBeNull()
      expect(funding()).toBe("checking")
      skim.value = 5n
      await render()
      await settle()
      expect(container.querySelector('[data-testid="claim-review"]')).not.toBeNull()
    })

    it("a decision past its time decides only its own link", async () => {
      vi.useFakeTimers()
      try {
        opened()
        skim.value = undefined
        await render()
        await act(async () => vi.advanceTimersByTimeAsync(15_000))
        expect(button("Accept")).toBeDefined()
        await render("frag-b")
        await act(async () => vi.advanceTimersByTimeAsync(0))
        expect(button("Accept")).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it("closes the review without dropping the link, and the hero still leads back to it", async () => {
      opened()
      await render()
      await settle()
      await act(async () => button("Close")!.click())
      expect(onDone).toHaveBeenCalled()
      expect(clearClaimStash).not.toHaveBeenCalled()
      await render(null)
      expect(funding()).toBe("review")
    })

    it("says why a funding claim was refused in its own words, never the raw refusal", async () => {
      opened()
      claimSponsoredLink.mockRejectedValueOnce(
        Object.assign(new Error("the registration's deposit address cannot be published yet: x"), {
          name: "RegistrationFundingError",
          reason: "unpublished",
        }),
      )
      await render()
      await settle()
      await act(async () => button("Claim")!.click())
      await settle()
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("the funding's copy")
    })

    it("claims as an ordinary payment when the note cannot cover the deposit and the tip", async () => {
      opened({ ...directLink, amount: "1" })
      await render()
      await settle()
      expect(container.querySelector('[data-testid="claim-review"]')).toBeNull()
      // The hero asks for the deposit again.
      expect(funding()).toBe("none")
      await act(async () => button("Accept")!.click())
      expect(bindLinkDeposit).not.toHaveBeenCalled()
      expect(claimSponsoredLink).toHaveBeenCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
      )
    })
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

    it("asks to upgrade before the review's own Claim", async () => {
      entered()
      claimSponsoredLink.mockRejectedValueOnce(cancelled())
      await render()
      await settle()
      await remount()
      expect(review()).not.toBeNull()
      gate.upgrade = true
      await act(async () => button("Claim")!.click())
      expect(gate.asked).toEqual(["claim"])
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
    })

    it("holds its own claim while the account must upgrade first", async () => {
      entered()
      gate.upgrade = true
      await render()
      await settle()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      gate.upgrade = false
      await render()
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
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

    it("reviews the ticket's tag as free though its fee is above the live sweep fee", async () => {
      entered()
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      expect(review()).not.toBeNull()
      expect(container.textContent).toContain("Free with ticket")
    })

    it("tells the hero nothing while the registrations load, so a ticket signup keeps its own hero", async () => {
      entered()
      continuation.value = null
      registrationsLoad.value = new Promise(() => {})
      await render()
      await settle()
      expect(funding()).toBe("none")
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

    it("hands a deposit the link was to pay back to the user once a fresh read finds the link closed", async () => {
      entered({ ...directLink, status: "claimed", claimableFrom: 0 })
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      await render()
      await settle()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(releaseLinkDeposit).toHaveBeenCalledWith(ready.record)
    })

    it("hands the deposit back once the link closes, while a renewal holds the signup blocked", async () => {
      held("blocked")
      viewLink.mockResolvedValue({ ...directLink, status: "expired", claimableFrom: 0 })
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      await render()
      await settle()
      expect(releaseLinkDeposit).toHaveBeenCalledWith(ready.record)
    })

    it("keeps the registration whose burn is already on its way", async () => {
      held("submitted")
      viewLink.mockResolvedValue({ ...directLink, status: "claimed", claimableFrom: 0 })
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      await render()
      await settle()
      expect(releaseLinkDeposit).not.toHaveBeenCalled()
    })

    it("keeps the link after a reload until its burns are loaded, which show the claim is its own", async () => {
      entered()
      continuation.value = null
      committed.value = true
      let loaded!: () => void
      withdrawalsLoad.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            loaded = () => {
              continuation.value = { ...ready, activation: { state: "submitted" } }
              resolve()
            }
          }),
      )
      try {
        await render()
        await settle()
        expect(clearClaimStash).not.toHaveBeenCalled()
        await act(async () => loaded())
        await settle()
        expect(clearClaimStash).not.toHaveBeenCalled()
        expect(onDone).not.toHaveBeenCalled()
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
      // 20 - (0.5 fee + 0.01 remainder + 0.1 relayer + 1 prover)
      expect(container.textContent).toContain(`receive ${18_390_000_000_000_000_000n}`)
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
        // 20 - (0.5 fee + 0.01 remainder + 0.1 relayer)
        expect(container.textContent).toContain(`receive ${19_390_000_000_000_000_000n}`)
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

    it("claims once a renewal makes the signup ready, on the registrations' own change", async () => {
      held("renew")
      await render()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(review()).toBeNull()
      expect(onDone).not.toHaveBeenCalled()

      continuation.value = ready
      await act(async () => registrationListeners.forEach((listener) => listener()))
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(onDone).toHaveBeenCalledOnce()
    })

    it("claims off the visitor page's read of the link, without waiting on its own", async () => {
      entered()
      // Home's own read has not answered; the marker carries the window the visitor page read.
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined, amount: undefined })
      viewLink.mockReturnValue(new Promise(() => {}))
      ticketMarker.value = { fragment: "frag", amount: (20n * ONE).toString(), claimableFrom: 0 }
      await render()
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(onDone).toHaveBeenCalledOnce()
    })

    it("says which gate holds the automatic claim, once per change", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {})
      try {
        committed.value = true
        entered()
        decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
        let resolveView: (v: unknown) => void = () => {}
        viewLink.mockReturnValue(new Promise((r) => (resolveView = r)))
        await render()
        await render()
        const lines = () => info.mock.calls.map(([line]) => String(line))
        expect(lines()).toEqual(["[paylink] automatic claim held: claim window not read yet"])
        await act(async () => resolveView(directLink))
        expect(lines()).toContain("[paylink] automatic claim starting")
        expect(claimSponsoredLink).toHaveBeenCalledOnce()
      } finally {
        committed.value = false
        info.mockRestore()
      }
    })

    it("tells the hero what its own claim waits for, until the claim starts", async () => {
      // The hero's read of the hold, beside Home's flow.
      const Hold = () => {
        const hold = useAutoClaimHold("frag")
        return <output>{typeof hold === "object" ? hold.countdown : hold ?? "none"}</output>
      }
      const home = () =>
        act(async () =>
          root.render(
            <>
              <Harness fragment="frag" onDone={onDone} />
              <Hold />
            </>,
          ),
        )
      const hold = () => container.querySelector("output")?.textContent
      committed.value = true
      try {
        entered()
        decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
        let resolveView: (v: unknown) => void = () => {}
        viewLink.mockReturnValue(new Promise((r) => (resolveView = r)))
        await home()
        expect(hold()).toBe("preparing")

        await act(async () => resolveView({ ...directLink, claimableFrom: 1_800_000_100 }))
        expect(hold()).toBe("Ready to claim in 2:10")

        chainNowRef.now = 1_800_000_130
        await home()
        expect(claimSponsoredLink).toHaveBeenCalledOnce()
        expect(hold()).toBe("none")
      } finally {
        committed.value = false
      }
    })

    it("tries twice more after a voucher read that timed out, then hands the review back", async () => {
      vi.useFakeTimers()
      const info = vi.spyOn(console, "info").mockImplementation(() => {})
      try {
        entered()
        claimSponsoredLink
          .mockRejectedValueOnce(new VoucherReadError("slow"))
          .mockRejectedValueOnce(new VoucherReadError("slow"))
        await render()
        await act(async () => vi.advanceTimersByTimeAsync(0))
        expect(claimSponsoredLink).toHaveBeenCalledTimes(1)
        // Still Home's claim while it waits: nothing reopens the review, nothing starts it again.
        expect(takeClaimPromptRequest()).toBeNull()
        await act(async () => vi.advanceTimersByTimeAsync(5_000))
        expect(claimSponsoredLink).toHaveBeenCalledTimes(2)
        await act(async () => vi.advanceTimersByTimeAsync(10_000))
        expect(claimSponsoredLink).toHaveBeenCalledTimes(3)
        expect(takeClaimPromptRequest()).toBeNull()
        expect(showReportableError).not.toHaveBeenCalled()

        // A read that keeps timing out is reported once the tries are spent.
        resetRunningClaimsForTests()
        claimSponsoredLink.mockClear()
        claimSponsoredLink.mockRejectedValue(new VoucherReadError("slow"))
        await render(null)
        await render()
        await act(async () => vi.advanceTimersByTimeAsync(20_000))
        expect(claimSponsoredLink).toHaveBeenCalledTimes(3)
        expect(takeClaimPromptRequest()).toBe("frag")
        expect(showReportableError).toHaveBeenCalledOnce()
      } finally {
        claimSponsoredLink.mockReset()
        info.mockRestore()
        vi.useRealTimers()
      }
    })

    it("never retries a failure that will not pass on its own", async () => {
      vi.useFakeTimers()
      try {
        entered()
        claimSponsoredLink.mockRejectedValueOnce(new Error("Transaction simulation failed"))
        await render()
        await act(async () => vi.advanceTimersByTimeAsync(20_000))
        expect(claimSponsoredLink).toHaveBeenCalledOnce()
        expect(takeClaimPromptRequest()).toBe("frag")
      } finally {
        vi.useRealTimers()
      }
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

    it("a review off the visitor page's read whose own read fails says so, not that it is checking", async () => {
      entered()
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined, amount: undefined })
      // The window opens later, so Home's own try waits and the review is the one asked for.
      ticketMarker.value = {
        fragment: "frag",
        amount: (20n * ONE).toString(),
        claimableFrom: 1_800_000_100,
      }
      viewLink.mockRejectedValueOnce(new Error("node down"))
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      expect(review()).not.toBeNull()
      expect(container.textContent).toContain("Couldn't check when this link can be claimed.")
      expect(container.textContent).not.toContain("Checking when this link can be claimed…")
      expect(container.textContent).toContain("Unclaimed")
      expect(button("Try again")).toBeDefined()
      expect(button("Claim")!.disabled).toBe(true)
    })

    it("closing a review asked for before Home's own try leaves that try to run", async () => {
      entered({ ...directLink, claimableFrom: 1_800_000_100 })
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      const home = () => act(async () => root.render(<HomeHarness onDone={onDone} asked />))
      await home()
      await settle()
      expect(review()).not.toBeNull()
      await act(async () => button("Close")!.click())
      expect(review()).toBeNull()
      expect(onDone).not.toHaveBeenCalled()
      expect(claimSponsoredLink).not.toHaveBeenCalled()

      // The window opens: Home claims by itself, as the hero said it would.
      chainNowRef.now = 1_800_000_130
      await home()
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

    it("owes no broadcast: an unpublished ticket's own claim publishes its address", async () => {
      entered()
      continuation.value = { ...ready, record: { ...ready.record, broadcast: false } }
      await render()
      expect(oweBroadcast).not.toHaveBeenCalled()
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
    })

    it("a review asked for once the burn is out says so as its status, with nothing to claim", async () => {
      held("submitted")
      await render(null)
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      expect(review()).not.toBeNull()
      expect(container.textContent).toContain("Registering @taga")
      // A status, not an error: the claim went out.
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(button("Claim")).toBeUndefined()
      expect(button("Close")).toBeDefined()
    })

    it("a review asked for once the burn is out shows the tip that burn committed, and commits none", async () => {
      held("submitted")
      await render(null)
      commitTip.mockClear()
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      expect(container.textContent).toContain(`receive ${19_390_000_000_000_000_000n}`)
      expect(container.textContent).toContain("proving 0")
      expect(commitTip).not.toHaveBeenCalled()
    })

    it("a blocked, lapsed or already-burning signup claims nothing and shows nothing: the hero says why", async () => {
      for (const state of ["blocked", "renew", "submitted"]) {
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

    /** Home's own try was cancelled: Home shows the review again, unasked, with its Claim. */
    const reviewAfterHomeTry = async () => {
      entered()
      claimSponsoredLink.mockRejectedValueOnce(cancelled())
      await render()
      await settle()
      takeClaimPromptRequest()
      await remount()
      expect(button("Claim")?.disabled).toBe(false)
    }

    it("keeps the review while its claim runs, so it can be closed there", async () => {
      await reviewAfterHomeTry()
      claimSponsoredLink.mockReturnValueOnce(new Promise(() => {}))
      await act(async () => button("Claim")!.click())
      expect(review()).not.toBeNull()
      expect(container.textContent).toContain("working")
      expect(button("Claim")).toBeUndefined()
      onDone.mockClear()
      await act(async () => button("Close")!.click())
      expect(onDone).toHaveBeenCalledOnce()
    })

    it.each([
      ["fails", new Error("Transaction simulation failed"), "Transaction simulation failed"],
      [
        "runs out of time to prepare",
        new Error("The claim took too long to prepare.", { cause: new TimeoutError(110_000) }),
        "The claim took too long to prepare.",
      ],
    ])(
      "a claim that %s returns the review to its Claim, saying why",
      async (_, failure, reason) => {
        await reviewAfterHomeTry()
        claimSponsoredLink.mockRejectedValueOnce(failure)
        await act(async () => button("Claim")!.click())
        expect(container.textContent).not.toContain("working")
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(reason)
        expect(button("Claim")?.disabled).toBe(false)
        expect(claimSponsoredLink).toHaveBeenCalledTimes(2)
      },
    )

    it("a claim left running when its review closed reports its failure in the review it reopens", async () => {
      await reviewAfterHomeTry()
      let fail!: (e: unknown) => void
      claimSponsoredLink.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
      await act(async () => root.render(<HomeHarness onDone={onDone} asked />))
      await act(async () => button("Claim")!.click())
      await act(async () => button("Close")!.click())
      expect(review()).toBeNull()
      showReportableError.mockClear()

      await act(async () => fail(new Error("Transaction simulation failed")))
      // The bell reports it while the review is closed.
      expect(showReportableError).not.toHaveBeenCalled()
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Transaction simulation failed",
      )
      expect(button("Claim")?.disabled).toBe(false)
    })

    it("a review whose own read never answers offers the re-read once the reads' time is up", async () => {
      vi.useFakeTimers()
      try {
        entered()
        decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined, amount: undefined })
        // The window opens later, so Home's own try waits and the review is the one asked for.
        ticketMarker.value = {
          fragment: "frag",
          amount: (20n * ONE).toString(),
          claimableFrom: 1_800_000_100,
        }
        viewLink.mockReturnValue(new Promise(() => {}))
        await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
        expect(container.textContent).toContain("Checking when this link can be claimed…")
        expect(button("Try again")).toBeUndefined()

        await act(async () => vi.advanceTimersByTimeAsync(60_000))
        expect(container.textContent).not.toContain("Checking when this link can be claimed…")
        expect(container.textContent).toContain("Couldn't check when this link can be claimed.")
        viewLink.mockResolvedValueOnce({ ...directLink, claimableFrom: 1_800_000_100 })
        await act(async () => button("Try again")!.click())
        expect(viewLink).toHaveBeenCalledTimes(2)
        expect(button("Try again")).toBeUndefined()
        expect(container.textContent).toContain(PAYLINK_NOT_CLAIMABLE_YET_MESSAGE)
      } finally {
        vi.useRealTimers()
      }
    })

    it("a review whose read stalled offers no re-read while Home's own try runs", async () => {
      vi.useFakeTimers()
      try {
        entered()
        decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined, amount: undefined })
        ticketMarker.value = {
          fragment: "frag",
          amount: (20n * ONE).toString(),
          claimableFrom: 1_800_000_100,
        }
        viewLink.mockReturnValue(new Promise(() => {}))
        claimSponsoredLink.mockReturnValueOnce(new Promise(() => {}))
        const asked = () =>
          act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
        await asked()
        await act(async () => vi.advanceTimersByTimeAsync(60_000))
        expect(button("Try again")).toBeDefined()

        chainNowRef.now = 1_800_000_130
        await asked()
        expect(claimSponsoredLink).toHaveBeenCalledOnce()
        expect(container.textContent).toContain("Claiming")
        expect(button("Try again")).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it("a review reopened over a claim whose reads never answer waits for that claim, then says why it failed", async () => {
      await reviewAfterHomeTry()
      let fail!: (e: unknown) => void
      claimSponsoredLink.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
      await act(async () => root.render(<HomeHarness onDone={onDone} asked />))
      await act(async () => button("Claim")!.click())
      await act(async () => button("Close")!.click())
      // The reopened review's read queues behind the claim's on the PXE.
      viewLink.mockReturnValue(new Promise(() => {}))
      vi.useFakeTimers()
      try {
        await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
        await act(async () => vi.advanceTimersByTimeAsync(60_000))
        expect(container.textContent).toContain("Claiming")
        expect(button("Try again")).toBeUndefined()

        const reason = "The claim took too long to prepare."
        await act(async () => fail(new Error(reason, { cause: new TimeoutError(110_000) })))
        const alert = () => container.querySelector('[role="alert"]')?.textContent
        expect(alert()).toBe(reason)
        await act(async () => vi.advanceTimersByTimeAsync(60_000))
        expect(alert()).toBe(reason)
        expect(button("Claim")?.disabled).toBe(true)
        viewLink.mockResolvedValueOnce(directLink)
        await act(async () => button("Try again")!.click())
        expect(alert()).toBe(reason)
        expect(button("Claim")?.disabled).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it("a review's claim that lands hands off", async () => {
      await reviewAfterHomeTry()
      onDone.mockClear()
      await act(async () => button("Claim")!.click())
      expect(onDone).toHaveBeenCalledOnce()
    })

    it("a review's claim the node already has hands off with no failure, and is not offered again", async () => {
      await reviewAfterHomeTry()
      await act(async () => root.render(<HomeHarness onDone={onDone} asked />))
      onDone.mockClear()
      claimSponsoredLink.mockRejectedValueOnce(new TxInFlightError("0xclaim", new Error("offline")))
      await act(async () => button("Claim")!.click())
      expect(onDone).toHaveBeenCalledOnce()
      expect(review()).toBeNull()
      expect(showReportableError).not.toHaveBeenCalled()

      // The burn's record, left at its hash, makes the signup submitted.
      continuation.value = { ...ready, activation: { state: "submitted" } }
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      expect(review()).not.toBeNull()
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(button("Claim")).toBeUndefined()
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
      expect(container.textContent).toContain(`receive ${18_390_000_000_000_000_000n}`)
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
