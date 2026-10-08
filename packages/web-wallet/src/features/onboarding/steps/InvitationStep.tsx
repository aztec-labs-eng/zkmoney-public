import { useState, type ReactNode } from "react"
import { Icon, PrimaryGradientButton, Spinner } from "@obsidion/web-ds"
import { normalizeTag } from "@obsidion/front-core"
import { nameIsUnavailable, useNameAvailability, type RouteNameGrant } from "../nameAvailability"
import { TagAvailabilityNotes, type InviteNotice } from "./TagAvailabilityNotes"

export type { InviteNotice } from "./TagAvailabilityNotes"

/**
 * Invitation page content (ULT-667): heading, the tag input + "Activate account" control with the
 * validity check, the error states, and the log-in footer for returning users.
 *
 * With `header` it switches to the landing layout: that content sits where the heading would,
 * above a stacked tag field and a full-width CTA. Both layouts run the same check and hand the
 * same tag to `onUnlock`.
 */
export function InvitationStep({
  initialHandle,
  busy,
  notice,
  header,
  checkAvailability = false,
  grant,
  resuming = false,
  boundGrantOwner = false,
  onBoundGrant,
  onUnlock,
  onLogIn,
  onCancelSignIn,
}: {
  initialHandle?: string
  busy: boolean
  /** A claim-status failure or an already-claimed handle; renders under the input. */
  notice?: InviteNotice
  /** Landing-layout content above the field — the paylink summary on /link. */
  header?: ReactNode
  /** Probe account-service for the typed tag. Off where the step renders as inert chrome. */
  checkAvailability?: boolean
  grant?: RouteNameGrant
  /**
   * The user is picking a signup back up rather than starting one, so an existing reservation is
   * no longer a reason to stop them: it may well be their own, and only the claim server can say.
   */
  resuming?: boolean
  boundGrantOwner?: boolean
  onBoundGrant?: (handle: string) => void
  onUnlock: (handle: string) => void
  /** Returning-user footer link; omitted on the post-passkey "type your handle" pass. */
  onLogIn?: () => void
  /** Abandons whatever made this step busy. */
  onCancelSignIn: () => void
}) {
  const [typed, setTyped] = useState(normalizeTag(initialHandle ?? "") ?? "")
  const valid = normalizeTag(typed) !== null
  const grantToken = grant?.handle === normalizeTag(typed) ? grant.token : undefined
  const {
    status: availability,
    checking,
    grantValid,
    grantBound,
  } = useNameAvailability(typed, checkAvailability, grantToken)
  const recoverBoundGrant = Boolean(grantToken && grantBound && !boundGrantOwner)
  const allowBlocked = Boolean(grantToken && (grantValid || (grantBound && boundGrantOwner)))
  const grantUnverified = Boolean(grantToken && availability === "unknown" && !checking)
  // The probe knows a name is held, never by whom. A resume may continue through its own hold;
  // only a live route grant may continue through the blocklist.
  const taken = nameIsUnavailable(availability, { resuming, allowBlocked })
  const submittable = valid && (!taken || recoverBoundGrant) && !checking && !grantUnverified
  const activate = () => {
    if (!submittable || busy) return
    if (recoverBoundGrant) onBoundGrant?.(typed)
    else onUnlock(typed)
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    activate()
  }
  const errors = (
    <TagAvailabilityNotes
      typed={typed}
      valid={valid}
      availability={availability}
      checking={false}
      resuming={resuming}
      allowBlocked={allowBlocked}
      grantUnverified={grantUnverified}
      grantBound={recoverBoundGrant}
      notice={notice}
      onLogIn={onLogIn}
    />
  )

  if (header) {
    return (
      <form className="ww-invite__content ww-invite__content--landing" onSubmit={submit}>
        {header}
        <label className="ww-invite-field">
          <span className="ww-invite-field__label">Your tag</span>
          <span className="ww-invite-field__input">
            <span>@</span>
            <input
              aria-label="Your tag"
              placeholder="tag"
              value={typed}
              autoFocus={!initialHandle}
              onChange={(e) => setTyped(e.target.value.replace(/^@/, "").toLowerCase())}
              disabled={busy}
            />
            <span>.zk.money</span>
          </span>
        </label>
        {checking && (
          <p className="ww-invite__checking">
            <Spinner size={14} />
            Checking availability…
          </p>
        )}
        {errors}
        <PrimaryGradientButton
          title={recoverBoundGrant ? "Continue with passkey" : "Create account"}
          isDisabled={!submittable}
          isLoading={busy}
          onClick={activate}
        />
        {busy && (
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-invite-cancel"
            onClick={onCancelSignIn}
          >
            Cancel sign-in
          </button>
        )}
        {onLogIn && (
          <p className="ww-invite-modal-foot">
            Already have an account?{" "}
            <button type="button" className="zkm-btn-reset ww-invite__link" onClick={onLogIn}>
              Log in
            </button>
          </p>
        )}
      </form>
    )
  }

  return (
    <div className="ww-invite__content">
      <h1 className="ww-invite__title">You're in!</h1>
      <p className="ww-invite__subtitle">
        {valid ? "Start interacting with zk.money" : "Create your zk.money account"}
      </p>
      <form className="ww-invite__inputrow" onSubmit={submit}>
        <input
          className="ww-invite__input"
          aria-label="Your tag"
          placeholder="Your tag"
          value={typed}
          autoFocus={!initialHandle}
          onChange={(e) => setTyped(e.target.value.replace(/^@/, "").toLowerCase())}
          disabled={busy}
        />
        {checking ? (
          <span className="ww-invite__check">
            <Spinner size={18} />
          </span>
        ) : (
          submittable && (
            <span className="ww-invite__check" data-testid="handle-valid-check">
              <Icon name="check-circle" size={18} color="var(--accent-green)" />
            </span>
          )
        )}
        <button
          type="submit"
          data-testid="unlock-access"
          className="ww-invite__unlock"
          disabled={!submittable || busy}
        >
          {busy ? (
            <Spinner size={14} color="#fff" />
          ) : recoverBoundGrant ? (
            <>Continue with passkey &rarr;</>
          ) : (
            <>Activate account &rarr;</>
          )}
        </button>
      </form>
      {errors}
      {busy && (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-invite-cancel"
          onClick={onCancelSignIn}
        >
          Cancel sign-in
        </button>
      )}
      {onLogIn && (
        <p className="ww-invite__footer">
          Already have an account?{" "}
          <button type="button" className="zkm-btn-reset ww-invite__link" onClick={onLogIn}>
            Log in
          </button>
        </p>
      )}
    </div>
  )
}
