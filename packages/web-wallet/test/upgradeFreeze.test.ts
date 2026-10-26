import { expect, it, vi } from "vitest"
import { FREEZE_AT, freezesBuild, reloadAtFreeze, showFreezePage } from "../src/upgradeFreeze"

it("freezes the v5 build only", () => {
  expect(freezesBuild({ "@aztec/aztec.js": "v5.2.0" }, false)).toBe(true)
  expect(freezesBuild({ "@aztec/aztec.js": "v5.2.0" }, true)).toBe(false)
  expect(freezesBuild({ "@aztec/aztec.js": "v6.0.0" }, false)).toBe(false)
  expect(freezesBuild({ "@aztec-labs/aztec.js": "v6.0.0" }, false)).toBe(false)
})

it("freezes 30 minutes before the v6 payload", () => {
  expect(new Date(FREEZE_AT).toISOString()).toBe("2026-10-26T07:30:00.000Z")
})

it("reloads an open tab once the freeze passes", () => {
  vi.useFakeTimers()
  let now = FREEZE_AT - 1
  const reload = vi.fn()
  reloadAtFreeze(reload, () => now)
  vi.advanceTimersByTime(15_000)
  expect(reload).not.toHaveBeenCalled()
  now = FREEZE_AT + 3_600_000
  vi.advanceTimersByTime(60_000)
  expect(reload).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
})

it("replaces the wallet with the maintenance page", async () => {
  await showFreezePage()
  expect(document.body.textContent).toContain("down for planned maintenance")
  expect(document.getElementById("root")).toBeNull()
})
