import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  formatDateLabel,
  formatTimeLabel,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { formatUnits, type Hex } from "viem"
import {
  ACCOUNT,
  DAI as ONE,
  FAR_DEADLINE,
  L2_ADDRESS,
  pendingRecord,
  registrationTerms,
  resetRegistrationStores,
  seedRegistrationRail,
  ticketBoundTerms,
  ticketSignupStash,
} from "./support/registrationFixtures"

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  config: { network: "testnet", l1Chain: { name: "Sepolia" }, rpId: "localhost" },
  amounts: { min: 0n, fee: 0n },
  /** How many times the controller's schedule was actually read. */
  scheduleReads: 0,
  detailPay: undefined as { total: bigint } | undefined,
  /** What the fake token answers for balanceOf(sipa). */
  balance: 0n,
  /** Portal deductions the banner's refund verdict reads; undefined while unread. */
  deductions: undefined as { fpcCut: bigint } | undefined,
  /** The relayer's sweep fee; undefined while unread. */
  sweepFee: undefined as bigint | undefined,
  /** The pending-deposit observer; none unless a test states a processing reason. */
  observer: undefined as { stateFor: () => unknown; subscribe: () => () => void } | undefined,
}))

vi.mock("../src/features/deposit/sipaProcessing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/sipaProcessing")>()),
  sipaProcessingObserver: () => h.observer,
}))

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => h.config,
}))
// Fake fragments never decode; the binding only needs a stable name for one.
vi.mock("../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ registry: "0x00000000000000000000000000000000000000e4" }),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  l1PublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "REGISTRATION_MIN"
        ? (h.scheduleReads++, h.amounts.min)
        : functionName === "REGISTRATION_FEE"
        ? h.amounts.fee
        : h.balance,
  }),
}))
vi.mock("@obsidion/web-ds", () => ({
  ActivityListRow: ({ amount, onClick }: { amount?: string; onClick: () => void }) => (
    <button onClick={onClick}>
      <span data-testid="registration-row-amount">{amount}</span>
    </button>
  ),
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  Spinner: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
}))

vi.mock("../src/features/onboarding/registrationTerms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/registrationTerms")>()),
  useSweepDeductions: () => h.deductions,
  useDepositSkim: () => h.sweepFee,
}))
vi.mock("../src/features/onboarding/registrationFunding", () => ({
  useFundingTransfer: () => undefined,
}))
vi.mock("../src/features/onboarding/RegistrationDepositDetailModal", () => ({
  RegistrationDepositDetailModal: ({ pay }: { pay?: { total: bigint } }) => {
    h.detailPay = pay
    return <div data-testid="deposit-detail" />
  },
}))
const { useRegistrationDepositEntry } = await import(
  "../src/features/onboarding/useRegistrationDepositEntry"
)
function DepositFeed() {
  const entry = useRegistrationDepositEntry()
  return (
    <>
      {entry?.node}
      {entry?.modal}
    </>
  )
}

const { SecureNameNoticeCard } = await import("../src/features/onboarding/SecureNameNoticeCard")
const { formatRemaining, saveRegistrationTerms } = await import(
  "../src/features/onboarding/registrationTerms"
)
const { getPendingStore } = await import("../src/features/onboarding/webRegistration")
const { saveWalletIdentity } = await import("../src/features/identity/walletIdentity")
const { recordDepositAdmission } = await import("../src/features/identity/admission")
const { loadRegistrationTerms } = await import("../src/features/onboarding/registrationTerms")
const { askedTotal } = await import("../src/features/onboarding/registrationAsk")
const { DETECTING_AMOUNT } = await import("../src/features/onboarding/useRegistrationDepositEntry")
const { REGISTRATIONS_PAUSED_NOTICE } = await import(
  "../src/features/onboarding/onboardingErrorCopy"
)
const { stashClaimLink, stashTicketSignup } = await import("../src/features/paylink/claimStash")
const { takeClaimPromptRequest } = await import("../src/features/paylink/claimPrompt")
const { startClaim, endClaim } = await import("../src/features/paylink/runningClaims")

/** The ask, figure-free: the sheet the banner opens names the amount. */
const ASK = "Send a deposit to keep @taga."
const notice = (id: string) =>
  container.querySelector(`[data-testid="${id}"]`)?.textContent ?? undefined

const DAY = 86_400_000

const record = pendingRecord
/** The registration's deposit has reached the address, and the hero reports it rather than asks. */
const expectReported = () => {
  expect(container.querySelector('[data-testid="deposit-detected"]')).not.toBeNull()
  expect(container.textContent).toContain("Claiming @taga")
  expect(container.textContent).toContain("Deposit received. This only takes a moment.")
  expect(container.textContent).not.toContain("Activate account")
  expect(container.textContent).not.toContain("Send a deposit")
}

let container: HTMLDivElement
let root: Root

const render = () =>
  act(async () => {
    root.render(
      <MemoryRouter>
        <SecureNameNoticeCard />
      </MemoryRouter>,
    )
  })
const settleReads = () => act(async () => new Promise((r) => setTimeout(r, 0)))

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubEnv("VITE_REGISTRATION_ASK_DEPOSIT_TOTAL", "")
  resetRegistrationStores()
  localStorage.clear()
  await getPendingStore().load()
  h.amounts = { min: 0n, fee: 0n }
  h.scheduleReads = 0
  h.balance = 0n
  h.deductions = { fpcCut: 25n * 10n ** 16n }
  h.sweepFee = 5n * 10n ** 17n
  h.detailPay = undefined
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllEnvs()
})

describe("SecureNameNoticeCard", () => {
  it("renders nothing without a pending identity waiting on its deposit", async () => {
    await render()
    expect(container.textContent).toBe("")

    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1 })
    await getPendingStore().upsert(ACCOUNT, {}, record())
    await render()
    expect(container.textContent).toBe("")
  })

  it("names the tag free without a figure, and leads to the address", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(
      registrationTerms({
        deadline: Math.floor((Date.now() + 3 * DAY) / 1000),
        fee: String(5n * 10n ** 17n),
        minDeposit: String(45n * 10n ** 17n),
        feeWaived: true,
      }),
    )
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, record())
    })
    await render()
    await settleReads()

    const body = notice("secure-name-notice")!
    expect(body).toContain("Activate account")
    expect(body).toContain("Reserved until")
    expect(body).toContain(ASK)
    expect(body).toContain("The tag is free.")
    // Every figure is the sheet's: the hero prices nothing.
    expect(body).not.toContain("$")
    await act(async () => container.querySelector("button")!.click())
    expect(h.navigate).toHaveBeenCalledWith("/claim/taga")
  })

  it("names no received figure while the total is still being priced", async () => {
    // The portal cut is unread, so an earned tag has no total yet. What is already at the address
    // is the sheet's to name, not the hero's.
    h.deductions = undefined
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(
      registrationTerms({
        deadline: Math.floor((Date.now() + 3 * DAY) / 1000),
        fee: String(5n * 10n ** 17n),
        minDeposit: String(45n * 10n ** 17n),
        feeWaived: true,
        depositAmount: String(4n * 10n ** 18n),
      }),
    )
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, record())
    })
    await render()
    await settleReads()

    const body = notice("secure-name-notice")!
    expect(body).toContain(ASK)
    expect(body).toContain("The tag is free.")
    expect(body).not.toContain("received")
    expect(body).not.toContain("$")
  })

  /** A registration whose rail record shows the sweep under way, its record not yet stamped. */
  const railSweeping = async (startTime = 1) => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    const rec = record()
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, rec)
      await seedRegistrationRail(rec, { phase: "sweeping" }, { startTime })
    })
    await render()
    await settleReads()
  }

  it("keeps the claiming hero's short wait for a deposit on its way", async () => {
    await railSweeping(Date.now())
    expect(container.textContent).toContain("Claiming @taga")
    expect(container.textContent).toContain("Receiving. This only takes a moment.")
  })

  it.each([
    ["once the sweep is stuck", undefined, "Receiving."],
    ["for an aged reason the rail states", { reason: { kind: "checking" } }, "Checking status."],
    [
      "while a stated blocker holds the sweep",
      {
        reason: {
          kind: "capacity",
          requiredAtomic: 5n * 10n ** 18n,
          availableAtomic: 10n ** 18n,
          refill: { status: "unknown" },
          decimals: 18,
          observedAt: 1,
        },
        blocker: { kind: "capacity", observedAt: 1 },
      },
      "Waiting for capacity.",
    ],
  ])("promises no short wait %s", async (_, state, status) => {
    h.observer = state && { stateFor: () => state, subscribe: () => () => {} }
    try {
      await railSweeping()
      expect(container.textContent).toContain("Claiming @taga")
      expect(container.textContent).toContain(status)
      expect(container.textContent).not.toContain("only takes a moment")
    } finally {
      h.observer = undefined
    }
  })
  it("asks without a figure when nothing is waived, and holds once the deposit is seen", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(
      registrationTerms({
        deadline: Math.floor((Date.now() + 5 * 3_600_000) / 1000),
        feeWaived: false,
      }),
    )
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, record())
    })
    await render()
    await settleReads()
    const body = notice("secure-name-notice")!
    expect(body).toContain(ASK)
    expect(body).not.toContain("The tag is free.")
    expect(body).not.toContain("$")

    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { phase: "funded", fundedAt: Date.now() })
    })
    // Funded and broadcast is precisely the claiming state, so the hero holds rather than leaves.
    expect(container.textContent).toContain("Claiming @taga")
  })

  it("reads no schedule for a registration no claim was signed for", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, record())
    })
    await render()
    await settleReads()
    expect(notice("secure-name-notice")).toContain(ASK)
    expect(h.scheduleReads).toBe(0)
  })
})

describe("SecureNameNoticeCard — deposit admission", () => {
  it.each(["reopen", "mounted", "expired"])(
    "keeps a paid registration pending on %s",
    async (state) => {
      saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
      saveRegistrationTerms(
        registrationTerms({
          deadline: state === "expired" ? 1 : 4102444800,
          fee: "10000000000000000000",
          minDeposit: "5000000000000000000",
          feeWaived: false,
        }),
      )
      await getPendingStore().upsert(ACCOUNT, {}, record())
      const original = getPendingStore().current()!
      const terms = loadRegistrationTerms(ACCOUNT)
      if (state === "mounted") {
        await render()
        await settleReads()
        expect(notice("secure-name-notice")).toContain(ASK)
      }
      await act(async () => {
        recordDepositAdmission(original, 5n * 10n ** 18n)
      })
      if (state !== "mounted") await render()
      expect(notice("registration-pending-notice")).toBeDefined()
      // Paid and admitted: neither the ask nor the past-deadline refresh replaces the pending hero.
      expect(notice("secure-name-notice")).toBeUndefined()
      await act(async () => container.querySelector("button")!.click())
      expect(h.navigate).toHaveBeenCalledWith("/claim/taga?recovery=1")
      expect(getPendingStore().current()).toEqual(original)
      expect(loadRegistrationTerms(ACCOUNT)).toEqual(terms)
    },
  )

  it("asks for the deposit again once a refunded registration resumes", async () => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    const legacy = record({ fee: "500000000000000000" })
    await getPendingStore().upsert(ACCOUNT, {}, legacy)
    await seedRegistrationRail(
      legacy,
      { phase: "recovered" },
      { amount: "5", recoveryTxHash: legacy.nameHash },
    )
    const terms = {
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor((Date.now() + 3 * DAY) / 1000),
      fee: "500000000000000000",
      feeWaived: true,
      earnedExpected: true,
    }
    // The refund is history and the address wants its deposit.
    saveRegistrationTerms({ ...terms, minDeposit: "4500000000000000000" })
    await render()
    await settleReads()
    const body = notice("secure-name-notice")!
    expect(body).toContain(ASK)
    expect(body).toContain("The tag is free.")
    expect(body).not.toContain("Do not send another deposit")
  })

  it("routes a funded deposit under a quote the earned price cannot use to recovery", async () => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    h.amounts = { min: 5n * 10n ** 18n, fee: 0n }
    await getPendingStore().upsert(
      ACCOUNT,
      {},
      record({ fee: "10000000000000000000", phase: "funded", fundedAt: 1 }),
    )
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: "0",
      minDeposit: "5000000000000000000",
      feeWaived: true,
      earnedExpected: true,
    })
    recordDepositAdmission(getPendingStore().current()!, 10n * 10n ** 18n)
    await render()
    await settleReads()
    expect(notice("registration-pending-notice")).toContain("Registration needs recovery")
    expect(notice("claiming-notice")).toBeUndefined()
  })

  it("does not use another deposit address's receipt", async () => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    await getPendingStore().upsert(ACCOUNT, {}, record())
    recordDepositAdmission(
      { ...getPendingStore().current()!, sipaAddress: "0xother" },
      5n * 10n ** 18n,
    )
    await render()
    await settleReads()
    expect(notice("secure-name-notice")).toContain(ASK)
    expect(notice("registration-pending-notice")).toBeUndefined()
  })
})

describe("registration deposit entry — deposit admission", () => {
  it.each([true, false])(
    "payment controls follow this registration's admission: %s",
    async (admitted) => {
      saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
      saveRegistrationTerms(
        registrationTerms({
          deadline: Number(FAR_DEADLINE),
          fee: "10000000000000000000",
          minDeposit: "5000000000000000000",
          feeWaived: false,
          depositAmount: "5000000000000000000",
        }),
      )
      await getPendingStore().upsert(ACCOUNT, {}, record({ fee: "10000000000000000000" }))
      const original = getPendingStore().current()!
      const saved = loadRegistrationTerms(ACCOUNT)
      recordDepositAdmission(
        { ...original, ...(admitted ? {} : { sipaAddress: "0xother" }) },
        5n * 10n ** 18n,
      )
      await act(async () =>
        root.render(
          <MemoryRouter>
            <DepositFeed />
          </MemoryRouter>,
        ),
      )
      await settleReads()
      await act(async () => container.querySelector("button")!.click())
      expect(container.querySelector("[data-testid='deposit-detail']")).not.toBeNull()
      if (admitted) expect(h.detailPay).toBeUndefined()
      else expect(h.detailPay?.total).toBe(askedTotal("standard"))
      expect(getPendingStore().current()).toEqual(original)
      expect(loadRegistrationTerms(ACCOUNT)).toEqual(saved)
    },
  )

  /** The feed row for one registration, with the terms and the deposit it has been stamped with. */
  const feedRow = async (over: {
    deposited: bigint
    fee?: string
    minDeposit?: string
    feeWaived?: boolean
  }) => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(
      registrationTerms({
        deadline: Number(FAR_DEADLINE),
        fee: over.fee ?? "10000000000000000000",
        minDeposit: over.minDeposit ?? "5000000000000000000",
        feeWaived: over.feeWaived ?? false,
        depositAmount: String(over.deposited),
      }),
    )
    await getPendingStore().upsert(ACCOUNT, {}, record({ fee: over.fee ?? "10000000000000000000" }))
    await act(async () =>
      root.render(
        <MemoryRouter>
          <DepositFeed />
        </MemoryRouter>,
      ),
    )
    await settleReads()
    return notice("registration-row-amount")
  }

  it("projects the credit once the deposit clears the floor", async () => {
    // The whole ask deposited, against a 10 DAI fee and the portal's cut: the sweep credits the rest.
    const amount = await feedRow({ deposited: askedTotal("standard") })
    const credit = askedTotal("standard") - 10n * 10n ** 18n - h.deductions!.fpcCut
    expect(amount).toContain(formatUnits(credit, 18))
  })

  it("shows the deposited gross unsigned for a deposit the chain would refuse", async () => {
    // Short of the floor, so nothing is credited — but every figure is known, and the row reads as
    // an incomplete deposit rather than a read still running.
    const amount = await feedRow({ deposited: 5n * 10n ** 18n })
    expect(amount).toBe("$5")
  })

  it("names no credit while the portal's cut is unread", async () => {
    h.deductions = undefined
    const amount = await feedRow({ deposited: askedTotal("standard") })
    expect(amount).toBe(DETECTING_AMOUNT)
  })

  it("names the deposited gross when no schedule is signed and none is being read", async () => {
    // Deadline 0: a stamped record, so nothing signed a schedule and nothing reads the chain's.
    // The row is settled at what arrived rather than promising a figure no read will bring.
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(
      registrationTerms({
        deadline: 0,
        feeWaived: false,
        depositAmount: String(5n * 10n ** 18n),
      }),
    )
    await getPendingStore().upsert(ACCOUNT, {}, record())
    await act(async () =>
      root.render(
        <MemoryRouter>
          <DepositFeed />
        </MemoryRouter>,
      ),
    )
    await settleReads()

    expect(h.scheduleReads).toBe(0)
    expect(notice("registration-row-amount")).toBe("$5")
  })

  it("names the deposited gross once the chain answers a fee this address is not committed to", async () => {
    // The read landed and prices another fee, so nothing will price this record: the row is
    // settled at what arrived instead of holding the placeholder.
    h.amounts = { min: 5n * 10n ** 18n, fee: 7n * 10n ** 18n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(
      registrationTerms({
        deadline: Number(FAR_DEADLINE),
        feeWaived: false,
        depositAmount: String(5n * 10n ** 18n),
      }),
    )
    await getPendingStore().upsert(ACCOUNT, {}, record({ fee: String(5n * 10n ** 18n) }))
    await act(async () =>
      root.render(
        <MemoryRouter>
          <DepositFeed />
        </MemoryRouter>,
      ),
    )
    await settleReads()

    expect(h.scheduleReads).toBeGreaterThan(0)
    expect(notice("registration-row-amount")).toBe("$5")
  })

  it("quotes the earned ask for a waived tag the deployment's own schedule prices", async () => {
    // A stored waiver whose signed schedule is unpriced falls back to the chain's, whose floor
    // sits under the earned ask, so the ask is what the pay figure names.
    h.amounts = { min: 44n * 10n ** 17n, fee: 5n * 10n ** 17n }
    await feedRow({ deposited: 10n ** 18n, feeWaived: true, fee: "0", minDeposit: "0" })
    await act(async () => container.querySelector("button")!.click())
    expect(h.detailPay?.total).toBe(askedTotal("earned_tag"))
  })

  // Zero immutables take no registration by deposit, and a fee below the relayer's sweep fee can
  // never fund one: the detail withholds the pay block rather than name a figure no sweep accepts.
  it.each([
    ["the deployment prices no registration", { min: 0n, fee: 0n }],
    [
      "the schedule's fee sits under the relayer's sweep fee",
      { min: 44n * 10n ** 17n, fee: 10n ** 17n },
    ],
  ])("asks for nothing where %s", async (_, amounts) => {
    h.amounts = amounts
    await feedRow({ deposited: 10n ** 18n, feeWaived: true, fee: "0", minDeposit: "0" })
    await act(async () => container.querySelector("button")!.click())
    expect(h.detailPay).toBeUndefined()
  })
})

describe("SecureNameNoticeCard — a quote past its deadline", () => {
  it("offers the refresh rather than saying the name was lost", async () => {
    h.amounts = { min: 44n * 10n ** 17n, fee: 5n * 10n ** 17n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(
      registrationTerms({
        deadline: Math.floor(Date.now() / 1000) - 60,
        feeWaived: true,
      }),
    )
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, record())
    })
    await render()
    // The deadline is the claim signature's, never the 7-day hold, so nothing here says the tag
    // was given up.
    expect(container.textContent).not.toContain("free again")
    expect(container.textContent).toContain("refresh")
    // The banner is the control now, so the whole card is the click target.
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Activate @taga")
    await act(async () => container.querySelector("button")!.click())
    expect(h.navigate).toHaveBeenCalledWith("/claim/taga")
  })

  it("says activation is paused where this deployment prices no registration", async () => {
    h.amounts = { min: 0n, fee: 0n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(
      registrationTerms({
        deadline: Math.floor((Date.now() + 3 * DAY) / 1000),
      }),
    )
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, record())
    })
    await render()
    await settleReads()
    expect(notice("secure-name-notice")).toContain(REGISTRATIONS_PAUSED_NOTICE)
    expect(notice("secure-name-notice")).not.toContain("Send a deposit")
  })
})

describe("formatRemaining", () => {
  it("picks the unit by scale and goes empty past the deadline", () => {
    const now = 1_000_000_000_000
    expect(formatRemaining(now + 30 * 60_000, now)).toBe("30 minutes")
    expect(formatRemaining(now + 90 * 60_000, now)).toBe("2 hours")
    expect(formatRemaining(now + 47 * 3_600_000, now)).toBe("47 hours")
    expect(formatRemaining(now + 3 * DAY, now)).toBe("3 days")
    expect(formatRemaining(now + 2 * DAY, now)).toBe("2 days")
    expect(formatRemaining(now, now)).toBe("")
  })
})

describe("SecureNameNoticeCard — the lead line", () => {
  const liveTerms = {
    account: ACCOUNT,
    tag: "taga",
    fee: String(5n * 10n ** 17n),
    minDeposit: String(45n * 10n ** 17n),
    feeWaived: true,
  }

  it("leads with how long the reservation holds while the quote is live", async () => {
    const deadline = Math.floor((Date.now() + 3 * DAY) / 1000)
    h.amounts = { min: 45n * 10n ** 17n, fee: 5n * 10n ** 17n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms({ ...liveTerms, deadline })
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, record())
    })
    await render()
    await settleReads()
    const body = notice("secure-name-notice")!
    const held = `Reserved until ${formatDateLabel(deadline * 1000)}, ${formatTimeLabel(
      deadline * 1000,
    )}.`
    expect(body).toContain(held)
    expect(body.indexOf(held)).toBeLessThan(body.indexOf(ASK))
  })

  it("asks without a lead where no deadline holds the quote", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(registrationTerms({ deadline: 0, feeWaived: false }))
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, record())
    })
    await render()
    await settleReads()
    const body = notice("secure-name-notice")!
    expect(body).toContain(ASK)
    expect(body).not.toContain("Reserved until")
    expect(body).not.toContain("$")
  })
})

describe("SecureNameNoticeCard — unpublished registration", () => {
  const liveTerms = () =>
    saveRegistrationTerms(
      registrationTerms({
        deadline: Math.floor((Date.now() + DAY) / 1000),
        fee: String(10n * 10n ** 18n),
        minDeposit: String(5n * 10n ** 18n),
        feeWaived: false,
      }),
    )
  const renderHome = (onActivate: () => void) =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <SecureNameNoticeCard onActivate={onActivate} />
        </MemoryRouter>,
      )
    })

  it.each([
    ["past its retries", { retries: 3, startTime: Date.now() - 3_600_000 }],
    ["past its age", { retries: 0, startTime: Date.now() - 3 * DAY }],
  ])(
    "an unpublished registration %s leads to the pending step's retry, not the payment sheet",
    async (_, over) => {
      h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
      saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
      liveTerms()
      await getPendingStore().upsert(ACCOUNT, {}, record({ broadcast: false, ...over }))
      const onActivate = vi.fn()
      await renderHome(onActivate)
      await settleReads()
      const text = container.textContent!
      expect(text).toContain("Activate account")
      expect(text).toContain("Reserved until")
      expect(text).toContain("Your deposit address was not published. Check on it to try again.")
      expect(text).not.toContain("Send a deposit")
      await act(async () => container.querySelector("button")!.click())
      expect(onActivate).not.toHaveBeenCalled()
      expect(h.navigate).toHaveBeenCalledWith("/claim/taga")
    },
  )

  it.each([
    ["published", { broadcast: true }],
    ["still being re-sent in the background", { broadcast: false, retries: 1 }],
  ])("a registration %s opens the payment sheet", async (_, over) => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    liveTerms()
    await getPendingStore().upsert(ACCOUNT, {}, record(over))
    const onActivate = vi.fn()
    await renderHome(onActivate)
    await settleReads()
    expect(container.textContent).toContain(ASK)
    expect(container.textContent).not.toContain("was not published")
    await act(async () => container.querySelector("button")!.click())
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it("an unpublished registration past its quote asks for the refresh first", async () => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(
      registrationTerms({
        deadline: Math.floor(Date.now() / 1000) - 60,
        feeWaived: false,
      }),
    )
    await getPendingStore().upsert(ACCOUNT, {}, record({ broadcast: false, retries: 3 }))
    const onActivate = vi.fn()
    await renderHome(onActivate)
    expect(container.textContent).toContain("Refresh your deposit")
    expect(container.textContent).not.toContain("was not published")
    await act(async () => container.querySelector("button")!.click())
    expect(onActivate).not.toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith("/claim/taga")
  })
})

describe("SecureNameNoticeCard — swept deposit", () => {
  const SWEEP = `0x${"33".repeat(32)}` as Hex
  const paidName = (deadline = Math.floor((Date.now() + DAY) / 1000)) => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms(
      registrationTerms({
        deadline,
        fee: String(10n * 10n ** 18n),
        minDeposit: String(5n * 10n ** 18n),
        feeWaived: false,
      }),
    )
  }
  const renderHome = (onActivate: () => void) =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <SecureNameNoticeCard onActivate={onActivate} />
        </MemoryRouter>,
      )
    })

  it.each(["reopened", "already mounted"])(
    "a sweep recorded before the registry confirms it is reported, not priced again (%s)",
    async (when) => {
      paidName()
      await getPendingStore().upsert(ACCOUNT, {}, record())
      if (when === "already mounted") {
        await render()
        await settleReads()
        expect(container.textContent).toContain(ASK)
      }
      await act(async () => {
        await getPendingStore().upsert(ACCOUNT, { sweptAt: Date.now(), sweepTxHash: SWEEP })
      })
      if (when === "reopened") await render()
      await settleReads()
      expectReported()
    },
  )

  // Until a tick promotes the record the sheet confirms the deposit; after, its step follows it.
  it.each([
    // The L1 watcher stamped it; no detection tick has promoted the record yet.
    ["a deposit the L1 watcher saw", { fundedAt: Date.now() }, "sheet"],
    [
      "a funded claim whose address never published",
      { phase: "funded", fundedAt: Date.now(), broadcast: false },
      "step",
    ],
  ] as const)("%s is reported, not asked for again, and opens its %s", async (_, over, opens) => {
    paidName()
    await getPendingStore().upsert(ACCOUNT, {}, record(over))
    const onActivate = vi.fn()
    await renderHome(onActivate)
    await settleReads()
    expectReported()
    await act(async () => container.querySelector("button")!.click())
    expect(onActivate).toHaveBeenCalledTimes(opens === "sheet" ? 1 : 0)
    expect(h.navigate.mock.calls).toEqual(opens === "sheet" ? [] : [["/claim/taga"]])
  })

  it("a swept deposit is neither stale nor unpublished, and still opens the sheet", async () => {
    paidName(Math.floor(Date.now() / 1000) - 60)
    await getPendingStore().upsert(
      ACCOUNT,
      {},
      record({ broadcast: false, retries: 3, sweptAt: Date.now(), sweepTxHash: SWEEP }),
    )
    const onActivate = vi.fn()
    await renderHome(onActivate)
    await settleReads()
    expectReported()
    expect(container.textContent).not.toContain("Refresh your deposit")
    expect(container.textContent).not.toContain("was not published")
    await act(async () => container.querySelector("button")!.click())
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(h.navigate).not.toHaveBeenCalled()
  })
})

describe("SecureNameNoticeCard — a ticket-funded name", () => {
  const pendingName = async (over: Partial<PendingRegistrationRecord> = {}) => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, record(over))
    })
  }
  const ticketTerms = (over: Parameters<typeof ticketBoundTerms>[0] = {}) =>
    saveRegistrationTerms(ticketBoundTerms(over))
  const stash = () => stashTicketSignup(ticketSignupStash({ amount: (3n * ONE).toString() }))
  const state = () =>
    container.querySelector('[data-testid="secure-name-notice"]')?.getAttribute("data-ticket-state")

  beforeEach(() => {
    sessionStorage.clear()
  })

  it("never asks for a deposit: the link's claim funds the name", async () => {
    await pendingName()
    ticketTerms()
    await render()
    await settleReads()
    expect(state()).toBe("missing_link")
    expect(container.textContent).toContain("Open your payment link")
    expect(container.textContent).not.toContain("Send a deposit")

    stash()
    await render()
    await settleReads()
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("Claim your payment")
    expect(container.textContent).not.toContain("Send a deposit")

    // The link reopened on a tab that lost its marker is the same link.
    sessionStorage.clear()
    stashClaimLink("paylink-frag")
    await render()
    await settleReads()
    expect(state()).toBe("ready")
    stashClaimLink("another-link")
    await render()
    await settleReads()
    expect(state()).toBe("missing_link")
  })

  it("shows progress once the burn is submitted, while the address still reads zero", async () => {
    await pendingName({ fundedAt: Date.now() })
    ticketTerms()
    stash()
    h.balance = 0n
    await render()
    await settleReads()
    expect(state()).toBe("submitted")
    expect(container.textContent).toContain("Claiming @taga")
    expect(container.textContent).toContain("Nothing to send")
  })

  it("reads as claiming while this page claims the link, and asks for the passkey", async () => {
    await pendingName()
    ticketTerms()
    stash()
    await render()
    await settleReads()
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("Claim your payment")

    await act(async () => startClaim("paylink-frag"))
    expect(container.textContent).toContain("Claiming @taga")
    expect(container.textContent).toContain("Approve with your passkey")
    expect(container.textContent).not.toContain("Claim your payment")

    // The burn's record lands before the batch signs: still the page's claim, not a sent one.
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { fundedAt: Date.now() })
    })
    expect(state()).toBe("submitted")
    expect(container.textContent).toContain("Approve with your passkey")

    await act(async () => endClaim("paylink-frag"))
    expect(container.textContent).toContain("Nothing to send")
    expect(container.textContent).not.toContain("Approve with your passkey")
  })

  it("an address still publishing reads as setting up, not as unpublished", async () => {
    await pendingName({ broadcast: false })
    ticketTerms()
    stash()
    await render()
    await settleReads()
    expect(state()).toBe("unpublished")
    expect(container.textContent).toContain("Setting up @taga")
    expect(container.textContent).toContain("Publishing your deposit address")
    expect(container.textContent).not.toContain("was not published")
  })

  it("keeps a blocked, lapsed or unpublished binding a ticket, and says what to do", async () => {
    await pendingName()
    ticketTerms({ paylinkBlocked: true })
    stash()
    await render()
    await settleReads()
    expect(state()).toBe("blocked")
    expect(container.textContent).toContain("cannot fund @taga")

    // A block outlasts every write that does not lift it; lifted, a lapsed quote asks for renewal.
    ticketTerms({ deadline: Math.floor(Date.now() / 1000) - 60 })
    await render()
    await settleReads()
    expect(state()).toBe("blocked")
    ticketTerms({ deadline: Math.floor(Date.now() / 1000) - 60, paylinkBlocked: false })
    await render()
    await settleReads()
    expect(state()).toBe("renew")
    expect(container.textContent).toContain("Refresh your reservation")

    // Nothing re-sends an escalated record's address: the way back is the pending step.
    ticketTerms()
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { broadcast: false, retries: 3 })
    })
    await render()
    await settleReads()
    expect(state()).toBe("unpublished")
    expect(container.textContent).toContain("was not published")
  })

  it("opens the link's review when the link is on this tab, else the activation prompt", async () => {
    await pendingName()
    ticketTerms()
    stash()
    const onActivate = vi.fn()
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SecureNameNoticeCard onActivate={onActivate} />
        </MemoryRouter>,
      )
    })
    await settleReads()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="secure-name-notice"]')!.click()
    })
    // The review with the claim's step and status, in the one place that owns the claim.
    expect(takeClaimPromptRequest()).toBe("paylink-frag")
    expect(onActivate).not.toHaveBeenCalled()
    expect(h.navigate).not.toHaveBeenCalled()

    // Without the link on this tab, the activation prompt says how to get it back.
    sessionStorage.clear()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="secure-name-notice"]')!.click()
    })
    expect(takeClaimPromptRequest()).toBeNull()
    expect(onActivate).toHaveBeenCalledOnce()
    expect(h.navigate).not.toHaveBeenCalled()
  })
})
