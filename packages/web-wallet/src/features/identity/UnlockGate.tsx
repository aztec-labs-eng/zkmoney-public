import { useEffect, useRef, useState, type ReactNode } from "react"
import { Navigate } from "react-router-dom"
import { useAccountContext, useAztecContext } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { failureCode, fireEvent } from "../../lib/analytics"
import { passkeyTelemetry } from "../../lib/passkeyTelemetry"
import {
  isPasskeyCancelled,
  isPasskeyPolicyError,
  type PasskeyAttemptHandle,
} from "@obsidion/passkey-web"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { mismatchVerdictOf } from "../../platform/auth/WebAlphaAuthService"
import { hasRecordFor } from "../../platform/auth/WebPasskeyIdentityMap"
import { getActiveCredentialId } from "../../platform/storage/activeStorage"
import { useAsyncAction } from "../../ui/hooks"
import { BootSplash } from "../../ui/PxeBoot"
import { PasskeyRefusal, STORED_ADDRESS_MISMATCH, type RouteRefusal } from "./PasskeyRefusal"
import { signOut } from "./signOut"

/**
 * Holds the wallet surface until the account is unlocked. A session whose cached key proves out
 * never lands here: the auth service restores it before front-core asks. The locked pane is the
 * no-cache case (a fresh browser, a sign-out, a cache that failed its checks): "Unlock with passkey"
 * opens the browser's own prompt, one assertion re-derives the key, verified against this browser's
 * record through the wallet's pure address derivation (`unlock`), then front-core's `retryUnlock`
 * installs the account. A device whose AccountStorage record is gone, or whose active passkey has no
 * record here, is routed to /enter.
 */
export function UnlockGate({ children }: { children: ReactNode }) {
  const { obsidionAccount, accountExists, unlockError, retryUnlock } = useAccountContext()
  const { obsidionWallet } = useAztecContext()
  const { busy, run } = useAsyncAction()
  const [refusal, setRefusal] = useState<RouteRefusal>()
  const [toEnter, setToEnter] = useState(false)
  // The key was recovered but front-core could not install the account; its reason is shown.
  const [installFailed, setInstallFailed] = useState(false)
  const attempt = useRef<AbortController | undefined>(undefined)
  const attemptRef = useRef<PasskeyAttemptHandle | undefined>(undefined)

  // Leaving the screen ends the attempt behind its prompt: nothing commits for a pane that is gone.
  useEffect(
    () => () => {
      attemptRef.current?.unmounted()
      attempt.current?.abort()
    },
    [],
  )

  // Demo mode holds the master key in memory but builds no account contract — there is no PXE.
  if (obsidionAccount || isDemoMode()) return <>{children}</>
  if (accountExists === false || toEnter) return <Navigate to="/enter" replace />
  const credentialId = getActiveCredentialId()
  if (accountExists && (!credentialId || !hasRecordFor(getConfig().rpId, credentialId))) {
    return <Navigate to="/enter" replace />
  }
  if (!unlockError || !obsidionWallet) return <BootSplash inShell />

  const unlock = () => {
    setRefusal(undefined)
    setInstallFailed(false)
    // A newer tap supersedes the attempt behind any open prompt: its abort tears that prompt down
    // and lets the service start a fresh flight rather than a second, competing one.
    attempt.current?.abort()
    attemptRef.current?.superseded()
    const controller = new AbortController()
    attempt.current = controller
    const tracked = passkeyTelemetry.begin({ ceremony: "unlock", flow: "unlock" })
    attemptRef.current = tracked
    void run(async () => {
      try {
        await tracked.run((own) =>
          getAuthService().unlock(
            (msk, pubkeyHex) =>
              obsidionWallet
                .deriveAccountAddress(msk, pubkeyHex)
                .then((address) => address.toString()),
            { signal: controller.signal, own },
          ),
        )
      } catch (e) {
        // A superseded attempt's late answer belongs to nobody: the newer tap owns the pane.
        if (controller.signal.aborted || isPasskeyCancelled(e)) return
        if (e instanceof Error && e.name === "NoPasskeySessionError") {
          setToEnter(true)
          return
        }
        // The session moved while the prompt was open: its owner (a commit here, the guard's reload
        // after another tab's change) settles the screen.
        if (e instanceof Error && e.name === "SessionChangedError") return
        // A record we hold no longer reproduces from this passkey: our own refusal row, with the
        // verdict that picks the copy.
        const verdict = mismatchVerdictOf(e)
        if (verdict) {
          fireEvent("action_failed", { action: "identity:unlock", code: failureCode(e) })
          setRefusal({ name: STORED_ADDRESS_MISMATCH, message: "", verdict })
          return
        }
        if (isPasskeyPolicyError(e)) {
          fireEvent("action_failed", { action: "identity:unlock", code: failureCode(e) })
          setRefusal({ name: e.name, message: e.message })
          return
        }
        throw e
      }
      if (controller.signal.aborted) return
      await retryUnlock()
      // An installed account unmounts this pane; a pane still here means the install failed and
      // front-core's `unlockError` now carries the reason.
      setInstallFailed(true)
    }, "identity:unlock")
  }

  /**
   * Sign out and land on the sign-in screen with Show passkeys first. `avoid` names the credential
   * that just returned the wrong key, so the screen hides its row instead of offering it again.
   */
  const chooseAnotherPasskey = (avoid?: string) => {
    attempt.current?.abort()
    attemptRef.current?.userCancelled()
    void run(async () => {
      await signOut()
      location.assign(
        avoid ? `/enter?choose=1&avoid=${encodeURIComponent(avoid)}` : "/enter?choose=1",
      )
    }, "identity:choose-passkey")
  }

  const exits = (
    <button
      type="button"
      className="zkm-btn-reset zkm-pressable ww-invite-pill"
      data-testid="unlock-choose-passkey"
      disabled={busy}
      onClick={() => chooseAnotherPasskey()}
    >
      Use a different passkey
    </button>
  )

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        width: "100%",
        maxWidth: 430,
        margin: "0 auto",
      }}
    >
      {refusal ? (
        <PasskeyRefusal
          error={refusal}
          verdict={refusal.verdict}
          onRetry={() => unlock()}
          busy={busy}
          // The certain wrong key: this copy would answer again, so the way on is another device.
          primary={
            refusal.verdict === "wrong-key"
              ? {
                  title: "Show passkeys",
                  onClick: () => chooseAnotherPasskey(credentialId ?? undefined),
                  testId: "unlock-show-passkeys",
                }
              : undefined
          }
          exits={exits}
          testId="unlock-refused"
          retryTestId="unlock-retry"
        />
      ) : (
        <div style={{ textAlign: "center", padding: "48px 0 16px" }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.25, margin: "12px 0 8px" }}>
            Welcome back
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.45, margin: 0 }}>
            Unlock with the passkey you signed up with. Transactions are approved with it
            afterwards.
          </p>
          {installFailed && (
            <p
              role="alert"
              data-testid="unlock-install-failed"
              style={{
                color: "var(--accent-gold)",
                fontSize: 13,
                lineHeight: 1.45,
                margin: "16px 0 0",
                overflowWrap: "anywhere",
              }}
            >
              Your passkey worked, but the wallet could not load the account: {unlockError}
            </p>
          )}
          <div style={{ marginTop: 24 }}>
            <PrimaryGradientButton
              title="Unlock with passkey"
              isLoading={busy}
              onClick={() => unlock()}
            />
          </div>
          <div style={{ marginTop: 12 }}>{exits}</div>
        </div>
      )}
    </div>
  )
}
