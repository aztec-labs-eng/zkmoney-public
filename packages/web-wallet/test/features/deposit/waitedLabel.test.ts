// @vitest-environment node
import { describe, expect, it } from "vitest"
import { waitedLabel } from "../../../src/features/deposit/DepositExitModal/DepositExitModal"
import copy from "../../../src/features/deposit/DepositExitModal/DepositExitModal.copy"
import { fmt } from "../../../src/lib/fmt"

describe("waitedLabel", () => {
  it("counts whole minutes, and hours once there are any", () => {
    const minutes = (n: number) => fmt(copy.waited.minutes, { minutes: n })
    const hours = (h: number, m: string) => fmt(copy.waited.hours, { hours: h, minutes: m })
    expect(waitedLabel(0)).toBe(minutes(0))
    expect(waitedLabel(90_000)).toBe(minutes(1))
    expect(waitedLabel(59 * 60_000)).toBe(minutes(59))
    expect(waitedLabel(60 * 60_000)).toBe(hours(1, "00"))
    expect(waitedLabel((3 * 60 + 5) * 60_000)).toBe(hours(3, "05"))
  })
})
