// Vitest setup (vitest.config.ts `setupFiles`): the React 19 act() environment flag,
// previously re-declared per test file.
import { beforeEach, vi } from "vitest"
import { sandboxProfile } from "./fixtures/sandboxProfile"
import { sandboxConfig, TEST_CONFIG } from "./support/seedBootConfig"
import { testWalletDbs } from "./support/fakeWalletDb"

// The config a test page holds when its suite passes none (`support/page.ts`). Resolving it loads
// the config's module graph; the reset drops that graph, so a suite's mocks reach those modules.
;(globalThis as { [key: symbol]: unknown })[TEST_CONFIG] = await sandboxConfig()
vi.resetModules()
const { activateTab } = await import("../src/platform/storage/activeTab")
const { __setWalletDbBackendForTests, closeWalletStore, openWalletStore } = await import(
  "../src/platform/storage/walletStorage"
)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Every test starts on an empty in-memory wallet database for the sandbox fixture's rollup, which a
// suite that boots that fixture lands on. Suites that need persistence, failures or several rollups
// reopen through `testWalletDbs()`.
const walletDbs = testWalletDbs()
const TEST_PAGE = Symbol.for("zk.money/test-page")
__setWalletDbBackendForTests(walletDbs)
beforeEach(async () => {
  await closeWalletStore()
  walletDbs.reset()
  await openWalletStore(sandboxProfile().shared.rollupVersion, { persistent: false })
  // The page a suite built (`support/page.ts`) reads the empty database's device keys.
  const page = (globalThis as { [TEST_PAGE]?: { device: { load(): Promise<void> } } })[TEST_PAGE]
  await page?.device.load()
})

// Suites run as the active tab; takeover suites change this.
activateTab()

// jsdom ships no WebAuthn and no Web Locks, so the onboarding capability check would read every
// jsdom test as an unsupported browser and disable the flow. Suites that opt into the node
// environment have no window at all; tests covering the unsupported branch delete these themselves.
// The lock stand-in serializes per name within this realm, which is what the app relies on.
if (typeof window !== "undefined") {
  ;(window as { PublicKeyCredential?: unknown }).PublicKeyCredential ??= class {}
  const nav = navigator as Navigator & { locks?: unknown }
  if (!nav.locks) {
    const queues = new Map<string, Promise<unknown>>()
    Object.defineProperty(nav, "locks", {
      configurable: true,
      value: {
        request: (name: string, fn: () => Promise<unknown>) => {
          const previous = queues.get(name) ?? Promise.resolve()
          const run = previous.then(fn, fn)
          queues.set(
            name,
            run.catch(() => {}),
          )
          return run
        },
      },
    })
  }
}

// jsdom has the dialog element but no top-layer API. Browser capture tests verify native focus
// and inert behavior; component tests need only the open/close state to exercise their controls.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true }
  HTMLDialogElement.prototype.show ??= function () { this.open = true }
  HTMLDialogElement.prototype.close ??= function () { this.open = false }
}
