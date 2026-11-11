/**
 * Google sign-in for email-locked paylink claims: OIDC implicit flow in a popup, returning an
 * `id_token` whose `nonce` claim is the poseidon2 binding to the claimer's address (what the zkJWT
 * circuit verifies). The popup hands the result back over a `BroadcastChannel`: COOP `same-origin`
 * severs `window.opener` once the popup navigates to accounts.google.com, so `postMessage` cannot
 * deliver it, while a channel reaches every window of the origin.
 *
 * Google only: Apple's web flow requires `response_mode=form_post` for the email scope — a server
 * endpoint this stack doesn't have — so Apple-provider claims stay app-only.
 *
 * Unreachable while `emailLockedLinksEnabled` is off.
 */
import { WalletError } from "@obsidion/core/errors"

export const GOOGLE_CALLBACK_PATH = "/auth/google/callback"

/** Every attempt listens here and takes only the result naming its own `state`. */
export const GOOGLE_RELAY_CHANNEL = "obsidion-google-callback"
const SIGNIN_TIMEOUT_MS = 5 * 60_000

/** The sign-in ended without a token because the user backed out, not because anything failed. */
export class GoogleSignInCancelled extends Error {
  constructor() {
    super("Google sign-in was cancelled")
    this.name = "GoogleSignInCancelled"
  }
}

interface GoogleRelayResult {
  state: string
  idToken?: string
  error?: string
}

/**
 * Posts the callback's result to the attempt that opened the popup. The id_token rides the URL
 * FRAGMENT (implicit flow), so it never reaches server logs. False when the fragment names no
 * attempt.
 */
export function relayGoogleCallback(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const idToken = params.get("id_token") ?? undefined
  const state = params.get("state")
  if (!state) return false
  const result: GoogleRelayResult = {
    state,
    idToken,
    error: params.get("error") ?? (idToken ? undefined : "no id_token returned"),
  }
  const channel = new BroadcastChannel(GOOGLE_RELAY_CHANNEL)
  channel.postMessage(result)
  channel.close()
  return true
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
  const popup = window.open(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    `google-signin-${state}`,
    "width=520,height=640",
  )
  if (!popup) throw new WalletError("unknown", "the Google sign-in popup was blocked")
  // Listening before this task ends, so no result can be posted unheard.
  const channel = new BroadcastChannel(GOOGLE_RELAY_CHANNEL)

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      channel.close()
      signal?.removeEventListener("abort", abort)
      clearTimeout(timeout)
      popup.close()
      fn()
    }
    const abort = () => settle(() => reject(new GoogleSignInCancelled()))
    channel.onmessage = ({ data }: MessageEvent<GoogleRelayResult>) => {
      const { idToken, error } = data
      if (data.state !== state) return
      if (error) settle(() => reject(new WalletError("aborted", `Google sign-in failed: ${error}`)))
      else if (idToken) settle(() => resolve(idToken))
    }
    const timeout = setTimeout(
      () =>
        settle(() => reject(new WalletError("aborted", "Google sign-in timed out — try again"))),
      SIGNIN_TIMEOUT_MS,
    )
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}
