import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEVICE_STORAGE_KEYS, deviceStorage } from "../../../src/platform/storage/rollupStorage"
import { PREF_KEYS } from "../../../src/platform/storage/deviceKeys"
import { tabStash } from "../../../src/platform/storage/tabStash"
import { closeWalletStore, walletStorage } from "../../../src/platform/storage/walletStorage"
import { removeOldWalletKeys } from "../../../src/platform/storage/storageMigrations/oldLocalStorage"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { demoBootInput } from "../../../src/dev/demoProfile"

const FIXTURE_VERSION = sandboxProfile().shared.rollupVersion

/** What builds before the wallet database left in `localStorage`, with the active rollup at 7. */
const OLD_WALLET_KEYS = [
  "webwallet.identity",
  "webwallet.storageId",
  "webwallet.msk",
  "obsidion.aaa.obsidion_contacts",
  "obsidion.obsidion_web_passkey_identity_map",
  "obsidion-google-callback:abc",
  "rollup.7.webwallet.msk",
  "rollup.7.obsidion.sid.@obsidion/pending-registration/records",
  "rollup.8.webwallet.storageId",
  "rollup.8.obsidion-google-callback-alive:abc",
  "zkm_wallet_imported.7",
  "wagmi.store",
  // Reservations no build reads.
  "webwallet.handoff",
  "webwallet.hide-withdraw-privacy-disclaimer",
]

/**
 * What must survive: device keys, the older preferences and payment holds device state carries,
 * third-party keys and the active partition's relay entries.
 */
const KEPT_KEYS = [
  ...DEVICE_STORAGE_KEYS,
  ...Object.values(PREF_KEYS),
  "webwallet.unresolved-payments",
  "rk-recent",
  "rollup.analytics.setting",
  "rollup.7.other-library.state",
  "rollup",
  "rollup.7.obsidion-google-callback:abc",
  "rollup.7.obsidion-google-callback-alive:abc",
]

const bootInput = () => ({
  env: {
    VITE_CONFIG_PROFILE_URL: "http://localhost:8083/profiles/sandbox.json",
    VITE_CONFIG_EXPECTED_PROFILE_ID: "sandbox",
  },
  fetchImpl: (async () =>
    new Response(JSON.stringify(sandboxProfile()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
})

describe("device keys and old wallet keys", () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("returns null and no-ops without localStorage", () => {
    vi.stubGlobal("localStorage", undefined)
    expect(deviceStorage.getItem("zkm_bid")).toBeNull()
    expect(() => deviceStorage.setItem("zkm_bid", "1")).not.toThrow()
    expect(() => removeOldWalletKeys("7")).not.toThrow()
  })

  // Checked by the compiler; never run.
  const misuse = () => {
    // @ts-expect-error a preference lives in device state
    deviceStorage.setItem("webwallet.hide-balances", "true")
    // @ts-expect-error a tab key is one of the named families
    tabStash.set("obsidion.pending", "x")
  }
  void misuse

  describe("removeOldWalletKeys", () => {
    /** Each key holds "v"; a relay result holds the time it was written. */
    const seed = (keys: readonly string[], createdAt = Date.now()) => {
      for (const key of keys)
        localStorage.setItem(key, key.includes("callback:") ? JSON.stringify({ createdAt }) : "v")
    }

    it("deletes every old wallet key and keeps device, third-party and live relay keys", () => {
      seed([...OLD_WALLET_KEYS, ...KEPT_KEYS])
      removeOldWalletKeys("7")
      expect(Object.keys(localStorage).sort()).toEqual([...KEPT_KEYS].sort())
    })

    it("removes a relay result past its sign-in timeout or unreadable, with its beacon", () => {
      const live = ["rollup.7.obsidion-google-callback-alive:beacon-only"]
      seed(live)
      seed(["rollup.7.obsidion-google-callback:old"], Date.now() - 6 * 60_000)
      localStorage.setItem("rollup.7.obsidion-google-callback-alive:old", "0")
      localStorage.setItem("rollup.7.obsidion-google-callback:bad", "{")
      removeOldWalletKeys("7")
      expect(Object.keys(localStorage)).toEqual(live)
    })

    it("with names, removes only those keys, at the top level and in every partition", () => {
      seed([...OLD_WALLET_KEYS, ...KEPT_KEYS])
      removeOldWalletKeys("7", ["webwallet.msk", "webwallet.storageId"])
      const gone = [
        "webwallet.msk",
        "webwallet.storageId",
        "rollup.7.webwallet.msk",
        "rollup.8.webwallet.storageId",
      ]
      expect(Object.keys(localStorage).sort()).toEqual(
        [...OLD_WALLET_KEYS, ...KEPT_KEYS].filter((key) => !gone.includes(key)).sort(),
      )
    })

    it("removes the rest when one removal fails, then throws that failure", () => {
      seed(OLD_WALLET_KEYS)
      const remove = Storage.prototype.removeItem
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
        if (key === "webwallet.msk") throw new Error("SecurityError")
        remove.call(this, key)
      })
      expect(() => removeOldWalletKeys("7")).toThrow("SecurityError")
      expect(Object.keys(localStorage)).toEqual(["webwallet.msk"])
    })
  })

  const bootModules = async () => ({
    env: await import("../../../src/config/env"),
    wallet: await import("../../../src/platform/storage/walletStorage"),
  })

  describe("boot and the wallet open", () => {
    const freshModules = async () => {
      vi.resetModules()
      await closeWalletStore()
      return bootModules()
    }

    it("names the profile's rollup without opening the wallet database", async () => {
      const modules = await freshModules()
      localStorage.setItem("webwallet.identity", "old")
      const { config } = await modules.env.resolveBootConfig(bootInput())
      expect(config.profileRollupVersion).toBe(FIXTURE_VERSION)
      expect(() => walletStorage.getItem("webwallet.identity")).toThrow(/wallet store is closed/)
      expect(localStorage.getItem("webwallet.identity")).toBe("old")
    })

    it("opens the wallet database without reading or removing old localStorage state", async () => {
      const { env, wallet } = await freshModules()
      const { profileRollupVersion: rollup } = (await env.resolveBootConfig(bootInput())).config
      const partitioned = `rollup.${rollup}.webwallet.identity`
      localStorage.setItem("webwallet.identity", "top-level")
      localStorage.setItem(partitioned, "partitioned")
      await wallet.openWalletStore(rollup, { persistent: true })
      expect(walletStorage.getItem("webwallet.identity")).toBeNull()
      expect(localStorage.getItem("webwallet.identity")).toBe("top-level")
      expect(localStorage.getItem(partitioned)).toBe("partitioned")
    })

    it("opens a demo boot's own database and touches no localStorage", async () => {
      const { env, wallet } = await bootModules()
      localStorage.setItem("webwallet.identity", "real")
      localStorage.setItem("rollup.7.webwallet.msk", "other")
      await env.resolveBootConfig(demoBootInput({}))
      expect(wallet.walletStorage.getItem("webwallet.identity")).toBeNull()
      expect(localStorage.getItem("webwallet.identity")).toBe("real")
      expect(localStorage.getItem("rollup.7.webwallet.msk")).toBe("other")
    })
  })
})
