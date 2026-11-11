import { describe, expect, it } from "vitest"
import { memoryBackend, openDatabase } from "@obsidion/front-core"
import { deviceState } from "../../../src/platform/storage/deviceKeys"
import {
  lastDepositNetwork,
  rememberDepositNetwork,
} from "../../../src/platform/storage/lastDepositNetwork"

describe("lastDepositNetwork", () => {
  it("reads back the network last remembered", async () => {
    const db = openDatabase(memoryBackend())
    const device = deviceState(db, () => false)
    await device.load()
    expect(lastDepositNetwork(device.get().lastDepositNetwork)).toBeUndefined()
    rememberDepositNetwork(db, 8453)
    rememberDepositNetwork(db, 42161)
    await db.write(async () => {})
    expect(lastDepositNetwork(device.get().lastDepositNetwork)).toBe(42161)
  })

  it("ignores a stored value that is not a chain id", () => {
    for (const bad of [null, "", "abc", "0", "-1", "1.5"]) {
      expect(lastDepositNetwork(bad)).toBeUndefined()
    }
  })
})
