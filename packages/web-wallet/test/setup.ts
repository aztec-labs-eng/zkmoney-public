// Vitest setup (vitest.config.ts `setupFiles`): the React 19 act() environment flag,
// previously re-declared per test file.
import { beforeEach } from "vitest"
import { activateTab } from "../src/platform/storage/activeTab"
import { setActiveRollup } from "../src/platform/storage/rollupStorage"
import {
  __setWalletDbBackendForTests,
  closeWalletStore,
  openWalletStore,
} from "../src/platform/storage/walletStorage"
import { sandboxProfile } from "./fixtures/sandboxProfile"
import { testWalletDbs } from "./support/fakeWalletDb"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The storage partition a booted wallet would have, so suites that never boot a profile can use
// storage, and one that boots the sandbox fixture later lands on the same partition.
setActiveRollup(sandboxProfile().shared.rollupVersion)

// Every test starts on an empty in-memory wallet database for that rollup. Suites that need
// persistence, failures or several rollups reopen through `testWalletDbs()`.
const walletDbs = testWalletDbs()
__setWalletDbBackendForTests(walletDbs)
beforeEach(async () => {
  await closeWalletStore()
  walletDbs.reset()
  await openWalletStore(sandboxProfile().shared.rollupVersion, { persistent: false })
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
