import type { ReactNode } from "react"
import { Icon, PrimaryGradientButton, Spinner } from "@obsidion/web-ds"
import copy from "./InvitationStep.copy"
import styles from "./InvitationStep.module.css"
import { tagSubmit, type TagField } from "../../../registration/nameAvailability"
import {
  TagAvailabilityNotes,
  type InviteNotice,
} from "../../../registration/TagAvailabilityNotes/TagAvailabilityNotes"

export type { InviteNotice } from "../../../registration/TagAvailabilityNotes/TagAvailabilityNotes"

/**
 * Invitation page content (ULT-667): heading, the tag input + "Activate account" control with the
 * validity check, the error states, and the log-in footer for returning users.
 *
 * With `header` it switches to the landing layout: that content sits where the heading would,
 * above a stacked tag field and a full-width CTA. Both layouts run the same check and hand the
 * same tag to `onUnlock`.
 */
export function InvitationStep({
  tagField,
  onType,
  busy,
  notice,
  header,
  resuming = false,
  boundGrantOwner = false,
  onBoundGrant,
  onUnlock,
  onLogIn,
  onCancelSignIn,
}: {
  /** The tag field the signup flow keeps and probes. */
  tagField: TagField
  onType: (raw: string) => void
  busy: boolean
  /** A claim-status failure or an already-claimed handle; renders under the input. */
  notice?: InviteNotice
  /** Landing-layout content above the field — the paylink summary on /link. */
  header?: ReactNode
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
  const { typed, status: availability, checking } = tagField
  const offer = tagSubmit(tagField, { resuming, boundGrantOwner })
  const { valid, recoverBoundGrant, allowBlocked, grantUnverified, submittable } = offer
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
      <form
        className="ww-invite__content ww-invite__content--landing ww-invite__content--visitor"
        onSubmit={submit}
      >
        {header}
        <label className="ww-invite-field">
          <span className="ww-invite-field__label">{copy.tagLabel}</span>
          <span className="ww-invite-field__input">
            <span>{copy.at}</span>
            <input
              aria-label={copy.tagLabel}
              placeholder={copy.tagPlaceholder}
              value={typed}
              autoFocus={!typed}
              onChange={(e) => onType(e.target.value)}
              disabled={busy}
            />
            <span>{copy.domain}</span>
          </span>
        </label>
        {checking && (
          <p className="ww-invite__checking">
            <Spinner size={14} />
            {copy.checking}
          </p>
        )}
        {errors}
        <PrimaryGradientButton
          title={recoverBoundGrant ? copy.continueWithPasskey : copy.createAccount}
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
            {copy.cancelSignIn}
          </button>
        )}
        {onLogIn && (
          <p className="ww-invite-modal-foot">
            {copy.haveAccount}{" "}
            <button type="button" className="zkm-btn-reset ww-invite__link" onClick={onLogIn}>
              {copy.logIn}
            </button>
          </p>
        )}
      </form>
    )
  }

  return (
    <div className="ww-invite__content">
      <h1 className="ww-invite__title">{copy.title}</h1>
      <p className="ww-invite__subtitle">{valid ? copy.startInteracting : copy.createYours}</p>
      <form className={styles.inputRow} onSubmit={submit}>
        <input
          className={styles.input}
          aria-label={copy.tagLabel}
          placeholder={copy.tagLabel}
          value={typed}
          autoFocus={!typed}
          onChange={(e) => onType(e.target.value)}
          disabled={busy}
        />
        {checking ? (
          <span className={styles.check}>
            <Spinner size={18} />
          </span>
        ) : (
          submittable && (
            <span className={styles.check} data-testid="handle-valid-check">
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
            copy.continueArrow
          ) : (
            copy.activateArrow
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
          {copy.cancelSignIn}
        </button>
      )}
      {onLogIn && (
        <p className="ww-invite__footer">
          {copy.haveAccount}{" "}
          <button type="button" className="zkm-btn-reset ww-invite__link" onClick={onLogIn}>
            {copy.logIn}
          </button>
        </p>
      )}
    </div>
  )
}
