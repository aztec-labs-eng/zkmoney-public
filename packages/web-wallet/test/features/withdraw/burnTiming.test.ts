import { describe, expect, it } from "vitest"
import { createBurnDurations, memoryBackend, openDatabase } from "@obsidion/front-core"
import {
  DEFAULT_BURN_LANDING,
  burnLanding,
  recordBurnDuration,
} from "../../../src/features/withdraw/burnTiming"

const memoryStorage = () => createBurnDurations({ db: openDatabase(memoryBackend()) })

describe("burnLanding", () => {
  it("is the wide default before the device has burned", async () => {
    expect(await burnLanding(memoryStorage())).toEqual(DEFAULT_BURN_LANDING)
  })

  it("spans this device's recent burns, widened for a slow one", async () => {
    const storage = memoryStorage()
    for (const ms of [90_000, 60_000, 120_000]) await recordBurnDuration(storage, ms)
    expect(await burnLanding(storage)).toEqual({
      expected: 90,
      earliest: 60,
      latest: 120 * 1.5,
    })
  })

  it("keeps the last ten burns and ignores what it cannot use", async () => {
    const storage = memoryStorage()
    await recordBurnDuration(storage, -1)
    await recordBurnDuration(storage, Number.NaN)
    for (let i = 1; i <= 12; i++) await recordBurnDuration(storage, i * 10_000)
    const landing = await burnLanding(storage)
    expect(landing.earliest).toBe(30)
    expect(landing.latest).toBe(120 * 1.5)
  })
})
