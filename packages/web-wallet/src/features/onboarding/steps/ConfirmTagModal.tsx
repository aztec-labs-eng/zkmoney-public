import { useState } from "react"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { normalizeTag } from "@obsidion/front-core"
import type { RememberedAccount } from "../../../platform/auth/WebPasskeyIdentityMap"
import { OnboardingCard } from "../OnboardingCard"
import { tagError } from "../tagError"

/** What a typed tag came to, shown under the field: a row it duplicates, or what the L1 read said. */
export type ByTagNotice =
  | { kind: "listed"; tag: string }
  | { kind: "notFound"; tag: string }
  | { kind: "reserved"; tag: string }
  | { kind: "staleRollup"; tag: string }
  | { kind: "noKeyInstalled"; tag: string }
  | { kind: "unreadable"; tag: string }
  | { kind: "lookupFailed"; tag: string }

export function noticeText(notice: ByTagNotice): string {
  switch (notice.kind) {
    case "listed":
      return `@${notice.tag} is already on this browser — choose it in the list above.`
    case "notFound":
      return `No registered account for @${notice.tag} yet. If you just signed up, continue with Show passkeys; otherwise check the spelling.`
    case "reserved":
      return `@${notice.tag} is reserved but not active yet. Tap Show passkeys and pick the passkey you reserved it with. Until its deposit lands, the network can't find @${notice.tag} by name.`
    case "staleRollup":
      return `@${notice.tag} was registered on an earlier version of the network. Sign in on the device you registered on to move it.`
    case "noKeyInstalled":
      return `@${notice.tag}'s account has no passkey key installed yet. Continue with Show passkeys and sign in with the passkey you registered with.`
    case "unreadable":
      return `@${notice.tag}'s passkey couldn't be read from the network. Continue with Show passkeys.`
    case "lookupFailed":
      return `Couldn't reach the network to look up @${notice.tag}.`
  }
}

/** The sign-in screen's own state: the field the parent resolves, the remembered accounts, and readiness. */
export type SignInStart = {
  candidates: RememberedAccount[]
  onCandidate: (candidate: RememberedAccount) => void
  value: string
  onTagChange: (tag: string) => void
  onTagBlur: () => void
  /** The typed text is the tag the resolve found: Login (and Enter) fire only then. */
  submitReady: boolean
  resolving: boolean
  /** The manifest and the cache proof are in hand; until then no ceremony action is live. */
  prepared: "pending" | "ready" | "failed"
  onPrepareAgain: () => void
  notice?: ByTagNotice
  /** Show passkeys takes the primary button: the user asked for a different passkey. */
  chooserFirst: boolean
  /** A sign-in is running: no second tap may start a competing prompt. */
  busy: boolean
  /** Opens the endpoint editor; unset where the wallet does not own the endpoints. */
  onEndpoints?: () => void
}

/**
 * The tag card in its two roles. As the sign-in screen (`start`): the remembered accounts this
 * browser holds, a field that resolves as it is typed, Login pinned to what resolved, and "Show
 * passkeys" for the browser's full chooser. As the confirm step (no `start`): the passkey resolved
 * an account whose claim is only known by hash — on the chain, or in a signup's reservation — so
 * the user names it, and "Show passkeys" re-opens the prompt for a different passkey.
 */
export function ConfirmTagModal({
  initialHandle = "",
  error,
  submitTitle = "Login",
  start,
  onConfirm,
  onShowPasskeys,
  onBack,
  onClose,
}: {
  initialHandle?: string
  error?: string
  submitTitle?: string
  start?: SignInStart
  onConfirm: (handle: string) => void
  /** The start role's open request: the browser's own list. */
  onShowPasskeys?: () => void
  /** The confirm role's way back to the sign-in screen, for a passkey that is not the user's. */
  onBack?: () => void
  onClose: () => void
}) {
  const [own, setOwn] = useState(normalizeTag(initialHandle) ?? "")
  const typed = start ? start.value : own
  const normalised = normalizeTag(typed)
  const valid = normalised !== null
  const prepared = !start || start.prepared === "ready"
  const busy = start?.busy ?? false
  // The confirm role submits any well-formed tag; the start role only the tag that resolved.
  const canSubmit = start ? start.submitReady && prepared && !busy : valid
  const submit = () => canSubmit && onConfirm(typed)
  const endpointsFoot = start?.onEndpoints && (
    <p className="ww-invite-modal-foot">
      Using your own node?{" "}
      <button
        type="button"
        className="zkm-btn-reset ww-invite__link"
        data-testid="sign-in-endpoints"
        disabled={busy}
        onClick={start.onEndpoints}
      >
        Endpoints
      </button>
    </p>
  )
  const foot = start ? (
    <p className="ww-invite-modal-foot">
      Can't find your account?{" "}
      <button
        type="button"
        className="zkm-btn-reset ww-invite__link"
        data-testid="sign-in-show-passkeys"
        disabled={!prepared || busy}
        onClick={onShowPasskeys}
      >
        Show passkeys
      </button>
    </p>
  ) : (
    <p className="ww-invite-modal-foot">
      Not your account?{" "}
      <button type="button" className="zkm-btn-reset ww-invite__link" data-testid="confirm-back" onClick={onBack}>
        Go back
      </button>
    </p>
  )
  return (
    <OnboardingCard onClose={onClose} className="ww-modal--create">
      <form
        data-testid={start ? "sign-in-start" : "confirm-tag"}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="ww-invite-modal-head">
          <span className="ww-invite-modal-badge">
            <Icon name="user-search" size={28} color="#fff" />
          </span>
          <h2 className="ww-invite-modal-title ww-invite-modal-title--lg">
            {start ? (
              "Type your @tag"
            ) : (
              <>
                Confirm by typing <br />
                your @tag
              </>
            )}
          </h2>
        </div>
        {start && start.candidates.length > 0 && (
          <div className="ww-invite-field">
            <span className="ww-invite-field__label">Accounts on this browser</span>
            <ul
              className="ww-account-list"
              data-testid="sign-in-accounts"
              aria-label="Accounts on this browser"
            >
              {start.candidates.map((candidate) => (
                <li key={candidate.credentialId}>
                  <button
                    type="button"
                    className="zkm-btn-reset zkm-pressable ww-account-row"
                    data-testid="sign-in-account"
                    aria-label={`Sign in as @${candidate.usertag}`}
                    disabled={!prepared || busy}
                    onClick={() => start.onCandidate(candidate)}
                  >
                    <span className="ww-account-row__tag">
                      @{candidate.usertag}
                      <span className="ww-account-row__domain">.zk.money</span>
                    </span>
                    <span className="ww-account-row__go" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="ww-invite-field">
          <span className="ww-invite-field__label">Your tag</span>
          <span className="ww-invite-field__input">
            <span>@</span>
            <input
              aria-label="Your tag"
              placeholder="tag"
              value={typed}
              autoFocus
              data-autofocus
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value.replace(/^@/, "").toLowerCase()
                if (start) start.onTagChange(next)
                else setOwn(next)
              }}
              onBlur={start?.onTagBlur}
            />
            <span>.zk.money</span>
          </span>
        </label>
        {start && typed && !valid && !start.notice && (
          <p className="ww-invite__error" role="alert">
            {tagError(typed)}
          </p>
        )}
        {start?.resolving && <p className="ww-invite__checking">Finding your passkey…</p>}
        {start?.notice && (
          <p className="ww-invite-modal-error" role="alert" data-testid={`by-tag-${start.notice.kind}`}>
            {noticeText(start.notice)}
            {start.notice.kind === "lookupFailed" && (
              <>
                {" "}
                <button
                  type="button"
                  className="zkm-btn-reset ww-invite__link"
                  data-testid="by-tag-retry"
                  onClick={start.onTagBlur}
                >
                  Try again
                </button>{" "}
                or continue with Show passkeys.
              </>
            )}
          </p>
        )}
        {start?.prepared === "failed" && (
          <p className="ww-invite-modal-error" role="alert" data-testid="sign-in-unprepared">
            Couldn't reach the network.{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              data-testid="sign-in-prepare-again"
              onClick={start.onPrepareAgain}
            >
              Try again
            </button>
          </p>
        )}
        {error && (
          <p className="ww-invite-modal-error" role="alert">
            {error}
          </p>
        )}
        {start?.chooserFirst ? (
          <>
            <PrimaryGradientButton
              title="Show passkeys"
              testId="sign-in-show-passkeys"
              isDisabled={!prepared}
              isLoading={busy}
              onClick={onShowPasskeys}
            />
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-invite-pill"
              data-testid="sign-in-login"
              disabled={!canSubmit}
              onClick={submit}
            >
              {submitTitle}
            </button>
            {endpointsFoot}
          </>
        ) : (
          <>
            <PrimaryGradientButton
              title={submitTitle}
              testId={start ? "sign-in-login" : undefined}
              isDisabled={!canSubmit}
              isLoading={busy}
              onClick={submit}
            />
            {foot}
            {endpointsFoot}
          </>
        )}
      </form>
    </OnboardingCard>
  )
}
