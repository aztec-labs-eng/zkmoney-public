import { beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"
import { DAI, pendingRecord } from "./support/registrationFixtures"

const getConfig = vi.fn()
vi.mock("../src/config/env", () => ({ getConfig }))
const current = vi.fn()
const list = vi.fn()
vi.mock("../src/features/onboarding/webRegistration", () => ({
  getPendingStore: () => ({ current, list }),
}))
vi.mock("../src/platform/auth/WebPasskeyIdentityMap", () => ({ hasMskRootBreadcrumb: () => true }))
const fireEvent = vi.fn()
vi.mock("../src/lib/analytics", () => ({ fireEvent }))
const showReportableError = vi.fn()
vi.mock("../src/errors/errorModal", () => ({ showReportableError }))

const {
  cacheAdmission,
  checkAdmission,
  hasCachedAdmission,
  hasWalletEntry,
  registrationAdmits,
  recordDepositAdmission,
  refundedEntry,
  hasDepositAdmission,
} = await import("../src/features/identity/admission")
const { clearWalletIdentity, saveWalletIdentity } = await import(
  "../src/features/identity/walletIdentity"
)
const { saveRegistrationTerms } = await import("../src/features/onboarding/registrationTerms")

const EOA = "0xE0A0000000000000000000000000000000000001"

/** A tier with a campaign; the gate arms on its own flag, not on the URL. */
const campaign = (admissionGate = true) => ({
  campaignUrl: "https://launch.test.invalid",
  campaignOrigin: "https://launch.test.invalid",
  admissionGate,
  rpId: "localhost",
})

/** The wallet arms no gate; the config field is what decides, and it is always false. */
describe("admissionGateEnabled", () => {
  beforeEach(() => {
    localStorage.clear()
    current.mockReturnValue(null)
    list.mockReturnValue([])
  })

  it("is off with a campaign URL and no flag: entry needs no grant", () => {
    getConfig.mockReturnValue(campaign(false))
    saveWalletIdentity({ address: L2_A, claimedAt: 1 })
    expect(hasWalletEntry()).toBe(true)
    expect(registrationAdmits("awaiting_deposit", L2_A)).toBe(true)
  })

  it("is on when the config arms it: no grant and no deposit means no entry", () => {
    getConfig.mockReturnValue(campaign(true))
    saveWalletIdentity({ address: L2_A, claimedAt: 1 })
    expect(hasWalletEntry()).toBe(false)
  })
})
const L2_A = `0x${"aa".repeat(32)}` as const
const L2_B = `0x${"bb".repeat(32)}` as const

/** A cached grant is pinned to the identity it admitted: no other identity rides it. */
describe("admission cache identity pin", () => {
  beforeEach(() => {
    localStorage.clear()
    getConfig.mockReturnValue(campaign())
    current.mockReturnValue(null)
    list.mockReturnValue([])
  })

  it("admits the identity the grant was proved for", () => {
    saveWalletIdentity({ address: L2_A, claimedAt: 1 })
    cacheAdmission(EOA, L2_A)
    expect(hasWalletEntry()).toBe(true)
  })

  it("bounces a cache proved for a different identity", () => {
    saveWalletIdentity({ address: L2_A, claimedAt: 1 })
    cacheAdmission(EOA, L2_B)
    expect(hasWalletEntry()).toBe(false)
  })

  it("ignores a cache entry that carries no identity pin", () => {
    saveWalletIdentity({ address: L2_A, claimedAt: 1 })
    walletStorage.setItem(
      "webwallet.admission",
      JSON.stringify({ address: EOA.toLowerCase(), grantedAt: 1 }),
    )
    expect(hasWalletEntry()).toBe(false)
    expect(hasCachedAdmission()).toBe(false)
  })

  // The L1 watcher stamps these; `phase` only catches up on the next detection tick. A paid attempt
  // that then lost the name race keeps the entry it bought.
  it.each([
    ["a deposit L1 has seen", { fundedAt: 123 }],
    ["a sweep seen before any funded stamp", { sweptAt: 123 }],
    ["a paid attempt that lost the name", { fundedAt: 123, phase: "failed_taken" as const }],
  ])("admits on %s", (_, stamp) => {
    saveWalletIdentity({ address: L2_A, claimedAt: 1 })
    list.mockReturnValue([pendingRecord({ l2Address: L2_A, ...stamp })])
    expect(hasWalletEntry()).toBe(true)
  })

  it("does not admit another identity's funded registration", () => {
    saveWalletIdentity({ address: L2_A, claimedAt: 1 })
    list.mockReturnValue([pendingRecord({ l2Address: L2_B, phase: "funded", fundedAt: 123 })])
    expect(hasWalletEntry()).toBe(false)
  })

  it("admits on an earlier funded attempt, not only the newest record", () => {
    saveWalletIdentity({ address: L2_A, claimedAt: 1 })
    list.mockReturnValue([
      pendingRecord({ l2Address: L2_A, fundedAt: 99 }),
      pendingRecord({ l2Address: L2_A }),
    ])
    expect(hasWalletEntry()).toBe(true)
  })

  it("matches the record address on the record-only path", () => {
    cacheAdmission(EOA, L2_A)
    expect(registrationAdmits("created", L2_A)).toBe(true)
    expect(registrationAdmits("created", L2_B)).toBe(false)
    expect(registrationAdmits("funded", L2_B)).toBe(true)
  })

  it("clearing the identity drops the cached grant", () => {
    saveWalletIdentity({ address: L2_A, claimedAt: 1 })
    cacheAdmission(EOA, L2_A)
    clearWalletIdentity()
    expect(hasCachedAdmission()).toBe(false)
    expect(hasWalletEntry()).toBe(false)
  })
})

/** One admission_checked per verify resolution, tagged with the asking surface (ULT-777). */
describe("admission_checked instrumentation", () => {
  const bootstrap = {
    address: EOA,
    signMessage: async () => "0xsig",
  } as unknown as Parameters<typeof checkAdmission>[0]

  beforeEach(() => {
    localStorage.clear()
    fireEvent.mockClear()
    showReportableError.mockClear()
    getConfig.mockReturnValue(campaign())
    current.mockReturnValue(null)
    list.mockReturnValue([])
  })

  const respond = (status: number, body?: unknown) =>
    vi.stubGlobal("fetch", async () => new Response(body ? JSON.stringify(body) : null, { status }))

  it("emits granted/queued/unknown with the caller's surface", async () => {
    respond(200, { status: "granted" })
    expect((await checkAdmission(bootstrap, L2_A, "enter")).status).toBe("granted")
    respond(200, { status: "queued", queuePosition: 12 })
    expect((await checkAdmission(bootstrap, L2_B, "onboarding")).status).toBe("queued")
    respond(404)
    expect((await checkAdmission(bootstrap, L2_B, "enter")).status).toBe("unknown")
    expect(fireEvent.mock.calls).toEqual([
      ["admission_checked", { outcome: "granted", surface: "enter" }],
      ["admission_checked", { outcome: "queued", surface: "onboarding" }],
      ["admission_checked", { outcome: "unknown", surface: "enter" }],
    ])
    vi.unstubAllGlobals()
  })

  it("a body that never arrives is cut off at the deadline, not waited on", async () => {
    vi.useFakeTimers()
    // Headers land at once and the body stalls: the abort has to reach the read, or the caller
    // waits with nothing left to stop it.
    vi.stubGlobal("fetch", async (_url: string, init: { signal: AbortSignal }) => ({
      status: 200,
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          )
        }),
    }))
    const pending = checkAdmission(bootstrap, L2_A, "enter")
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await pending).status).toBe("unavailable")
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("a transport failure reports unreachable, the failure event, and the admission:verify context", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    expect((await checkAdmission(bootstrap, L2_A, "onboarding")).status).toBe("unavailable")
    expect(fireEvent.mock.calls).toEqual([
      ["action_failed", { action: "admission_check", code: "admission_unreachable" }],
      ["admission_checked", { outcome: "unreachable", surface: "onboarding" }],
    ])
    expect(showReportableError).toHaveBeenCalledWith(expect.any(Error), "admission:verify", {
      title: "Couldn't verify your waitlist status",
    })
    vi.unstubAllGlobals()
  })

  it("the cached fast path answers without re-emitting", async () => {
    cacheAdmission(EOA, L2_A)
    expect((await checkAdmission(bootstrap, L2_A, "enter")).status).toBe("granted")
    expect(fireEvent).not.toHaveBeenCalled()
  })

  /** A caller whose operation ended while the verify was pending gets nothing cached, emitted or shown. */
  describe("under a caller's ownership guard", () => {
    // The verify signs before it fetches, so the deferred fetch exists only after a tick.
    const tick = () => new Promise((r) => setTimeout(r, 0))

    it("a grant arriving after the operation ended is neither cached nor emitted", async () => {
      let owns = true
      let release!: (value: Response) => void
      vi.stubGlobal("fetch", () => new Promise<Response>((r) => (release = r)))
      const pending = checkAdmission(bootstrap, L2_A, "enter", () => owns)
      await tick()
      owns = false
      release(new Response(JSON.stringify({ status: "granted" }), { status: 200 }))
      expect((await pending).status).toBe("cancelled")
      expect(hasCachedAdmission()).toBe(false)
      expect(fireEvent).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it("a failure arriving after the operation ended opens no modal and emits nothing", async () => {
      let owns = true
      let fail!: (err: unknown) => void
      vi.stubGlobal("fetch", () => new Promise<Response>((_r, reject) => (fail = reject)))
      const pending = checkAdmission(bootstrap, L2_A, "enter", () => owns)
      await tick()
      owns = false
      fail(new Error("offline"))
      expect((await pending).status).toBe("cancelled")
      expect(showReportableError).not.toHaveBeenCalled()
      expect(fireEvent).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it("a caller that still owns the operation gets the answer, cached and emitted", async () => {
      respond(200, { status: "granted" })
      expect((await checkAdmission(bootstrap, L2_A, "enter", () => true)).status).toBe("granted")
      expect(hasCachedAdmission(EOA)).toBe(true)
      expect(fireEvent).toHaveBeenCalledWith("admission_checked", {
        outcome: "granted",
        surface: "enter",
      })
      vi.unstubAllGlobals()
    })
  })
})

describe("observed campaign deposit grants pending entry independently of sweep readiness", () => {
  const record = pendingRecord({ l2Address: L2_A })
  // Staging's earned schedule: a 4.9 floor under the 5 an earned tag is asked to deposit.
  const EARNED = { fee: String(DAI / 2n), minDeposit: String((44n * DAI) / 10n) }
  const EARNED_FLOOR = (49n * DAI) / 10n
  // Staging's portal cut, which the 4.4 minimum outranks.
  const CUT = DAI / 10n
  beforeEach(() => {
    localStorage.clear()
    getConfig.mockReturnValue(campaign())
    list.mockReturnValue([record])
    saveWalletIdentity({ address: L2_A, handle: "taga", pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: record.account,
      tag: record.tag,
      deadline: 0,
      feeWaived: true,
      ...EARNED,
    })
  })
  it("admits at 5 DAI while leaving the registration awaiting deposit", () => {
    expect(recordDepositAdmission(record, 5n * DAI)).toBe(true)
    expect(hasWalletEntry()).toBe(true)
    expect(registrationAdmits("awaiting_deposit", L2_A)).toBe(true)
  })

  it("admits from the signed floor up, under the asked total, and not below it", () => {
    expect(recordDepositAdmission(record, EARNED_FLOOR - 1n, CUT)).toBe(false)
    expect(hasWalletEntry()).toBe(false)
    expect(recordDepositAdmission(record, EARNED_FLOOR, CUT)).toBe(true)
    expect(hasWalletEntry()).toBe(true)
  })

  // A claim server with no schedule configured signs 0/0. That prices no floor, so the campaign's
  // promise is what the deposit is measured against.
  it.each([
    ["the portal's cut is unread", undefined, undefined],
    ["the signed schedule is unpriced", { fee: "0", minDeposit: "0" }, CUT],
  ])("holds the asked total as the bar while %s", (_, schedule, cut) => {
    if (schedule) {
      saveRegistrationTerms({
        account: record.account,
        tag: record.tag,
        deadline: 0,
        feeWaived: true,
        ...schedule,
      })
    }
    expect(recordDepositAdmission(record, EARNED_FLOOR, cut)).toBe(false)
    expect(recordDepositAdmission(record, 5n * DAI, cut)).toBe(true)
  })

  it("never lifts the bar over the asked total, whatever the signed schedule prices", () => {
    // Staging's standard schedule signed onto an earned registration: a 15 DAI floor the campaign
    // never promised. The deposit the campaign asked for still admits.
    saveRegistrationTerms({
      account: record.account,
      tag: record.tag,
      deadline: 0,
      feeWaived: false,
      fee: String(5n * DAI),
      minDeposit: String(10n * DAI),
    })
    expect(recordDepositAdmission(record, 5n * DAI, CUT)).toBe(true)
    expect(recordDepositAdmission(record, 5n * DAI - 1n, CUT)).toBe(false)
  })

  const refund = { amount: 5n * 10n ** 18n, txHash: "0x07" as const }
  it("a replacement carrying the verified refund admits this wallet without paying the new address", () => {
    recordDepositAdmission(record, 5n * 10n ** 18n)
    const replacement = {
      ...record,
      sipaAddress: "new-address",
      refundedEntry: refundedEntry(record, refund),
    }
    list.mockReturnValue([replacement])
    expect(replacement.refundedEntry).toEqual({
      sipaAddress: record.sipaAddress,
      recoveryTxHash: "0x07",
      amount: String(5n * 10n ** 18n),
    })
    expect(hasWalletEntry()).toBe(true)
    expect(hasDepositAdmission(replacement)).toBe(false)
    saveWalletIdentity({ address: L2_B, claimedAt: 1 })
    expect(hasWalletEntry()).toBe(false)
  })
  it("keeps admitting through the replacement after a sign-out cleared every receipt", () => {
    recordDepositAdmission(record, 5n * 10n ** 18n)
    list.mockReturnValue([
      { ...record, sipaAddress: "new-address", refundedEntry: refundedEntry(record, refund) },
    ])
    clearWalletIdentity()
    expect(hasDepositAdmission(record)).toBe(false)
    saveWalletIdentity({ address: L2_A, handle: "taga", pending: true, claimedAt: 2 })
    expect(hasWalletEntry()).toBe(true)
    expect(registrationAdmits("awaiting_deposit", L2_A)).toBe(true)
  })
  it("buys no entry with a refund short of the signed floor", () => {
    expect(refundedEntry(record, { ...refund, amount: EARNED_FLOOR - 1n }, CUT)).toBeUndefined()
    list.mockReturnValue([{ ...record, sipaAddress: "new-address" }])
    expect(hasWalletEntry()).toBe(false)
  })
  it.each(["sipaAddress", "l2Address", "nameHash", "depositToken", "account", "l1ChainId"])(
    "does not apply the receipt to another %s",
    (field) => {
      recordDepositAdmission(record, 5n * 10n ** 18n)
      list.mockReturnValue([{ ...record, [field]: "different" }])
      expect(hasWalletEntry()).toBe(false)
    },
  )
})
