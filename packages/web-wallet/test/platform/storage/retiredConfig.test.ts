import { beforeEach, describe, expect, it } from "vitest"
import { carryRetiredConfig } from "../../../src/platform/storage/retiredConfig"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { testWalletDbs } from "../../support/fakeWalletDb"
import { testCore } from "../../support/page"
import { deviceState } from "../../../src/platform/storage/deviceKeys"

const dbs = testWalletDbs()
const ACTIVE = sandboxProfile().shared.rollupVersion
const key = (setting: string) => `obsidion.obsidion_config:${setting}`

function seed(version: string, settings: Record<string, string>) {
  const state = dbs.db(version).state
  for (const [setting, raw] of Object.entries(settings)) state.set(key(setting), raw)
}

const seedPrefs = (version: string, prefs: Record<string, string>) =>
  Object.entries(prefs).forEach(([pref, raw]) => dbs.db(version).state.set(pref, raw))

async function boot() {
  await closeWalletStore()
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

  it("carries the preferences the retired databases agree on, and none they disagree on", async () => {
    seedPrefs("111", { "webwallet.ticket-intro-seen": "1", "webwallet.hide-paylink-info": "true" })
    seedPrefs("222", { "webwallet.ticket-intro-seen": "1", "webwallet.hide-paylink-info": "false" })
    seedPrefs("333", { "webwallet.passkey-names": "{unclosed" })
    await boot()
    expect(walletStorage.getItem("webwallet.ticket-intro-seen")).toBe("1")
    expect(walletStorage.getItem("webwallet.hide-paylink-info")).toBeNull()
    expect(walletStorage.getItem("webwallet.passkey-names")).toBeNull()
  })

  it("puts a retired preference ahead of the older copy the device load would carry", async () => {
    seedPrefs("111", { "webwallet.hide-balances": "false" })
    localStorage.setItem("webwallet.hide-balances", "true")
    try {
      await boot()
      const device = deviceState(testCore().database)
      await device.load()
      expect(device.get().hideBalances).toBe(false)
    } finally {
      localStorage.removeItem("webwallet.hide-balances")
    }
  })

  it("hides balances when retired databases disagree on it", async () => {
    seedPrefs("111", { "webwallet.hide-balances": "false" })
    seedPrefs("222", { "webwallet.hide-balances": "true" })
    await boot()
    expect(walletStorage.getItem("webwallet.hide-balances")).toBe("true")
  })

  it("tries the settings again on a later boot when this database holds only preferences", async () => {
    seed("111", { allowNonContactRequests: "false" })
    dbs.db("111").held = true
    seedPrefs(ACTIVE, { "webwallet.hide-balances": "true" })
    await boot()
    expect(read("allowNonContactRequests")).toBeNull()
    dbs.db("111").held = false
    await boot()
    expect(read("allowNonContactRequests")).toBe("false")
  })

  it("carries a preference this database lacks beside settings of its own", async () => {
    seed(ACTIVE, { analyticsConsent: "true" })
    seedPrefs("111", { "webwallet.hide-paylink-info": "true" })
    await boot()
    expect(walletStorage.getItem("webwallet.hide-paylink-info")).toBe("true")
  })
})
