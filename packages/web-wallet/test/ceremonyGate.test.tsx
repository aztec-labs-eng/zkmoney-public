/**
 * The ceremony gate's contract: a phone passes at once; a laptop probes, holds in
 * "awaiting-action" until `proceed`, resolves with the route the user picked, and refuses a
 * below-floor creation (a sign-in never refuses — this computer always answers). Cancel, dismiss
 * and unmount reject the waiter with a cancel, never an error; only cancel aborts the attempt.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CeremonyGate, GateResult, GateState } from "../src/features/identity/ceremonyGate"
import type { DevicePosture } from "@obsidion/passkey-web"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  probePhoneReach: vi.fn(async () => "unknown"),
  rootCredentialId: vi.fn(async () => undefined),
  suggestedRoute: vi.fn(async () => "this-device"),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    probePhoneReach: h.probePhoneReach,
    rootCredentialId: h.rootCredentialId,
    suggestedRoute: h.suggestedRoute,
  }),
}))

const { useCeremonyGate, isGateCancelled } = await import("../src/features/identity/ceremonyGate")

type Handle = { gate: CeremonyGate; state: GateState; cancel: () => void; dismiss: () => void }
let handle: Handle
function Harness({ posture, holdsSignIn }: { posture: DevicePosture; holdsSignIn?: boolean }) {
  handle = useCeremonyGate(() => posture, { holdsSignIn })
  return <span>{handle.state.kind}</span>
}

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const mount = (posture: DevicePosture, holdsSignIn?: boolean) =>
  act(async () => root.render(<Harness posture={posture} holdsSignIn={holdsSignIn} />))

beforeEach(() => {
  h.probePhoneReach.mockReset().mockResolvedValue("unknown")
  h.rootCredentialId.mockReset().mockResolvedValue(undefined)
  h.suggestedRoute.mockReset().mockResolvedValue("this-device")
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("useCeremonyGate", () => {
  it("a phone passes without probing or changing state", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(container.textContent).toBe("idle")
    // Its own passkey is the only route a phone can take, so no route is picked.
    expect(result.route).toBeUndefined()
  })

  it("an anchored sign-in (the hand-off) holds the sheet on a phone, so its assertion runs from a tap", async () => {
    await mount("phone")
    let settled = false
    let promise!: Promise<GateResult>
    await act(async () => {
      promise = handle.gate({ anchor: true }).then((r) => {
        settled = true
        return r
      })
    })
    await flush()
    // No route to pick, so it never probes; it holds the sheet only for the tap that anchors it.
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(container.textContent).toBe("awaiting-action")
    expect(settled).toBe(false)
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the sheet")
    expect(state.prompt).toBe("sign-in")
    await act(async () => state.proceed())
    const result = await promise
    expect(settled).toBe(true)
    expect(result.route).toBeUndefined()
    expect(container.textContent).toBe("idle")
  })

  it("an anchor is ignored when the screen owns the tap: a holdsSignIn-false phone sign-in still passes", async () => {
    await mount("phone", false)
    let result!: GateResult
    await act(async () => {
      result = await handle.gate({ anchor: true })
    })
    expect(container.textContent).toBe("idle")
    expect(result.route).toBeUndefined()
  })

  it("a laptop sign-in holds the Sign in sheet without probing, and resolves on proceed", async () => {
    await mount("laptop")
    let settled = false
    let promise!: Promise<GateResult>
    await act(async () => {
      promise = handle.gate().then((r) => {
        settled = true
        return r
      })
    })
    await flush()
    // A sign-in picks no device — the browser's own chooser does — so it never probes.
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(container.textContent).toBe("awaiting-action")
    expect(settled).toBe(false)

    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the sheet")
    expect(state.prompt).toBe("sign-in")
    await act(async () => state.proceed())
    const result = await promise
    expect(settled).toBe(true)
    expect(result.route).toBeUndefined()
    expect(container.textContent).toBe("idle")
  })

  it("a sign-in ignores a creation sheet's pick and still holds its own sheet", async () => {
    await mount("laptop")
    let promise!: Promise<GateResult>
    await act(async () => {
      promise = handle.gate({ purpose: "sign-in", unheld: "security-key" })
    })
    await flush()
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the sheet")
    expect(state.prompt).toBe("sign-in")
    await act(async () => state.proceed())
    expect((await promise).route).toBeUndefined()
  })

  it("a screen that owns the tap: a laptop sign-in resolves at once, with no sheet and no probe", async () => {
    await mount("laptop", false)
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(container.textContent).toBe("idle")
    expect(result.route).toBeUndefined()
    expect(result.signal.aborted).toBe(false)
    // The hook's cancel still ends the attempt it handed out.
    await act(async () => handle.cancel())
    expect(result.signal.aborted).toBe(true)
  })

  it("a screen that owns the tap still holds a creation's steps and a sign-in's second prompt", async () => {
    await mount("laptop", false)
    let settled = false
    await act(async () => {
      void handle
        .gate({ purpose: "create" })
        .then(() => (settled = true))
        .catch(() => {})
    })
    await flush()
    expect(h.probePhoneReach).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe("awaiting-action")
    if (handle.state.kind !== "awaiting-action") throw new Error("expected the steps")
    expect(handle.state.prompt).toBe("phone-steps")
    expect(settled).toBe(false)
    await act(async () => handle.cancel())

    const again = new AbortController().signal
    await act(async () => {
      void handle.gate({ again }).catch(() => {})
    })
    await flush()
    if (handle.state.kind !== "awaiting-action") throw new Error("expected approve-again")
    expect(handle.state.prompt).toBe("approve-again")
  })

  it("a creation resolves with the route the user picked, so the caller opens on that device", async () => {
    await mount("laptop")
    let promise!: Promise<GateResult>
    await act(async () => {
      promise = handle.gate({ purpose: "create" })
    })
    await flush()
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the steps")
    await act(async () => state.proceed("security-key"))
    const result = await promise
    expect(result.route).toBe("security-key")
  })

  it("a below-floor creation refuses", async () => {
    h.probePhoneReach.mockResolvedValue("below-floor")
    await mount("laptop")
    let error: unknown
    await act(async () => handle.gate({ purpose: "create" }).catch((e) => (error = e)))
    await flush()
    expect(error).toMatchObject({ name: "PhoneUnreachableError" })
    expect(container.textContent).toBe("idle")
  })

  it("a creation whose screen was the sheet probes and resolves at once, on the route the reach allows", async () => {
    await mount("laptop")
    const result = await act(() => handle.gate({ purpose: "create", unheld: "phone" }))
    expect(h.probePhoneReach).toHaveBeenCalledTimes(1)
    expect(result.route).toBe("phone")
    expect(container.textContent).toBe("idle")

    h.probePhoneReach.mockResolvedValue("no-hybrid")
    const keyOnly = await act(() => handle.gate({ purpose: "create", unheld: "phone" }))
    expect(keyOnly.route).toBe("security-key")
  })

  it("keeps the sheet's security-key pick where a phone is reachable", async () => {
    h.probePhoneReach.mockResolvedValue("ok")
    await mount("laptop")
    const result = await act(() => handle.gate({ purpose: "create", unheld: "security-key" }))
    expect(result.route).toBe("security-key")
    expect(container.textContent).toBe("idle")
  })

  it("refuses a browser below the floor whatever the sheet picked", async () => {
    h.probePhoneReach.mockResolvedValue("below-floor")
    await mount("laptop")
    for (const unheld of ["phone", "security-key"] as const) {
      let error: unknown
      let result: unknown
      await act(async () =>
        handle.gate({ purpose: "create", unheld }).then(
          (r) => (result = r),
          (e) => (error = e),
        ),
      )
      expect(error).toMatchObject({ name: "PhoneUnreachableError" })
      expect(result).toBeUndefined()
    }
  })

  it("a creation holds the steps with the probed reach in hand", async () => {
    h.probePhoneReach.mockResolvedValue("no-hybrid")
    await mount("laptop")
    let settled = false
    let promise!: Promise<GateResult>
    await act(async () => {
      promise = handle.gate({ purpose: "create" }).then((r) => {
        settled = true
        return r
      })
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the steps")
    // The steps read this to name a device.
    expect(state.reach).toBe("no-hybrid")
    await act(async () => state.proceed("security-key"))
    await promise
    expect(settled).toBe(true)
  })

  it("a creation whose probe never settles is still ended by cancel", async () => {
    h.probePhoneReach.mockImplementation(() => new Promise(() => {}))
    await mount("laptop")
    let error: unknown
    await act(async () => {
      void handle.gate({ purpose: "create" }).catch((e) => (error = e))
    })
    expect(container.textContent).toBe("probing")
    await act(async () => handle.cancel())
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(container.textContent).toBe("idle")
  })

  it("cancel rejects the waiter with a cancel and resets", async () => {
    await mount("laptop")
    let error: unknown
    await act(async () => {
      void handle.gate().catch((e) => (error = e))
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")
    await act(async () => handle.cancel())
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(container.textContent).toBe("idle")
  })

  it("a second gate call cancels the first waiter", async () => {
    await mount("laptop")
    let first: unknown
    await act(async () => {
      void handle.gate().catch((e) => (first = e))
    })
    await flush()
    await act(async () => {
      void handle.gate().catch(() => {})
    })
    await flush()
    expect(isGateCancelled(first)).toBe(true)
    expect(container.textContent).toBe("awaiting-action")
  })

  it("unmount rejects the waiter with a cancel", async () => {
    await mount("laptop")
    let error: unknown
    await act(async () => {
      void handle.gate().catch((e) => (error = e))
    })
    await flush()
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(isGateCancelled(error)).toBe(true)
  })

  it("cancel during a creation probe rejects with a cancel and the late probe changes nothing", async () => {
    let resolveProbe!: (reach: string) => void
    h.probePhoneReach.mockImplementation(() => new Promise((r) => (resolveProbe = r)))
    await mount("laptop")
    let error: unknown
    await act(async () => {
      void handle.gate({ purpose: "create" }).catch((e) => (error = e))
    })
    expect(container.textContent).toBe("probing")
    await act(async () => handle.cancel())
    await act(async () => resolveProbe("unknown"))
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(container.textContent).toBe("idle")
  })

  it("cancel during a creation probe that never settles ends the call at once", async () => {
    h.probePhoneReach.mockImplementation(() => new Promise(() => {}))
    await mount("laptop")
    let error: unknown
    await act(async () => {
      void handle.gate({ purpose: "create" }).catch((e) => (error = e))
    })
    expect(container.textContent).toBe("probing")
    await act(async () => handle.cancel())
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(container.textContent).toBe("idle")
  })

  it("a plain call hands out the attempt's signal, which cancel aborts", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    expect(result.signal).toBeInstanceOf(AbortSignal)
    expect(result.signal.aborted).toBe(false)
    await act(async () => handle.cancel())
    expect(result.signal.aborted).toBe(true)
  })

  it("a second plain call aborts the first attempt's signal", async () => {
    await mount("phone")
    let first!: GateResult
    let second!: GateResult
    await act(async () => {
      first = await handle.gate()
      second = await handle.gate()
    })
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
  })

  it("a phone asked again holds for one tap, without probing", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    let settled = false
    await act(async () => {
      void handle
        .gate({ again: result.signal })
        .then(() => (settled = true))
        .catch(() => {})
    })
    await flush()
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(container.textContent).toBe("awaiting-action")
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the tap")
    expect(state.prompt).toBe("approve-again")
    expect(settled).toBe(false)
    await act(async () => state.proceed())
    await flush()
    expect(settled).toBe(true)
    expect(container.textContent).toBe("idle")
  })

  /** A laptop's first sign-in, taken through the Sign in sheet; resolves with the attempt's signal. */
  async function firstLaptopGate(): Promise<AbortSignal> {
    let first!: Promise<GateResult>
    await act(async () => {
      first = handle.gate()
    })
    await flush()
    const opened = handle.state
    if (opened.kind !== "awaiting-action") throw new Error("expected the sheet")
    await act(async () => opened.proceed())
    return (await first).signal
  }

  it("a laptop asked again holds for the same tap as a phone, without probing", async () => {
    await mount("laptop")
    const signal = await firstLaptopGate()
    h.probePhoneReach.mockClear()
    let settled = false
    await act(async () => {
      void handle
        .gate({ again: signal })
        .then(() => (settled = true))
        .catch(() => {})
    })
    await flush()
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the tap")
    expect(state.prompt).toBe("approve-again")
    await act(async () => state.proceed())
    await flush()
    expect(settled).toBe(true)
  })

  it("cancel and unmount reject a phone's tap with a cancel", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    let error: unknown
    await act(async () => {
      void handle.gate({ again: result.signal }).catch((e) => (error = e))
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")
    await act(async () => handle.cancel())
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(container.textContent).toBe("idle")

    await act(async () => {
      result = await handle.gate()
    })
    let unmounted: unknown
    await act(async () => {
      void handle.gate({ again: result.signal }).catch((e) => (unmounted = e))
    })
    await flush()
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(isGateCancelled(unmounted)).toBe(true)
  })

  it("dismiss rejects the waiter and leaves the attempt's signal alone", async () => {
    await mount("laptop")
    const signal = await firstLaptopGate()
    let error: unknown
    await act(async () => {
      void handle.gate({ again: signal }).catch((e) => (error = e))
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")
    await act(async () => handle.dismiss())
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(signal.aborted).toBe(false)
    expect(container.textContent).toBe("idle")
  })

  it("a tap answered as the screen goes: the ask is refused, no prompt follows", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    let error: unknown
    let settled = false
    await act(async () => {
      void handle
        .gate({ again: result.signal })
        .then(() => (settled = true))
        .catch((e) => (error = e))
    })
    await flush()
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the tap")
    await act(async () => {
      state.proceed()
      root.unmount()
    })
    root = createRoot(container)
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)
    expect(isGateCancelled(error)).toBe(true)
  })

  it("unmount leaves the attempt's signal alone, and asking the gone screen again is refused", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(result.signal.aborted).toBe(false)
    let error: unknown
    await handle.gate({ again: result.signal }).catch((e) => (error = e))
    expect(isGateCancelled(error)).toBe(true)
  })

  it("a cancelled attempt asked again is refused at once and leaves a newer attempt waiting", async () => {
    await mount("laptop")
    const stale = await firstLaptopGate()
    await act(async () => handle.cancel())
    expect(stale.aborted).toBe(true)

    let newer = false
    await act(async () => {
      void handle
        .gate()
        .then(() => (newer = true))
        .catch(() => {})
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")

    let error: unknown
    await act(async () => handle.gate({ again: stale }).catch((e) => (error = e)))
    expect(isGateCancelled(error)).toBe(true)
    // A sign-in never probes, so neither the first call nor the newer one asked the browser.
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(container.textContent).toBe("awaiting-action")
    const live = handle.state
    if (live.kind !== "awaiting-action") throw new Error("expected the newer waiter")
    await act(async () => live.proceed())
    await flush()
    expect(newer).toBe(true)
  })

  it("a picked route from an earlier call never releases a later waiter", async () => {
    await mount("laptop")
    let first: unknown
    await act(async () => {
      void handle.gate().catch((e) => (first = e))
    })
    await flush()
    const stale = handle.state
    if (stale.kind !== "awaiting-action") throw new Error("expected the picker")
    let second = false
    await act(async () => {
      void handle
        .gate()
        .then(() => (second = true))
        .catch(() => {})
    })
    await flush()
    expect(isGateCancelled(first)).toBe(true)
    await act(async () => stale.proceed("phone"))
    await flush()
    expect(second).toBe(false)
    expect(container.textContent).toBe("awaiting-action")
    const live = handle.state
    if (live.kind !== "awaiting-action") throw new Error("expected the second waiter")
    await act(async () => live.proceed("phone"))
    await flush()
    expect(second).toBe(true)
  })

  it("unmount during a creation probe rejects with a cancel", async () => {
    let resolveProbe!: (reach: string) => void
    h.probePhoneReach.mockImplementation(() => new Promise((r) => (resolveProbe = r)))
    await mount("laptop")
    let error: unknown
    await act(async () => {
      void handle.gate({ purpose: "create" }).catch((e) => (error = e))
    })
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => resolveProbe("no-hybrid"))
    await flush()
    expect(isGateCancelled(error)).toBe(true)
  })

  it("a probe that throws counts as unknown reach and still holds", async () => {
    h.probePhoneReach.mockRejectedValue(new Error("no capabilities"))
    await mount("laptop")
    await act(async () => {
      void handle.gate().catch(() => {})
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")
    await act(async () => handle.cancel())
    await flush()
  })

  it("no auth service yet counts as unknown reach and still holds", async () => {
    h.probePhoneReach.mockResolvedValue(undefined as never)
    await mount("laptop")
    await act(async () => {
      void handle.gate().catch(() => {})
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")
    await act(async () => handle.cancel())
    await flush()
  })
})
