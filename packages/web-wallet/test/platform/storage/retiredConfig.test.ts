import { beforeEach, describe, expect, it } from "vitest"
import { carryRetiredConfig } from "../../../src/platform/storage/retiredConfig"
import { setActiveRollup } from "../../../src/platform/storage/rollupStorage"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { testWalletDbs } from "../../support/fakeWalletDb"
import { testCore } from "../../support/page"

const dbs = testWalletDbs()
const ACTIVE = sandboxProfile().shared.rollupVersion
const key = (setting: string) => `obsidion.obsidion_config:${setting}`

function seed(version: string, settings: Record<string, string>) {
  const state = dbs.db(version).state
  for (const [setting, raw] of Object.entries(settings)) state.set(key(setting), raw)
}

async function boot() {
  await closeWalletStore()
  setActiveRollup(ACTIVE)
  await openWalletStore(ACTIVE, { persistent: true })
  await carryRetiredConfig(testCore().database)
}

const read = (setting: string) => walletStorage.getItem(key(setting))

beforeEach(() => closeWalletStore())

describe("retired settings", () => {
  it("carries an answered analytics question and the request filter into an empty database", async () => {
    seed("111", { analyticsConsent: "true", allowNonContactRequests: "false" })
    await boot()
    expect(read("analyticsConsent")).toBe("true")
    expect(read("allowNonContactRequests")).toBe("false")
    expect(dbs.db(ACTIVE).state.get(key("analyticsConsent"))).toBe("true")
  })

  it("takes the answer that shares the least when retired databases disagree", async () => {
    seed("111", { analyticsConsent: "true", allowNonContactRequests: "true" })
    seed("222", { analyticsConsent: "false", allowNonContactRequests: "false" })
    await boot()
    expect(read("analyticsConsent")).toBe("false")
    expect(read("allowNonContactRequests")).toBe("false")
  })

  it("leaves a database that holds settings of its own", async () => {
    seed("111", { analyticsConsent: "true" })
    seed(ACTIVE, { allowNonContactRequests: "true" })
    await boot()
    expect(read("analyticsConsent")).toBeNull()
  })

  it("skips a malformed value", async () => {
    seed("111", { analyticsConsent: "yes", allowNonContactRequests: "false" })
    await boot()
    expect(read("analyticsConsent")).toBeNull()
    expect(read("allowNonContactRequests")).toBe("false")
  })

  it("skips a database another tab holds", async () => {
    seed("111", { analyticsConsent: "true" })
    dbs.db("111").held = true
    await boot()
    expect(read("analyticsConsent")).toBeNull()
  })
})
