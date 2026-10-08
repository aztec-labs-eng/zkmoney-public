import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PendingRegistrationStore,
  ScreeningProvider,
  passThroughScreener,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { formatUnits, type Hex } from "viem"

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  amounts: { min: 0n, fee: 0n },
  /** The connected L1 wallet, when one is. */
  l1Account: null as string | null,
  writeContract: vi.fn(),
  /** What the fake token answers for balanceOf(sipa). */
  balance: 0n,
  /** Holds balanceOf(sipa) until the test lands it. */
  balanceRead: undefined as Promise<bigint> | undefined,
  /** The portal's cut off every credited deposit. */
  fpcCut: 0n,
  /** The relayer's sweep fee the registration SIPA implementation answers. */
  depositFee: 0n,
}))

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}))
// Fake fragments never decode; the binding only needs a stable name for one.
vi.mock("../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
// The cut reader caches one read per deployment; the suite's own value must win every time, and
// an unread cut must stay unread rather than become a figure.
vi.mock("../src/features/fees/fpcFundingCut", () => ({
  fpcFundingCut: async () => {
    if (h.fpcCut === undefined) throw new Error("cut unread")
    return h.fpcCut
  },
  currentFpcFundingCut: async () => {
    if (h.fpcCut === undefined) throw new Error("cut unread")
    return h.fpcCut
  },
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => ({ account: h.l1Account, walletName: "Rainbow", connect: vi.fn() }),
  getL1Clients: async () => ({
    walletClient: { writeContract: h.writeContract },
    account: h.l1Account,
    chain: { id: 11155111 },
  }),
}))
vi.mock("../src/features/deposit/l1DepositTokenBalance", () => ({
  readL1DepositTokenBalance: async () => ({ raw: 10n ** 30n }),
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({
    network: "testnet",
    l1ChainId: 11155111,
    l1Chain: { name: "Sepolia" },
    rpId: "localhost",
  }),
}))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({
    registry: "0x00000000000000000000000000000000000000e4",
    pool: "0x00000000000000000000000000000000000000e1",
    sipaFactory: "0x00000000000000000000000000000000000000e7",
    portal: "0x00000000000000000000000000000000000000e9",
  }),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  l1PublicClient: () => ({
    waitForTransactionReceipt: async () => ({ status: "success" }),
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "REGISTRATION_MIN"
        ? h.amounts.min
        : functionName === "REGISTRATION_FEE"
        ? h.amounts.fee
        : functionName === "implementationFor"
        ? "0x00000000000000000000000000000000000000ea"
        : functionName === "depositFee"
        ? h.depositFee
        : functionName === "FPC_FUNDING_CUT"
        ? h.fpcCut
        : h.balanceRead ?? h.balance,
  }),
}))
// The DS drags in liquid-glass optics jsdom can't render; this suite is about surface + wiring.
// The registration SIPA's recorded implementation names its portal; its bucket has room.
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readSipaPortalTerms: async () =>
    (await import("./recordedRegistration")).originalTerms(
      "0x00000000000000000000000000000000000000d4",
    ),
}))
const capacity = vi.hoisted(() => ({ availableAtomic: 40_000n * 10n ** 18n }))
vi.mock("../src/features/deposit/capacityStore", async () =>
  (await import("./fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("@obsidion/web-ds", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  Spinner: () => null,
  GradientSpinner: () => null,
  IconCircle: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  TopNavIconButton: ({ onClick, ariaLabel }: { onClick?: () => void; ariaLabel?: string }) => (
    <button aria-label={ariaLabel} onClick={onClick}>
      x
    </button>
  ),
  ConfirmationSheetDetailRow: ({
    label,
    value,
  }: {
    label: React.ReactNode
    value: React.ReactNode
  }) => (
    <div>
      {label}
      {value}
    </div>
  ),
}))

const { RegistrationDepositPrompt } = await import(
  "../src/features/onboarding/RegistrationDepositPrompt"
)
const {
  activationPromptDismissed,
  openActivationPrompt,
  resetActivationPrompt,
  closeActivationPrompt,
} = await import("../src/features/onboarding/activationPrompt")
const { saveRegistrationTerms } = await import("../src/features/onboarding/registrationTerms")
const { getBroadcastLedger, resetBroadcastsForTests } = await import(
  "../src/features/broadcasts/broadcasts"
)
const { getPendingStore } = await import("../src/features/onboarding/webRegistration")
const { saveWalletIdentity } = await import("../src/features/identity/walletIdentity")
const { recordDepositAdmission } = await import("../src/features/identity/admission")
const { askedTotal } = await import("../src/features/onboarding/registrationAsk")
const { formatDepositAmount, formatDepositDue } = await import(
  "../src/features/onboarding/steps/DepositTermsRows"
)
const { stashClaimLink, stashTicketSignup } = await import("../src/features/paylink/claimStash")
const { takeClaimPromptRequest } = await import("../src/features/paylink/claimPrompt")

/** Figures are built from the formatters the sheet prices with, never from its sentences. */
const usd = (amount: bigint) => formatDepositAmount(amount, 18)
const ask = (kind: "standard" | "earned_tag") => formatDepositDue(askedTotal(kind), 18)

const ACCOUNT = "0x00000000000000000000000000000000000000f1"
const L2_ADDRESS = `0x${"22".repeat(32)}` as Hex
const SIPA = "0x00000000000000000000000000000000000000c3"
const { seedRecordedRegistration } = await import("./recordedRegistration")
const DAY = 86_400_000

const record = (over: Partial<PendingRegistrationRecord> = {}) => ({
  tag: "taga",
  nameHash: `0x${"11".repeat(32)}` as Hex,
  l2Address: L2_ADDRESS,
  l1ChainId: 11155111,
  sipaAddress: SIPA as Hex,
  depositToken: "0x00000000000000000000000000000000000000d4" as Hex,
  broadcast: true,
  phase: "awaiting_deposit" as const,
  retries: 0,
  startTime: Date.now(),
  ...over,
})

let container: HTMLDivElement
let root: Root

const render = () =>
  act(async () => {
    root.render(
      <MemoryRouter>
        <ScreeningProvider screener={passThroughScreener}>
          <RegistrationDepositPrompt />
        </ScreeningProvider>
      </MemoryRouter>,
    )
  })
const settleReads = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)

const pendingName = async (over: Partial<PendingRegistrationRecord> = {}) => {
  saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
  await act(async () => {
    await getPendingStore().upsert(ACCOUNT, {}, record(over))
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  // The asked total must come from the constants here, never from a developer's .env.local.
  vi.stubEnv("VITE_REGISTRATION_ASK_DEPOSIT_TOTAL", "")
  vi.stubEnv("VITE_REGISTRATION_EARNED_ASK_DEPOSIT_TOTAL", "")
  ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  localStorage.clear()
  resetActivationPrompt()
  await getPendingStore().load()
  h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
  h.balance = 0n
  h.balanceRead = undefined
  h.fpcCut = 0n
  h.depositFee = 0n
  h.l1Account = null
  h.writeContract.mockReset().mockResolvedValue(`0x${"11".repeat(32)}`)
  await seedRecordedRegistration({
    sipaAddress: SIPA,
    token: "0x00000000000000000000000000000000000000d4",
    registrationFee: 10n * 10n ** 18n,
    l1ChainId: 11155111,
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllEnvs()
})

describe("activation prompt store", () => {
  it("a dismissal holds for the tab and the record it was dismissed for, and no other", () => {
    const mine = { ...record(), account: ACCOUNT } as PendingRegistrationRecord
    expect(activationPromptDismissed(mine)).toBe(false)
    closeActivationPrompt(mine)
    expect(activationPromptDismissed(mine)).toBe(true)
    expect(
      activationPromptDismissed({
        ...mine,
        account: "0x00000000000000000000000000000000000000f2",
      } as PendingRegistrationRecord),
    ).toBe(false)
    expect(activationPromptDismissed(null)).toBe(false)
  })
})

describe("RegistrationDepositPrompt", () => {
  it("renders nothing without a pending identity waiting on its deposit, or once this tab closed it", async () => {
    await render()
    expect(container.textContent).toBe("")

    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1 })
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, record())
    })
    await render()
    expect(container.textContent).toBe("")

    await pendingName()
    closeActivationPrompt(getPendingStore().current())
    await render()
    expect(container.textContent).toBe("")

    // Asked for, it opens regardless of the dismissal.
    await act(async () => openActivationPrompt())
    expect(container.textContent).toContain("Activate account")
  })

  it("asks for the deposit with the account's own signed terms and the address it reserved", async () => {
    await pendingName()
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor((Date.now() + 3 * DAY) / 1000),
      fee: "10000000000000000000",
      minDeposit: "5000000000000000000",
      feeWaived: false,
    })
    await render()
    await settleReads()
    const text = container.textContent!
    expect(text).toContain("Activate account")
    expect(text).toContain("@taga")
    expect(text).toContain("Reserved until")
    expect(text).toContain(
      `Send at least ${ask("standard")} to claim your tag and activate your account.`,
    )
    expect(text).toContain(`Tag price${usd(10n * 10n ** 18n)}`)
    expect(text).toContain(`Opening balance${usd(5n * 10n ** 18n)}`)
    expect(container.querySelector(`[aria-label="Copy deposit address ${SIPA}"]`)).not.toBeNull()

    expect(button("Later")).toBeUndefined()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(),
    )
    expect(container.textContent).toBe("")
    expect(activationPromptDismissed(getPendingStore().current())).toBe(true)
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it("a waived fee activates at the earned ask", async () => {
    await pendingName()
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor((Date.now() + 3 * DAY) / 1000),
      fee: "0",
      minDeposit: "5000000000000000000",
      feeWaived: true,
    })
    await render()
    await settleReads()
    expect(container.textContent).toContain("Activate account")
    expect(container.textContent).toContain("The tag is free.")
    expect(container.textContent).toContain("Tag priceWaived")
    expect(container.textContent).toContain(`Total to send${ask("earned_tag")}`)
  })

  it("a deposit at the address reports itself instead of asking again", async () => {
    await pendingName()
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor((Date.now() + 3 * DAY) / 1000),
      fee: "10000000000000000000",
      minDeposit: "5000000000000000000",
      feeWaived: false,
    })
    h.balance = 15n * 10n ** 18n
    await render()
    await settleReads()
    await settleReads()
    expect(container.textContent).toContain("Deposit received")
    expect(container.textContent).not.toContain(
      `Send at least ${ask("standard")} to claim your tag and activate your account.`,
    )
  })

  it("an earned deposit against a quote the earned price cannot use is recovered, never topped up", async () => {
    // $5 landed and admitted at an address committed to the paid $10 + $5 quote.
    await pendingName({ fee: "10000000000000000000" })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor((Date.now() + 3 * DAY) / 1000),
      fee: "10000000000000000000",
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    h.balance = 5n * 10n ** 18n
    expect(recordDepositAdmission(getPendingStore().current()!, h.balance)).toBe(true)
    await render()
    await settleReads()
    await settleReads()
    const text = container.textContent!
    expect(text).toContain("Registration needs recovery")
    expect(text).toContain("Recover its funds before requesting a new address")
    expect(text).not.toContain("Send at least")
    expect(text).not.toContain("Send $")
    expect(container.querySelector('[aria-label^="Copy deposit address"]')).toBeNull()
    expect(button("Connect your wallet")).toBeUndefined()
    await act(async () => button("Recover deposit")!.click())
    expect(h.navigate).toHaveBeenCalledWith("/claim/taga?recovery=1")
  })

  it("a deposit the sheet itself sees at an incompatible address is recovered before it is admitted", async () => {
    await pendingName({ fee: "10000000000000000000" })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor((Date.now() + 3 * DAY) / 1000),
      fee: "10000000000000000000",
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    // Below the earned total: nothing admits it, the address still holds it.
    h.balance = 3n * 10n ** 18n
    await render()
    await settleReads()
    await settleReads()
    expect(container.textContent).toContain("Registration needs recovery")
    expect(container.textContent).not.toContain("Send at least")
    expect(container.querySelector('[aria-label^="Copy deposit address"]')).toBeNull()
  })

  it("an earned deposit under the earned quote is received, not recovered", async () => {
    await pendingName({ fee: "0" })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor((Date.now() + 3 * DAY) / 1000),
      fee: "0",
      minDeposit: "5000000000000000000",
      feeWaived: true,
      earnedExpected: true,
    })
    h.balance = 5n * 10n ** 18n
    await render()
    await settleReads()
    await settleReads()
    expect(container.textContent).toContain("Deposit received")
    expect(container.textContent).not.toContain("Registration needs recovery")
  })

  it("a sheet reopened after the reservation lapsed withholds the address at once", async () => {
    const start = Date.now()
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(start)
    try {
      await pendingName()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(start / 1000) + 120,
        fee: "10000000000000000000",
        minDeposit: "5000000000000000000",
        feeWaived: false,
      })
      await render()
      await settleReads()
      expect(container.textContent).toContain(
        `Send at least ${ask("standard")} to claim your tag and activate your account.`,
      )
      await act(async () => closeActivationPrompt(getPendingStore().current()))
      expect(container.textContent).toBe("")

      // Home stays open past the deadline; the sheet is then asked for again.
      vi.setSystemTime(start + 3_600_000)
      await act(async () => openActivationPrompt())
      expect(container.textContent).toContain("Your reservation for @taga ended")
      expect(container.textContent).not.toContain(
        `Send at least ${ask("standard")} to claim your tag and activate your account.`,
      )
      expect(container.querySelector('[aria-label^="Copy deposit address"]')).toBeNull()
      expect(button("Register @taga again")).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("an expired reservation hides the address and leads to registering again", async () => {
    await pendingName()
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor((Date.now() - DAY) / 1000),
      fee: "10000000000000000000",
      minDeposit: "5000000000000000000",
      feeWaived: false,
    })
    await render()
    await settleReads()
    expect(container.textContent).toContain("Your reservation for @taga ended")
    expect(container.querySelector('[aria-label^="Copy deposit address"]')).toBeNull()
    await act(async () => button("Register @taga again")!.click())
    expect(h.navigate).toHaveBeenCalledWith("/claim/taga")
  })
})

const paidTerms = (over: { minDeposit?: string; deadline?: number } = {}) =>
  saveRegistrationTerms({
    account: ACCOUNT,
    tag: "taga",
    deadline: Math.floor((Date.now() + DAY) / 1000),
    fee: "10000000000000000000",
    minDeposit: "5000000000000000000",
    feeWaived: false,
    ...over,
  })

describe("RegistrationDepositPrompt — unpublished registration", () => {
  it("withholds the address once nothing re-sends it, and leads to the pending step's retry", async () => {
    await pendingName({ broadcast: false, retries: 3, startTime: Date.now() - 3_600_000 })
    paidTerms()
    await render()
    await settleReads()
    const text = container.textContent!
    expect(text).toContain("Activate account")
    expect(text).toContain("Reserved until")
    expect(text).toContain("Your deposit address was not published")
    expect(text).not.toContain(
      `Send at least ${ask("standard")} to claim your tag and activate your account.`,
    )
    expect(container.querySelector('[aria-label^="Copy deposit address"]')).toBeNull()
    expect(button("Connect your wallet")).toBeUndefined()
    await act(async () => button("Check registration")!.click())
    expect(h.navigate).toHaveBeenCalledWith("/claim/taga")
  })

  it("shows an unpublished registration's address at once, owes its broadcast, and shows its status until it lands", async () => {
    resetBroadcastsForTests()
    await pendingName({ broadcast: false, retries: 1 })
    paidTerms()
    await render()
    await settleReads()
    await vi.waitFor(() =>
      expect(getBroadcastLedger().get(SIPA)).toMatchObject({ kind: "registration" }),
    )
    expect(container.textContent).toContain(
      `Send at least ${ask("standard")} to claim your tag and activate your account.`,
    )
    expect(container.textContent).not.toContain("was not published")
    // Safe to fund now: the ledger publishes it, and funds wait at the address meanwhile.
    expect(container.querySelector(`[aria-label="Copy deposit address ${SIPA}"]`)).not.toBeNull()
    expect(
      container.querySelector('[data-testid="registration-address-publishing"]'),
    ).not.toBeNull()
    expect(button("Check registration")).toBeUndefined()

    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { broadcast: true })
    })
    await settleReads()
    expect(container.querySelector(`[aria-label="Copy deposit address ${SIPA}"]`)).not.toBeNull()
    expect(container.querySelector('[data-testid="registration-address-publishing"]')).toBeNull()
  })

  it("owes nothing for an address it does not show", async () => {
    resetBroadcastsForTests()
    await pendingName({ broadcast: false, retries: 3 })
    paidTerms({ deadline: Math.floor((Date.now() - DAY) / 1000) })
    await render()
    await settleReads()
    expect(container.textContent).toContain("Your reservation for @taga ended")
    expect(getBroadcastLedger().get(SIPA)).toBeNull()
  })

  it("an unpublished registration whose reservation ended leads to registering again", async () => {
    await pendingName({ broadcast: false, retries: 3 })
    paidTerms({ deadline: Math.floor((Date.now() - DAY) / 1000) })
    await render()
    await settleReads()
    expect(container.textContent).toContain("Your reservation for @taga ended")
    expect(container.textContent).not.toContain("was not published")
    expect(button("Check registration")).toBeUndefined()
    expect(button("Register @taga again")).toBeDefined()
  })
})

describe("RegistrationDepositPrompt — swept deposit", () => {
  const SWEEP = `0x${"33".repeat(32)}` as Hex
  /** What the detector stamps when the sweep lands before the registry read confirms the name. */
  const sweepObserved = () =>
    act(async () => {
      await getPendingStore().upsert(ACCOUNT, { sweptAt: Date.now(), sweepTxHash: SWEEP })
    })
  const expectReported = () => {
    const text = container.textContent!
    expect(text).toContain("Activate account")
    expect(text).toContain("Deposit received")
    expect(text).toContain("Confirming your name")
    expect(text).not.toContain("Send $")
    expect(text).not.toContain("Send at least")
    expect(container.querySelector('[aria-label^="Copy deposit address"]')).toBeNull()
    expect(container.querySelector(".ww-deposit__connect")).toBeNull()
    expect(button("Connect your wallet")).toBeUndefined()
  }

  it("a sheet opened after the sweep reports it, and asks for nothing at the emptied address", async () => {
    await pendingName()
    paidTerms()
    await sweepObserved()
    expect(getPendingStore().current()).toMatchObject({
      phase: "awaiting_deposit",
      sweepTxHash: SWEEP,
    })
    await render()
    await settleReads()
    await settleReads()
    expectReported()
    expect(container.textContent).toContain("Reserved until")
  })

  it("a sheet already open stops asking the moment the sweep is recorded", async () => {
    await pendingName()
    paidTerms()
    await render()
    await settleReads()
    await settleReads()
    expect(container.textContent).toContain(
      `Send at least ${ask("standard")} to claim your tag and activate your account.`,
    )
    expect(container.querySelector(`[aria-label="Copy deposit address ${SIPA}"]`)).not.toBeNull()
    await sweepObserved()
    expectReported()
  })

  it("a sweep outranks a lapsed reservation and a stalled publication", async () => {
    await pendingName({ broadcast: false, retries: 3, startTime: Date.now() - 3_600_000 })
    paidTerms({ deadline: Math.floor((Date.now() - DAY) / 1000) })
    await sweepObserved()
    await render()
    await settleReads()
    await settleReads()
    expectReported()
    expect(container.textContent).not.toContain("ended")
    expect(container.textContent).not.toContain("was not published")
    expect(button("Register @taga again")).toBeUndefined()
    expect(button("Check registration")).toBeUndefined()
  })

  it("a funded stamp is reported the same way once the address reads empty", async () => {
    await pendingName({ fundedAt: Date.now() })
    paidTerms()
    await render()
    await settleReads()
    await settleReads()
    expectReported()
  })

  it("closes once the record is promoted, and does not open again on entry", async () => {
    await pendingName({ fundedAt: Date.now() })
    paidTerms()
    await render()
    await settleReads()
    expectReported()
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { phase: "funded" })
    })
    expect(container.textContent).toBe("")
    act(() => root.unmount())
    root = createRoot(container)
    await render()
    await settleReads()
    expect(container.textContent).toBe("")
  })

  it("without sweep evidence an empty address is asked for, and a partial one is topped up", async () => {
    await pendingName()
    paidTerms()
    await render()
    await settleReads()
    await settleReads()
    expect(container.textContent).toContain(
      `Send at least ${ask("standard")} to claim your tag and activate your account.`,
    )
    expect(container.querySelector(`[aria-label="Copy deposit address ${SIPA}"]`)).not.toBeNull()
    expect(container.querySelector(".ww-deposit__connect")).not.toBeNull()
    expect(container.textContent).not.toContain("Deposit received")

    await act(async () => root.unmount())
    root = createRoot(container)
    h.balance = 5n * 10n ** 18n
    await render()
    await settleReads()
    await settleReads()
    const summary = container.querySelector(".ww-reg-sheet__summary")?.textContent
    expect(summary).toContain("$5.00 of $15.00 received. Send at least $10.00 more")
    expect(container.querySelector(`[aria-label="Copy deposit address ${SIPA}"]`)).not.toBeNull()
  })
})

describe("RegistrationDepositPrompt: the waiting block", () => {
  it("waits under the address with the balance there, and the pill reads the address again", async () => {
    await pendingName()
    paidTerms()
    await render()
    await settleReads()
    await settleReads()
    expect(container.querySelector(".ww-deposit-sheet__live")!.textContent).toContain(
      "Waiting for deposit",
    )
    const line = () => container.querySelector('[data-testid="deposit-balance"]')!.textContent
    expect(line()).toBe("Balance at this address: $0.00 · Last checked 0s ago")
    h.balance = 5n * 10n ** 18n
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="deposit-check-again"]')!.click(),
    )
    await settleReads()
    await settleReads()
    expect(line()).toBe(
      "$5.00 of $15.00 received · Send at least $10.00 more · Last checked 0s ago",
    )
  })

  it("the pill stays busy until its read of the address lands", async () => {
    await pendingName()
    paidTerms()
    await render()
    await settleReads()
    await settleReads()
    const pill = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="deposit-check-again"]')!
    let land!: (balance: bigint) => void
    h.balanceRead = new Promise((resolve) => (land = resolve))
    await act(async () => pill().click())
    await act(async () => new Promise((r) => setTimeout(r, 800)))
    expect(pill().disabled).toBe(true)
    expect(pill().textContent).toContain("Check again")
    h.balanceRead = undefined
    await act(async () => land(5n * 10n ** 18n))
    await settleReads()
    await settleReads()
    expect(pill().disabled).toBe(false)
    expect(pill().textContent).toBe("Checked")
    expect(container.querySelector('[data-testid="deposit-balance"]')!.textContent).toContain(
      "$5.00 of $15.00 received",
    )
  })
})

describe("RegistrationDepositPrompt — required amounts", () => {
  it("a sub-cent shortfall is asked for as a cent, never as nothing", async () => {
    await pendingName()
    paidTerms()
    h.balance = 14_999n * 10n ** 15n
    await render()
    await settleReads()
    await settleReads()
    const summary = container.querySelector(".ww-reg-sheet__summary")?.textContent
    expect(summary).toContain("$14.99 of $15.00 received. Send at least $0.01 more")
    expect(summary).not.toContain("$0.00")
    expect(container.textContent).not.toContain("Deposit received")
  })

  it("the connected wallet sends the exact shortfall, not the rounded one", async () => {
    h.l1Account = "0x00000000000000000000000000000000000000aa"
    await pendingName()
    paidTerms()
    h.balance = 14_999n * 10n ** 15n
    await render()
    await settleReads()
    await settleReads()
    const pay = container.querySelector<HTMLButtonElement>(".ww-deposit__connect")!
    expect(pay.textContent).toContain("from Rainbow")
    expect(pay.disabled).toBe(false)
    await act(async () => pay.click())
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("dialog button")].find(
      (b) => b.textContent === "Confirm payment",
    )!
    await act(async () => confirm.click())
    await settleReads()
    expect(h.writeContract).toHaveBeenCalledTimes(1)
    expect(h.writeContract.mock.calls[0][0]).toMatchObject({
      functionName: "transfer",
      args: [SIPA, 10n ** 15n],
    })
  })

  it("a floor above the ask is what is asked for, rounded up to the cent", async () => {
    await pendingName()
    paidTerms({ minDeposit: "5004000000000000000" })
    await render()
    await settleReads()
    const text = container.textContent!
    expect(text).toContain("Send at least $15.01 to claim your tag and activate your account.")
    expect(text).toContain("Total to send$15.01")
    expect(text).toContain("Opening balance$5.00")
  })
})

describe("deposit amount formatters", () => {
  it("what is due rounds up to the cent, what was seen rounds down, in the token's own units", async () => {
    const { formatDepositAmount, formatDepositDue, formatDepositSeen } = await import(
      "../src/features/onboarding/steps/DepositTermsRows"
    )
    const dai = (v: string) => BigInt(v.replace(".", "").padEnd(v.indexOf(".") + 18, "0"))
    expect(formatDepositDue(dai("15.0"), 18)).toBe("$15.00")
    expect(formatDepositDue(dai("0.001"), 18)).toBe("$0.01")
    expect(formatDepositDue(1n, 18)).toBe("$0.01")
    expect(formatDepositDue(dai("15.005"), 18)).toBe("$15.01")
    expect(formatDepositDue(dai("1234.5"), 18)).toBe("$1,234.50")
    expect(formatDepositDue(0n, 18)).toBe("$0.00")
    expect(formatDepositSeen(dai("14.999"), 18)).toBe("$14.99")
    expect(formatDepositSeen(dai("15.0"), 18)).toBe("$15.00")
    expect(formatDepositSeen(1n, 18)).toBe("$0.00")
    // A six-decimal token and a cent-precision one round the same way.
    expect(formatDepositDue(14_999_001n, 6)).toBe("$15.00")
    expect(formatDepositSeen(14_999_999n, 6)).toBe("$14.99")
    expect(formatDepositDue(1501n, 2)).toBe("$15.01")
    expect(formatDepositDue(15n, 0)).toBe("$15.00")
    // The informational split keeps nearest rounding.
    expect(formatDepositAmount(dai("15.005"), 18)).toBe("$15.01")
    expect(formatDepositAmount(dai("15.004"), 18)).toBe("$15.00")
  })
})

describe("RegistrationDepositPrompt — a ticket-funded name", () => {
  const ONE = 10n ** 18n
  const ticketTerms = (over: Record<string, unknown> = {}) =>
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      fee: (ONE / 2n).toString(),
      minDeposit: "0",
      feeWaived: true,
      paylinkFunded: true,
      paylinkId: "id:paylink-frag",
      ...over,
    })
  const stash = (fragment = "paylink-frag") =>
    stashTicketSignup({
      fragment,
      threshold: (2n * ONE).toString(),
      schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
      amount: (3n * ONE).toString(),
    })
  const renderAt = (path: string) =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <ScreeningProvider screener={passThroughScreener}>
            <RegistrationDepositPrompt />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })

  beforeEach(() => {
    sessionStorage.clear()
    h.fpcCut = ONE / 10n
    h.depositFee = ONE / 2n
  })

  it("never asks a ticket-funded name for the earned deposit, whatever the reduced flag says", async () => {
    await pendingName()
    ticketTerms()
    await render()
    await act(async () => openActivationPrompt())
    await settleReads()
    const text = container.textContent!
    expect(text).not.toContain(ask("earned_tag"))
    expect(text).not.toContain("Total to send")
    expect(text).not.toContain(SIPA)
    expect(text).toContain("Open the link you were sent again")
    expect(button("Check registration")).toBeTruthy()
    await act(async () => button("Check registration")!.click())
    expect(h.navigate).toHaveBeenCalledWith("/claim/taga")
  })

  it("leaves a ready claim to Home's review on Home, and routes to it from anywhere else", async () => {
    await pendingName()
    // The prover tip the signup's split committed.
    ticketTerms({ proverTip: ONE.toString() })
    stash()
    await renderAt("/")
    expect(container.textContent).toBe("")

    await act(async () => openActivationPrompt())
    await settleReads()
    const text = container.textContent!
    expect(text).toContain("Claim your payment")
    // The burn at a 0.1 cut on each leg: 0.5 + 0.1 + 0.01 to the SIPA, 0.1 + 0.1 + 1 on the way.
    expect(text).toContain(`You'll receive${formatUnits(119n * 10n ** 16n, 18)} DAI`)
    expect(text).toContain(`Network fee${formatUnits(181n * 10n ** 16n, 18)} DAI`)
    expect(text).toContain("Tag priceWaived")
    expect(text).not.toContain(ask("earned_tag"))
    await act(async () => button("Claim your payment")!.click())
    expect(takeClaimPromptRequest()).toBe("paylink-frag")
    expect(h.navigate).not.toHaveBeenCalled()
    expect(container.textContent).toBe("")

    await act(async () => root.unmount())
    root = createRoot(container)
    resetActivationPrompt()
    await renderAt("/receive")
    await settleReads()
    expect(container.textContent).toContain("Claim your payment")
    await act(async () => button("Claim your payment")!.click())
    expect(takeClaimPromptRequest()).toBe("paylink-frag")
    expect(h.navigate).toHaveBeenCalledWith("/")
  })

  it("offers the claim for the bound link reopened without its marker, priced off the terms", async () => {
    await pendingName()
    ticketTerms()
    stashClaimLink("paylink-frag")
    await renderAt("/receive")
    await settleReads()
    const text = container.textContent!
    expect(text).toContain("Claim your payment")
    expect(text).not.toContain("Open the link you were sent again")
    expect(text).toContain("Tag priceWaived")
    // No tip committed: the fee carries none.
    expect(text).toContain(`Network fee${formatUnits(81n * 10n ** 16n, 18)} DAI`)
    await act(async () => button("Claim your payment")!.click())
    expect(takeClaimPromptRequest()).toBe("paylink-frag")
    expect(h.navigate).toHaveBeenCalledWith("/")
  })

  it("holds the claim while the cut that prices it is unread", async () => {
    await pendingName()
    ticketTerms()
    stash()
    h.fpcCut = undefined as unknown as bigint
    await renderAt("/receive")
    await settleReads()
    expect(container.textContent).toContain("Claim your payment")
    // The mocked read answers undefined: the rows wait and the claim is withheld.
    expect(container.textContent).toContain("Checking")
  })

  it("shows progress for a submitted burn and never a second claim or a deposit ask", async () => {
    await pendingName({ fundedAt: Date.now() })
    ticketTerms()
    stash()
    await render()
    await act(async () => openActivationPrompt())
    await settleReads()
    const text = container.textContent!
    expect(text).toContain("Registration pending")
    expect(text).toContain("Nothing to send")
    expect(button("Claim your payment")).toBeUndefined()
    expect(text).not.toContain("Total to send")
  })

  it("keeps a blocked or unpublished binding a ticket, and offers the registration page", async () => {
    await pendingName()
    ticketTerms({ paylinkBlocked: true })
    stash()
    await render()
    await act(async () => openActivationPrompt())
    await settleReads()
    expect(container.textContent).toContain("renewed price is not one this payment covers")
    expect(container.textContent).not.toContain(ask("earned_tag"))
    expect(button("Claim your payment")).toBeUndefined()
    expect(button("Check registration")).toBeTruthy()

    await act(async () => root.unmount())
    root = createRoot(container)
    resetActivationPrompt()
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { broadcast: false })
    })
    ticketTerms({ paylinkBlocked: false })
    await render()
    await settleReads()
    // On Home the hero carries a ticket-funded name; the sheet waits to be asked.
    expect(container.textContent).toBe("")
    await act(async () => openActivationPrompt())
    await settleReads()
    expect(container.textContent).toContain("Publishing your deposit address")
    expect(button("Check registration")).toBeTruthy()

    // Once nothing re-sends the address, the sheet says so.
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { retries: 3 })
    })
    await settleReads()
    expect(container.textContent).toContain("was not published")
    expect(button("Check registration")).toBeTruthy()
  })
})
