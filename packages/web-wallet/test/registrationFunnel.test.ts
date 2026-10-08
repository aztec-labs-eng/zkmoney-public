import { beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"

const fireEvent = vi.fn()
vi.mock("../src/lib/analytics", () => ({ fireEvent }))

const {
  reportRegistrationDepositFunded,
  reportRegistrationDepositShown,
  reportRegistrationDepositSwept,
} = await import("../src/features/onboarding/registrationFunnel")

const ADDR = `0x${"cd".repeat(20)}`

describe("registration funnel reporters", () => {
  beforeEach(() => {
    localStorage.clear()
    fireEvent.mockClear()
  })

  it("each lap emits once per key, across surfaces and durations rounded non-negative", () => {
    reportRegistrationDepositShown(ADDR, "earned_tag")
    reportRegistrationDepositShown(ADDR, "earned_tag")
    reportRegistrationDepositFunded(ADDR, 45_000.6)
    reportRegistrationDepositFunded(ADDR, 90_000)
    reportRegistrationDepositSwept("acct", -5)
    reportRegistrationDepositSwept("acct", 10)
    expect(fireEvent.mock.calls).toEqual([
      ["registration_deposit_shown", { kind: "earned_tag" }],
      ["registration_deposit_funded", { duration_ms: 45_001 }],
      ["registration_deposit_swept", { duration_ms: 0 }],
    ])
  })

  it("names no kind while the schedule that settles it is unread", () => {
    reportRegistrationDepositShown(`0x${"f7".repeat(20)}`)
    expect(fireEvent.mock.calls).toEqual([["registration_deposit_shown", undefined]])
  })

  it("the latch persists in localStorage so a reload (fresh module memory) stays deduped", () => {
    const addr = `0x${"ab".repeat(20)}`
    reportRegistrationDepositShown(addr)
    const stored = JSON.parse(walletStorage.getItem("webwallet.registration.reported") ?? "{}")
    expect(stored[`shown:${addr}`]).toBe(true)
    // A pre-seeded latch (another tab / an earlier load) suppresses a first in-memory report.
    const other = `0x${"ba".repeat(20)}`
    walletStorage.setItem(
      "webwallet.registration.reported",
      JSON.stringify({ [`shown:${other}`]: true }),
    )
    reportRegistrationDepositShown(other)
    expect(fireEvent.mock.calls.filter(([e]) => e === "registration_deposit_shown")).toHaveLength(1)
  })

  it("distinct addresses report independently", () => {
    reportRegistrationDepositShown(`0x${"e1".repeat(20)}`)
    reportRegistrationDepositShown(`0x${"e2".repeat(20)}`)
    expect(fireEvent).toHaveBeenCalledTimes(2)
  })
})
