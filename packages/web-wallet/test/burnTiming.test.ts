import { describe, expect, it } from "vitest"
import type { IStorageAdapter } from "@obsidion/front-core"
import {
  DEFAULT_BURN_LANDING,
  burnLanding,
  recordBurnDuration,
  sequentialLanding,
} from "../src/features/withdraw/burnTiming"

function memoryStorage(): IStorageAdapter {
  const items = new Map<string, string>()
  return {
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => void items.set(key, value),
    removeItem: async (key) => void items.delete(key),
    clear: async () => items.clear(),
  } as IStorageAdapter
}

describe("burnLanding", () => {
  it("is the wide default before the device has burned", async () => {
    expect(await burnLanding(memoryStorage())).toEqual(DEFAULT_BURN_LANDING)
  })

  it("spans this device's recent burns, widened for a slow one", async () => {
    const storage = memoryStorage()
    for (const ms of [90_000, 60_000, 120_000]) await recordBurnDuration(ms, storage)
    expect(await burnLanding(storage)).toEqual({
      expected: 90,
      earliest: 60,
      latest: 120 * 1.5,
    })
  })

  it("keeps the last ten burns and ignores what it cannot use", async () => {
    const storage = memoryStorage()
    await recordBurnDuration(-1, storage)
    await recordBurnDuration(Number.NaN, storage)
    for (let i = 1; i <= 12; i++) await recordBurnDuration(i * 10_000, storage)
    const landing = await burnLanding(storage)
    expect(landing.earliest).toBe(30)
    expect(landing.latest).toBe(120 * 1.5)
  })

  it("falls back to the default on a corrupt record", async () => {
    const storage = memoryStorage()
    await storage.setItem("burnDurations", "not json")
    expect(await burnLanding(storage)).toEqual(DEFAULT_BURN_LANDING)
  })
})

describe("sequentialLanding", () => {
  const single = { expected: 200, earliest: 60, latest: 500 }

  it("is one burn's own window", () => {
    expect(sequentialLanding(single, 1)).toBe(single)
  })

  it("lands the last of two burns after both have run", () => {
    expect(sequentialLanding(single, 2)).toEqual({ expected: 400, earliest: 120, latest: 1_000 })
  })
})
