import { memoryStore, openDatabase, resource, type Database } from "@obsidion/front-core"
import type { Page } from "../../src/app/sessionDeps"
import {
  WebAlphaAuthService,
  type WebAlphaAuthServiceOptions,
} from "../../src/platform/auth/WebAlphaAuthService"
import { createPastUser } from "../../src/features/registration/pastUser"
import { createSignupStash } from "../../src/features/registration/signupStash"
import { sessionLock, type SessionLock } from "../../src/platform/storage/activeStorage"
import { tabStash } from "../../src/platform/storage/tabStash"
import { deviceState, writeDeviceKeys, type Device } from "../../src/platform/storage/deviceKeys"
import { opfsBackend } from "../../src/platform/storage/walletStorage"

type Core = { database: Database; device: Device; sessionLock: SessionLock }

/** `test/setup.ts` reloads its device keys before each test. */
const TEST_PAGE = Symbol.for("zk.money/test-page")

/**
 * The suite's page database, device keys and session lock, built on first use. The device keys
 * load at once, ahead of every write made through the database.
 */
export function testCore(): Core {
  const holder = globalThis as { [TEST_PAGE]?: Core }
  if (!holder[TEST_PAGE]) {
    const database = openDatabase(opfsBackend)
    const device = deviceState(database)
    void device.load()
    holder[TEST_PAGE] = { database, device, sessionLock: sessionLock() }
  }
  return holder[TEST_PAGE]
}

/** The page core over `database`: the suite's own, or one with its own device keys. */
export function pageOver(database: Database): Core {
  const core = testCore()
  if (database === core.database) return core
  const device = deviceState(database)
  void device.load()
  return { database, device, sessionLock: core.sessionLock }
}

/** The suite page's device keys as saved. */
export const committed = () => testCore().device.get()

/** An auth service over this test's page, `options` in place of its defaults. */
export const testAuth = (options: Partial<WebAlphaAuthServiceOptions> = {}) =>
  new WebAlphaAuthService({ ...testCore(), rpId: "localhost", ...options })

/** A visible page over the test's wallet database, with `auth` in place of its own service. */
export function testPage(auth?: unknown): Page {
  return {
    ...testCore(),
    auth: (auth as WebAlphaAuthService) ?? testAuth(),
    visible: memoryStore(true).readonly,
    leaving: memoryStore(false),
    signup: createSignupStash(tabStash),
    pastUser: createPastUser(tabStash),
    // A suite's page reaches no fleet signer and builds no contract service.
    teeSignerSource: { label: "test", load: async () => undefined },
    contractService: () =>
      resource(
        "contractService",
        { from: [], lazy: true, backoff: "manual" },
        () => new Promise<never>(() => {}),
      ),
  }
}

/** Saves device keys through the page's database. */
export const seedDeviceKeys = (values: Parameters<typeof writeDeviceKeys>[1]) =>
  writeDeviceKeys(testCore().database, values)

/** Reads the device keys again, for a test that reopened the wallet store under the page. */
export const reloadDevice = () => testCore().device.load()
