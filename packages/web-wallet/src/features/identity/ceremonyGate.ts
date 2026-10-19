import { useCallback, useEffect, useRef, useState } from "react"
import type { SignInRoute } from "@obsidion/core/types"
import {
  type DevicePosture,
  type LaptopCreation,
  type PhoneReach,
  type SignUpChoice,
  PhoneUnreachableError,
  currentDevicePosture,
  mayStartLaptopCeremony,
  routeForChoice,
} from "@obsidion/passkey-web"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { signUpSheetOptions } from "./signUpSheetOptions"

/**
 * The moment before a passkey ceremony. Every flow that can end in one awaits the gate its screen
 * owns. On a laptop the gate holds the screen in an "awaiting action" state and resolves once the
 * user taps Continue; a creation additionally checks the browser can reach a phone and whether
 * this laptop may create on its own password manager, and hands back the option the user picked
 * and the route it asks for. A sign-in picks no device — the browser's own account chooser
 * lists whatever holds the passkey — so it just shows a "Sign in" sheet and resolves with no
 * route. A phone resolves at once: its own passkey is the only route the policy accepts there.
 *
 * A sign-in that needs a second prompt calls the gate again with that signal: every device holds
 * for one tap on a sheet that says why a second approval is needed.
 *
 * Cancel and unmount reject with a cancel, never an error. `dismiss` drops the held sheet but lets
 * a ceremony past its prompt finish; `cancel` also aborts the attempt behind it.
 */
export type CeremonyPurpose = "create" | "sign-in"

/**
 * What the gate resolves with: the attempt signal, the option a creation picked and the route it
 * asks for, and what the probes said. Only a creation carries `creation`.
 */
export type GateResult = {
  signal: AbortSignal
  choice?: SignUpChoice
  route?: SignInRoute
  reach: PhoneReach
  creation?: LaptopCreation
}

export type GatePrompt = "phone-steps" | "sign-in" | "approve-again"

export type GateState =
  | { kind: "idle" }
  | { kind: "probing" }
  /**
   * `prompt` is what the screen renders: the "Sign in" sheet, the creation steps, or the tap before
   * a second prompt. `reach` and `creation` are what the browser said, so the creation steps can
   * name a device and offer this computer. `openOn` is the option the sheet opens on when the
   * screen asks for one; `unfinished` marks a sheet re-opened after the browser's prompt closed
   * with nothing made. `proceed` takes the option a creation picked (a sign-in passes none).
   */
  | {
      kind: "awaiting-action"
      prompt: GatePrompt
      reach: PhoneReach
      creation: LaptopCreation
      openOn?: SignUpChoice
      unfinished?: boolean
      proceed: (choice?: SignUpChoice) => void
    }

/** A pick the screen's own sheet took, with the managers its Supported passkeys listed. */
export type UnheldPick = { choice: SignUpChoice; supported: readonly string[] }

export type GateOptions = {
  /** What the ceremony is for; a sign-in shows the "Sign in" sheet, a creation the phone steps. Default sign-in. */
  purpose?: CeremonyPurpose
  /** The attempt whose second passkey prompt this gate precedes. */
  again?: AbortSignal
  /**
   * The option the screen's own creation sheet picked with its tap: the gate still probes (a
   * below-floor laptop is refused) and holds no sheet of its own while the fresh options still
   * offer that option with the same managers. Otherwise it holds the sheet on where the pick now
   * lands, so the user taps again.
   */
  unheld?: UnheldPick
  /** Hold the creation sheet on this option: a refusal's way back, or a closed prompt's. */
  openOn?: SignUpChoice
  /** The sheet re-opens after the browser's prompt closed with nothing made. */
  unfinished?: boolean
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

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

/** What a sign-in, a phone, or a failed probe says about this laptop creating: it doesn't. */
export const PHONE_CREATION: LaptopCreation = { local: false, chromeTip: false }

/** One gate() call; `reject` points at whatever the call is currently waiting on. */
type Attempt = { reject: (err: Error) => void }

async function probeReach(): Promise<PhoneReach> {
  try {
    return (await getAuthService().probePhoneReach()) ?? "unknown"
  } catch {
    return "unknown"
  }
}

async function probeCreation(): Promise<LaptopCreation> {
  try {
    return (await getAuthService().probeLaptopCreation?.()) ?? PHONE_CREATION
  } catch {
    return PHONE_CREATION
  }
}

type Probed = { reach: PhoneReach; creation: LaptopCreation }

/** Both probes for one attempt, so a creation sheet never opens on half an answer. */
async function probe(): Promise<Probed> {
  const [reach, creation] = await Promise.all([probeReach(), probeCreation()])
  return { reach, creation }
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
   * browser about a phone and this computer first, so the steps can name a device and a below-floor
   * laptop is refused.
   */
  const hold = useCallback(
    async (params: {
      prompt: GatePrompt
      purpose: CeremonyPurpose
      probeFirst: boolean
      /** The screen's own sheet already took the tap: resolve straight after the probe, no sheet. */
      unheld?: UnheldPick
      openOn?: SignUpChoice
      unfinished?: boolean
    }): Promise<Probed & { choice?: SignUpChoice }> => {
      // The waiter is registered before any async work, so a cancel during a probe that never settles
      // still ends the call at once.
      const waiter: Attempt = { reject: () => {} }
      const cancelled = new Promise<never>((_, reject) => (waiter.reject = reject))
      pending.current = waiter
      let probed: Probed = { reach: "unknown", creation: PHONE_CREATION }
      let openOn = params.openOn
      if (params.probeFirst) {
        setState({ kind: "probing" })
        probed = await Promise.race([probe(), cancelled])
        if (pending.current !== waiter) throw new GateCancelledError()
        if (params.purpose === "create" && !mayStartLaptopCeremony(probed.reach)) {
          pending.current = undefined
          setState(IDLE)
          throw new PhoneUnreachableError()
        }
        if (params.unheld && !openOn) {
          const { choice, supported } = params.unheld
          const fresh = signUpSheetOptions({ ...probed, preferred: choice })
          const now = fresh.options.find((o) => o.id === choice)
          if (now && sameList(now.supported, supported)) {
            pending.current = undefined
            setState(IDLE)
            if (!mounted.current) throw new GateCancelledError()
            return { ...probed, choice }
          }
          // The pick no longer means what the user saw: the sheet again, never another device in
          // silence. The same option behind other managers is a new pick, so the sheet opens fresh.
          openOn = now ? signUpSheetOptions(probed).selected : fresh.selected
        }
      }
      const choice = await new Promise<SignUpChoice | undefined>((resolve, reject) => {
        waiter.reject = reject
        setState({
          kind: "awaiting-action",
          prompt: params.prompt,
          ...probed,
          openOn,
          unfinished: params.unfinished,
          proceed: (choice) => {
            // A button from an earlier render must not release a later call's waiter.
            if (pending.current !== waiter) return
            pending.current = undefined
            setState(IDLE)
            resolve(choice)
          },
        })
      })
      // The screen may have gone between the tap and this continuation; its prompt goes with it.
      if (!mounted.current) throw new GateCancelledError()
      return { ...probed, choice }
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
      const signIn = purpose === "sign-in"
      if (signIn && !holdsSignIn) return { signal: controller.signal, reach: "unknown" }
      if (posture() !== "laptop") return { signal: controller.signal, reach: "unknown" }
      const { choice, reach, creation } = await hold({
        prompt: signIn ? "sign-in" : "phone-steps",
        purpose,
        probeFirst: !signIn,
        ...(signIn
          ? {}
          : {
              unheld: options?.unheld,
              openOn: options?.openOn,
              unfinished: options?.unfinished,
            }),
      })
      return {
        signal: controller.signal,
        ...(choice ? { choice, route: routeForChoice(choice) } : {}),
        reach,
        ...(signIn ? {} : { creation }),
      }
    },
    [cancel, hold, holdsSignIn, posture],
  )

  return { gate, state, cancel, dismiss }
}
