/**
 * The device keys commit through the page's database, one fact per write and nothing on failure, and
 * the page's device store follows each commit from its writes.
 */
import { memoryBackend, openDatabase, type DatabaseBackend } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import { NO_SESSION, tupleOf, writeSessionTuple } from "../../../src/platform/storage/activeStorage"
import {
  DEVICE_KEYS,
  countHintShowing,
  deviceState,
  saveSetting,
  writeDeviceKeys,
} from "../../../src/platform/storage/deviceKeys"
import { testWalletDbs } from "../../support/fakeWalletDb"
import { committed, testPage } from "../../support/page"

const deviceDb = testPage().database

const TUPLE = { storageId: "acct", credentialId: "cred", msk: "{}" }

describe("the session tuple", () => {
  it("commits its three keys in one transaction", async () => {
    await writeSessionTuple(deviceDb, NO_SESSION)
    const applied: string[][] = []
    testWalletDbs().onApply = async (_version, ops) => void applied.push(ops.map(([key]) => key))

    await writeSessionTuple(deviceDb, TUPLE)

    expect(applied).toEqual([[DEVICE_KEYS.storageId, DEVICE_KEYS.credentialId, DEVICE_KEYS.msk]])
    expect(tupleOf(committed())).toEqual(TUPLE)
  })

  it("is left as it was when its write is rejected", async () => {
    await writeSessionTuple(deviceDb, TUPLE)
    testWalletDbs().onApply = async () => {
      throw new Error("disk full")
    }

    await expect(writeSessionTuple(deviceDb, NO_SESSION)).rejects.toBeInstanceOf(Error)

    expect(tupleOf(committed())).toEqual(TUPLE)
  })
})

describe("the device store", () => {
  /** A backend whose reads answer, with what was saved when asked, only once `release` runs. */
  function slowReads(backend: DatabaseBackend) {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const slow: DatabaseBackend = {
      ...backend,
      getMany: async (keys) => {
        const values = await backend.getMany(keys)
        await released
        return values
      },
    }
    return { slow, release }
  }

  it("keeps a commit that lands while its load is out", async () => {
    const backend = memoryBackend()
    await backend.apply([[DEVICE_KEYS.storageId, "old"]])
    const { slow, release } = slowReads(backend)
    const db = openDatabase(slow)
    const device = deviceState(db)

    const loaded = device.load()
    const committing = writeSessionTuple(db, TUPLE)
    release()
    await Promise.all([loaded, committing])

    expect(tupleOf(device.get())).toEqual(TUPLE)
  })

  it("reads every key the page holds", async () => {
    const backend = memoryBackend()
    await backend.apply([
      [DEVICE_KEYS.passkeyMap, "{}"],
      [DEVICE_KEYS.lastCreateRequest, "{}"],
    ])
    const device = deviceState(openDatabase(backend))
    await device.load()

    expect(device.get()).toMatchObject({ passkeyMap: "{}", lastCreateRequest: "{}" })
  })
})

describe("the analytics question", () => {
  it("is unanswered until a consent is saved, a decline included", async () => {
    await writeDeviceKeys(deviceDb, { analyticsConsent: null })
    expect(committed()).toMatchObject({ consentAsked: false, analyticsConsent: false })

    await saveSetting(deviceDb, "analyticsConsent", false)
    expect(committed()).toMatchObject({ consentAsked: true, analyticsConsent: false })

    await saveSetting(deviceDb, "analyticsConsent", true)
    expect(committed()).toMatchObject({ consentAsked: true, analyticsConsent: true })
  })

  it("reads a value of another type as the default, still answered", async () => {
    await writeDeviceKeys(deviceDb, { analyticsConsent: '"yes"' })
    expect(committed()).toMatchObject({ consentAsked: true, analyticsConsent: false })
  })
})

describe("the local passkey hint's showings", () => {
  it("counts each attempt, close together too, and stops at the cap", async () => {
    const db = openDatabase(memoryBackend())
    expect(await Promise.all([countHintShowing(db, 3), countHintShowing(db, 3)])).toEqual([0, 1])
    expect(await countHintShowing(db, 3)).toBe(2)
    expect(await countHintShowing(db, 3)).toBe(3)
    expect(await countHintShowing(db, 3)).toBe(3)
  })
})
