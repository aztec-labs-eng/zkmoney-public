import { Spinner } from "@obsidion/web-ds"
import { tagError } from "../tagError"
import { nameIsUnavailable, type NameAvailability } from "../nameAvailability"

export type InviteNotice = { kind: "taken"; handle: string } | { kind: "error"; message: string }

/**
 * What the tag field says under itself: the shape error, the availability answer, a claim-status
 * failure or an already-claimed handle. Shared by the invitation page and the choose-tag step.
 */
export function TagAvailabilityNotes({
  typed,
  valid,
  availability,
  checking,
  resuming,
  allowBlocked = false,
  notice,
  onLogIn,
}: {
  typed: string
  valid: boolean
  availability: NameAvailability
  checking: boolean
  resuming: boolean
  allowBlocked?: boolean
  notice?: InviteNotice
  onLogIn?: () => void
}) {
  const blocked = availability === "blocked" || availability === "blocked-reserved"
  const reserved = availability === "reserved" || availability === "blocked-reserved"
  const taken = nameIsUnavailable(availability, { resuming, allowBlocked })
  return (
    <>
      {checking && (
        <p className="ww-invite__checking">
          <Spinner size={14} />
          Checking availability…
        </p>
      )}
      {typed && !valid && !notice && (
        <p className="ww-invite__error" role="alert">
          {tagError(typed)}
        </p>
      )}
      {!notice && taken && (
        <p className="ww-invite__error" role="alert">
          {reserved && (!blocked || allowBlocked)
            ? `@${typed} is being claimed by someone else.`
            : `@${typed} isn't available.`}
        </p>
      )}
      {!notice && resuming && reserved && !taken && (
        <p className="ww-invite__checking">
          @{typed} is reserved. Continue with your passkey to pick it back up.
        </p>
      )}
      {!notice && availability === "available" && (
        <p className="ww-invite__ok">@{typed} is available.</p>
      )}
      {notice?.kind === "error" && (
        <p className="ww-invite__error" role="alert">
          {notice.message}
        </p>
      )}
      {notice?.kind === "taken" && (
        <p className="ww-invite__error" role="alert">
          @{notice.handle} has already been claimed.
          {onLogIn && (
            <>
              {" "}
              If it's yours,{" "}
              <button type="button" className="zkm-btn-reset ww-invite__link" onClick={onLogIn}>
                log in
              </button>
              .
            </>
          )}
        </p>
      )}
    </>
  )
}
