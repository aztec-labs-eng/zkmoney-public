/**
 * Google sign-in for email-locked paylink claims: OIDC implicit flow in a popup, returning an
 * `id_token` whose `nonce` claim is the poseidon2 binding to the claimer's address (what the zkJWT
 * circuit verifies). Same-origin storage relay + alive beacon: COOP `same-origin` severs
 * `window.opener` once the popup navigates to accounts.google.com, so `postMessage` cannot
 * deliver the result — `localStorage` is scoped to the origin rather than the browsing-context
 * group, so it still crosses.
 *
 * Google only: Apple's web flow requires `response_mode=form_post` for the email scope — a server
 * endpoint this stack doesn't have — so Apple-provider claims stay app-only.
 *
 * Unreachable while `emailLockedLinksEnabled` is off.
 */
import { useEffect, useState } from "react"
import { rollupKey, rollupStorage } from "../../platform/storage/rollupStorage"

export const GOOGLE_CALLBACK_PATH = "/auth/google/callback"

const RESULT_KEY = "obsidion-google-callback"
const ALIVE_KEY = "obsidion-google-callback-alive"
const BEAT_INTERVAL_MS = 400
const ALIVE_TIMEOUT_MS = 2_000
const POLL_MS = 250
const SIGNIN_TIMEOUT_MS = 5 * 60_000

/** The sign-in ended without a token because the user backed out, not because anything failed. */
export class GoogleSignInCancelled extends Error {
  constructor() {
    super("Google sign-in was cancelled")
    this.name = "GoogleSignInCancelled"
  }
}

interface GoogleRelayResult {
  idToken?: string
  state?: string
  error?: string
  createdAt?: number
}

// A callback can arrive after its opener was closed. Reap expired relay entries without
// touching another live attempt's token or heartbeat.
function clearExpiredRelays() {
  for (const key of rollupStorage.keys()) {
    if (!key.startsWith(`${RESULT_KEY}:`)) continue
    const state = key.slice(RESULT_KEY.length + 1)
    const result = readResult(state)
    if (!result?.createdAt || Date.now() - result.createdAt > SIGNIN_TIMEOUT_MS) clearRelay(state)
  }
}

const clearRelay = (state: string) => {
  rollupStorage.removeItem(`${RESULT_KEY}:${state}`)
  rollupStorage.removeItem(`${ALIVE_KEY}:${state}`)
}

const readResult = (state: string): GoogleRelayResult | undefined => {
  const raw = rollupStorage.getItem(`${RESULT_KEY}:${state}`)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as GoogleRelayResult
  } catch {
    return undefined
  }
}

const msSinceAlive = (state: string): number | undefined => {
  const raw = rollupStorage.getItem(`${ALIVE_KEY}:${state}`)
  if (!raw) return undefined
  const at = Number(raw)
  return Number.isFinite(at) ? Date.now() - at : undefined
}

/** Runs inside the popup once Google redirects back to our origin. The id_token rides the URL
 * FRAGMENT (implicit flow), so it never reaches server logs. */
export function GoogleCallbackScreen() {
  const [message, setMessage] = useState("Finishing sign-in…")

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""))
    const idToken = params.get("id_token") ?? undefined
    const state = params.get("state")
    if (!state) {
      setMessage("Sign-in state is missing — close this window and try again.")
      return
    }
    rollupStorage.setItem(
      `${RESULT_KEY}:${state}`,
      JSON.stringify({
        idToken,
        state: params.get("state") ?? undefined,
        error: params.get("error") ?? (idToken ? undefined : "no id_token returned"),
        createdAt: Date.now(),
      } satisfies GoogleRelayResult),
    )
    const beat = () => rollupStorage.setItem(`${ALIVE_KEY}:${state}`, String(Date.now()))
    beat()
    const timer = setInterval(beat, BEAT_INTERVAL_MS)
    window.close()
    setMessage("Sign-in complete — you can close this window.")
    return () => clearInterval(timer)
  }, [])

  return (
    <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>
      {message}
    </div>
  )
}

/**
 * Opens Google's authorize page in a popup and resolves with the id_token. `nonce` must be the
 * decimal `PaylinkService.computeNonce(preimage, address)` string — Google echoes it into the
 * id_token's `nonce` claim, which is what binds the resulting zkJWT proof to the claimer.
 */
export async function signInWithGoogleIdToken(
  nonce: string,
  clientId: string,
  loginHint?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new GoogleSignInCancelled()
  clearExpiredRelays()
  const state = crypto.randomUUID()
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${location.origin}${GOOGLE_CALLBACK_PATH}`,
    response_type: "id_token",
    scope: "openid email",
    nonce,
    state,
    prompt: "select_account",
  })
  // Pre-select the locked email in Google's account chooser. A hint only — the commitment check
  // still gates whatever account comes back.
  if (loginHint) params.set("login_hint", loginHint)
  clearRelay(state)
  const popup = window.open(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    `google-signin-${state}`,
    "width=520,height=640",
  )
  if (!popup) throw new Error("the Google sign-in popup was blocked — allow popups and try again")

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      window.removeEventListener("storage", onStorage)
      signal?.removeEventListener("abort", abort)
      clearInterval(poll)
      clearTimeout(timeout)
      clearRelay(state)
      popup.close()
      fn()
    }
    const abort = () => settle(() => reject(new GoogleSignInCancelled()))
    const consume = () => {
      const result = readResult(state)
      if (!result) return
      if (result.error) {
        return settle(() => reject(new Error(`Google sign-in failed: ${result.error}`)))
      }
      if (result.state !== state) {
        return settle(() => reject(new Error("Google sign-in state mismatch — start over")))
      }
      settle(() => resolve(result.idToken!))
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === rollupKey(`${RESULT_KEY}:${state}`)) consume()
    }
    const poll = setInterval(() => {
      consume()
      const since = msSinceAlive(state)
      if (since !== undefined && since > ALIVE_TIMEOUT_MS) {
        settle(() => reject(new GoogleSignInCancelled()))
      }
    }, POLL_MS)
    const timeout = setTimeout(
      () => settle(() => reject(new Error("Google sign-in timed out — try again"))),
      SIGNIN_TIMEOUT_MS,
    )
    window.addEventListener("storage", onStorage)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}
