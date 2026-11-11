// @vitest-environment node
/** What the driver shows its subscribers, over the real flow with a dependency build that fails. */
import { createPace } from "@obsidion/core/cadence"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BackupRotationRecord } from "../../../src/engine/backupRotations"
import type { RecordSet } from "../../../src/engine/persistentStore"
import { memoryStore } from "../../../src/engine/store"
import { RotationDriver } from "../../../src/core/rotation/rotationDriver"
import { OWNER, signedRecord } from "../../__test-helpers__/backupRotation"

const driver = new RotationDriver()
afterEach(() => driver.stop())

const settle = () => new Promise((r) => setTimeout(r))

function start(record: BackupRotationRecord) {
  const view = memoryStore<RecordSet<BackupRotationRecord>>({
    records: [record],
    loaded: true,
    failed: false,
  })
  const deps = vi.fn(async () => {
    throw new Error("no deps")
  })
  driver.start({
    store: { view: view.readonly },
    deps,
    owns: () => true,
    pollMs: 1e9,
    pace: createPace(),
  })
  return { view, deps }
}

describe("RotationDriver subscribers", () => {
  it("tells a subscriber of each change until it unsubscribes", async () => {
    const listener = vi.fn()
    const off = driver.subscribe(listener)
    start(signedRecord("funded"))
    await settle()
    expect(listener).toHaveBeenCalled()
    off()
    listener.mockClear()
    driver.stop()
    expect(listener).not.toHaveBeenCalled()
  })

  it("shows a record saved again with the same resume key, and resumes it no second time", async () => {
    const first = signedRecord("funded")
    const { view, deps } = start(first)
    await settle()
    const answered = driver.drive(OWNER)?.resume
    expect(answered?.error).toBeInstanceOf(Error)
    const again = { ...first, updatedAt: first.updatedAt + 1 }
    view.set({ records: [again], loaded: true, failed: false })
    await settle()
    expect(driver.drive(OWNER)?.record).toBe(again)
    expect(driver.drive(OWNER)?.resume).toBe(answered)
    expect(deps).toHaveBeenCalledTimes(1)
  })
})
