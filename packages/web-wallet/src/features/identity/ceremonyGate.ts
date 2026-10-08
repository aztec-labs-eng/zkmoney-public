import { useCallback, useEffect, useRef, useState } from "react"
import type { SignInRoute } from "@obsidion/core/types"
import {
  type DevicePosture,
  type PasskeyHint,
  type PhoneReach,
  PhoneUnreachableError,
  currentDevicePosture,
  mayStartLaptopCeremony,
  stepsCopyFor,
} from "@obsidion/passkey-web"
import { getAuthService } from "../../platform/auth/useAuthenticator"

/**
 * The moment before a passkey ceremony. Every flow that can end in one awaits the gate its screen
 * owns. On a laptop the gate holds the screen in an "awaiting action" state and resolves once the
 * user taps Continue; a creation additionally checks the browser can reach a phone and hands back
 * the route the user picked (a phone or a key). A sign-in picks no device — the browser's own
 * account chooser lists whatever holds the passkey — so it just shows a "Sign in" sheet and
 * resolves with no route. A phone resolves at once: its own passkey is the only route the policy
 * accepts there. The exception is an `anchor`ed sign-in (the hand-off), whose assertion runs off the
 * intro rather than a button of its own: the phone holds its "Sign in" sheet too, so the sheet's tap
 * carries the user activation the passkey prompt needs.
 *
 * A sign-in that needs a second prompt calls the gate again with that signal: every device holds
 * for one tap on a sheet that says why a second approval is needed.
 *
 * Cancel and unmount reject with a cancel, never an error. `dismiss` drops the held sheet but lets
 * a ceremony past its prompt finish; `cancel` also aborts the attempt behind it.
 */
export type CeremonyPurpose = "create" | "sign-in"

/** What the gate resolves with: the attempt signal, the route a creation picked, and the reach it probed. */
export type GateResult = { signal: AbortSignal; route?: SignInRoute; reach: PhoneReach }

export type GatePrompt = "phone-steps" | "sign-in" | "approve-again"

export type GateState =
  | { kind: "idle" }
  | { kind: "probing" }
  /**
   * `prompt` is what the screen renders: the "Sign in" sheet, the creation steps, or the tap before
   * a second prompt. `reach` is what the browser said about reaching another device, so the creation
   * steps can name a device. `proceed` takes the route a creation picked (a sign-in passes none).
   */
  | {
      kind: "awaiting-action"
      prompt: GatePrompt
      reach: PhoneReach
      proceed: (route?: SignInRoute) => void
    }

export type GateOptions = {
  /** What the ceremony is for; a sign-in shows the "Sign in" sheet, a creation the phone steps. Default sign-in. */
  purpose?: CeremonyPurpose
  /** The attempt whose second passkey prompt this gate precedes. */
  again?: AbortSignal
  /**
   * Hold the sheet on a phone too, for a ceremony driven off no button of its own (the hand-off).
   * The tap the sheet waits for is the user activation the passkey prompt
   * needs; without it the phone browser refuses the assertion.
   */
  anchor?: boolean
  /**
   * The route the screen's own creation sheet picked with its tap: the gate still probes (a
   * below-floor laptop is refused) but holds no sheet of its own. A security key is kept; a phone
   * pick opens on the route the probed reach allows.
   */
  unheld?: SignInRoute
}

/** The route a creation opens on without a pick: the phone where one is reachable, else the key. */
function routeFor(reach: PhoneReach): SignInRoute {
  return stepsCopyFor(reach).routes.some((r) => r.hint === "hybrid") ? "phone" : "security-key"
}

/** The route a creation sheet's control opens on, from the hints it passes. */
export const routeForHints = (hints: readonly PasskeyHint[]): SignInRoute =>
  hints.includes("hybrid") ? "phone" : "security-key"

export type CeremonyGate = (options?: GateOptions) => Promise<GateResult>

export class GateCancelledError extends Error {
  constructor() {
    super("The passkey step was cancelled before it started.")
    this.name = "GateCancelledError"
  }
}

export function isGateCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === "GateCancelledError"
}

const IDLE: GateState = { kind: "idle" }

/** One gate() call; `reject` points at whatever the call is currently waiting on. */
type Attempt = { reject: (err: Error) => void }

async function probe(): Promise<PhoneReach> {
  try {
    return (await getAuthService().probePhoneReach()) ?? "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * `holdsSignIn: false` is for a screen whose own buttons are the tap before a sign-in's first
 * prompt: the gate then hands out the attempt at once on every posture instead of holding the
 * "Sign in" sheet. The second-prompt hold and a creation's steps are unaffected.
 */
export function useCeremonyGate(
  posture: () => DevicePosture = currentDevicePosture,
  { holdsSignIn = true }: { holdsSignIn?: boolean } = {},
): {
  gate: CeremonyGate
  state: GateState
  /** The user's cancel: the held sheet goes, and so does the attempt behind it. */
  cancel: () => void
  /** The sheet goes — the screen is moving on — but an attempt past its prompt runs on. */
  dismiss: () => void
} {
  const [state, setState] = useState<GateState>(IDLE)
  const pending = useRef<Attempt | undefined>(undefined)
  const attempt = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(true)

  const dismiss = useCallback(() => {
    pending.current?.reject(new GateCancelledError())
    pending.current = undefined
    setState(IDLE)
  }, [])

  const cancel = useCallback(() => {
    dismiss()
    attempt.current?.abort()
  }, [dismiss])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      dismiss()
    }
  }, [dismiss])

  /**
   * Hold in `awaiting-action` until the user proceeds; `probeFirst` (a creation only) asks the
   * browser about a phone first, so the steps can name a device and a below-floor laptop is refused.
   */
  const hold = useCallback(
    async (params: {
      prompt: GatePrompt
      purpose: CeremonyPurpose
      probeFirst: boolean
      /** The screen's own sheet already took the tap: resolve straight after the probe, no sheet. */
      unheld?: SignInRoute
    }): Promise<{ route?: SignInRoute; reach: PhoneReach }> => {
      // The waiter is registered before any async work, so a cancel during a probe that never settles
      // still ends the call at once.
      const waiter: Attempt = { reject: () => {} }
      const cancelled = new Promise<never>((_, reject) => (waiter.reject = reject))
      pending.current = waiter
      let reach: PhoneReach = "unknown"
      if (params.probeFirst) {
        setState({ kind: "probing" })
        reach = await Promise.race([probe(), cancelled])
        if (pending.current !== waiter) throw new GateCancelledError()
        if (params.purpose === "create" && !mayStartLaptopCeremony(reach)) {
          pending.current = undefined
          setState(IDLE)
          throw new PhoneUnreachableError()
        }
        if (params.unheld) {
          pending.current = undefined
          setState(IDLE)
          if (!mounted.current) throw new GateCancelledError()
          const route = params.unheld === "security-key" ? params.unheld : routeFor(reach)
          return { route, reach }
        }
      }
      const route = await new Promise<SignInRoute | undefined>((resolve, reject) => {
        waiter.reject = reject
        setState({
          kind: "awaiting-action",
          prompt: params.prompt,
          reach,
          proceed: (picked) => {
            // A button from an earlier render must not release a later call's waiter.
            if (pending.current !== waiter) return
            pending.current = undefined
            setState(IDLE)
            resolve(picked)
          },
        })
      })
      // The screen may have gone between the tap and this continuation; its prompt goes with it.
      if (!mounted.current) throw new GateCancelledError()
      return { route, reach }
    },
    [],
  )

  const gate = useCallback<CeremonyGate>(
    async (options) => {
      const purpose = options?.purpose ?? "sign-in"
      if (options?.again) {
        const signal = options.again
        if (signal.aborted || !mounted.current) throw new GateCancelledError()
        await hold({ prompt: "approve-again", purpose, probeFirst: false })
        return { signal, reach: "unknown" }
      }
      cancel()
      const controller = new AbortController()
      attempt.current = controller
      // A sign-in that owns its own screen's tap (EnterAppScreen, `holdsSignIn: false`) asks nothing
      // here; a phone otherwise resolves at once, its own passkey the only route the policy accepts.
      // The exception is an anchored ceremony: a hand-off's assertion runs off no button of its own,
      // so it asks the gate to hold its "Sign in" sheet on the phone too — the sheet's tap is the
      // fresh user activation the passkey prompt needs, without which the phone browser refuses it.
      const signIn = purpose === "sign-in"
      if (signIn && !holdsSignIn) return { signal: controller.signal, reach: "unknown" }
      if (posture() !== "laptop" && !(signIn && options?.anchor)) {
        return { signal: controller.signal, reach: "unknown" }
      }
      const { route, reach } = await hold({
        prompt: signIn ? "sign-in" : "phone-steps",
        purpose,
        probeFirst: !signIn,
        unheld: signIn ? undefined : options?.unheld,
      })
      return { signal: controller.signal, route, reach }
    },
    [cancel, hold, holdsSignIn, posture],
  )

  return { gate, state, cancel, dismiss }
}
