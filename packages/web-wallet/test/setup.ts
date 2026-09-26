// Vitest setup (vitest.config.ts `setupFiles`): the React 19 act() environment flag,
// previously re-declared per test file.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  HTMLDialogElement.prototype.close ??= function () { this.open = false }
}
