// @vitest-environment node
// The secure-name notice's read of the open registration's deposit on the rail.
import { describe, expect, it } from "vitest"
import { STUCK_SWEEP_MS, type SipaDeposit, type SipaProcessingState } from "@obsidion/front-core"
import { railStage } from "../../../../src/features/onboarding/SecureNameNoticeCard/railStage"
import { pendingRecord, SIPA } from "../../../support/registrationFixtures"

const record = pendingRecord()
const NOW = 1_800_000_000_000
const deposit = (over: Partial<SipaDeposit> = {}) =>
  ({ sipaAddress: SIPA, phase: "funded", startTime: NOW, ...over } as SipaDeposit)
const deposits = (...records: SipaDeposit[]) => ({ records, loaded: true, failed: false })
const capacity: SipaProcessingState = { reason: { kind: "capacity" } as never }
const none = () => undefined

describe("the rail stage", () => {
  it("is empty without a record, and without the record's deposit", () => {
    expect(railStage(null, deposits(deposit()), none, NOW).deposit).toBeNull()
    const other = deposit({ sipaAddress: "0x00000000000000000000000000000000000000ee" })
    expect(railStage(record, deposits(other), none, NOW).deposit).toBeNull()
  })

  it("names the reason a waiting sweep states, and none it keeps to itself", () => {
    const at = deposits(deposit())
    expect(railStage(record, at, () => capacity, NOW).shown).toBe(capacity)
    const quiet: SipaProcessingState = { reason: { kind: "unavailable" } as never }
    expect(railStage(record, at, () => quiet, NOW).shown).toBeUndefined()
  })

  it("reads the processing state of the record's own address", () => {
    const asked: string[] = []
    railStage(record, deposits(deposit()), (sipa) => void asked.push(sipa), NOW)
    expect(asked).toEqual([SIPA])
  })
})

describe("the wait", () => {
  const at = (over: Partial<SipaDeposit>, state?: SipaProcessingState) =>
    railStage(record, deposits(deposit(over)), () => state, NOW)

  it("has no known end under a stated reason or a stuck sweep", () => {
    expect(at({}, capacity).openEnded).toBe(true)
    expect(at({}).openEnded).toBe(false)
    expect(at({ phase: "sweeping", startTime: NOW - STUCK_SWEEP_MS }).openEnded).toBe(true)
    expect(railStage(null, deposits(), none, NOW).openEnded).toBe(false)
  })

  it("turns stuck at a sweep's deadline on the clock it is given, and only for a sweep under way", () => {
    for (const phase of ["sweeping", "broadcast"] as const) {
      expect(at({ phase, startTime: NOW - STUCK_SWEEP_MS + 1 }).openEnded).toBe(false)
      expect(at({ phase, startTime: NOW - STUCK_SWEEP_MS }).openEnded).toBe(true)
    }
    expect(at({ startTime: NOW - STUCK_SWEEP_MS }).openEnded).toBe(false)
  })
})
