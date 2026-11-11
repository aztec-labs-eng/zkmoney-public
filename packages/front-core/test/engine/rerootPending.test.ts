/** Which account a backup passkey add still has to switch: the one its signed change was built over. */
import { describe, expect, it } from "vitest"
import {
  balanceMoving,
  balanceMovingNow,
  rerootPending,
  type BackupRotationRecord,
} from "../../src/engine/backupRotations"
import type { RecordSet } from "../../src/engine/persistentStore"
import { memoryStore } from "../../src/engine/store"

const ONE_KEY = `0x${"11".repeat(32)}`
const TWO_KEY = `0x${"22".repeat(32)}`
const OTHER = `0x${"33".repeat(32)}`

const record = (over: Partial<BackupRotationRecord>): BackupRotationRecord =>
  ({ owner: "0xowner", phase: "published", fundings: [], ...over } as BackupRotationRecord)
const signed = (phase: BackupRotationRecord["phase"], l2Address = ONE_KEY) =>
  record({ phase, rotation: { builtOver: { l2Address } } as BackupRotationRecord["rotation"] })

describe("rerootPending", () => {
  it("holds for the account a signed change still has to switch, whatever its case", () => {
    expect(rerootPending([signed("published")], ONE_KEY)).toBe(true)
    expect(rerootPending([signed("published")], ONE_KEY.toUpperCase())).toBe(true)
    expect(rerootPending([signed("published", OTHER)], ONE_KEY)).toBe(false)
  })

  it("holds for any account while the change is not signed yet", () => {
    expect(rerootPending([record({ phase: "created" })], ONE_KEY)).toBe(true)
  })

  it("holds nothing without an account", () => {
    expect(rerootPending([record({ phase: "created" })], undefined)).toBe(false)
  })
})

describe("balanceMoving", () => {
  it("holds for the account a move leaves and the one it lands on, whatever their case, and no other", () => {
    const moving = record({
      phase: "rerooted",
      plan: { address: TWO_KEY } as BackupRotationRecord["plan"],
      rotation: { builtOver: { l2Address: ONE_KEY } } as BackupRotationRecord["rotation"],
    })
    expect(balanceMoving([moving], ONE_KEY)).toBe(true)
    expect(balanceMoving([moving], TWO_KEY.toUpperCase())).toBe(true)
    expect(balanceMoving([moving], OTHER)).toBe(false)
  })
})

describe("balanceMovingNow", () => {
  const over = (set: RecordSet<BackupRotationRecord>) => ({ view: memoryStore(set).readonly })
  const moving = signed("rerooted")

  it("counts records that do not read as moving, so its callers defer", async () => {
    expect(
      await balanceMovingNow(over({ records: [], loaded: false, failed: true }), ONE_KEY),
    ).toBe(true)
    expect(await balanceMovingNow(over({ records: [], loaded: true, failed: true }), ONE_KEY)).toBe(
      true,
    )
  })

  it("reads the loaded records, and a session with no rotations moves nothing", async () => {
    expect(
      await balanceMovingNow(over({ records: [moving], loaded: true, failed: false }), ONE_KEY),
    ).toBe(true)
    expect(
      await balanceMovingNow(over({ records: [], loaded: true, failed: false }), ONE_KEY),
    ).toBe(false)
    expect(await balanceMovingNow(null, ONE_KEY)).toBe(false)
  })
})
