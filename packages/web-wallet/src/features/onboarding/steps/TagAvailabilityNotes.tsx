import { Spinner } from "@obsidion/web-ds"
import { tagError } from "../tagError"
import { nameIsUnavailable, type NameAvailability } from "../nameAvailability"

export type InviteNotice = { kind: "taken"; handle: string } | { kind: "error"; message: string }

/** Where the docs explain reserved names and how a matching X handle claims one. */
const RESERVED_NAMES_URL = "https://docs.zk.money/docs/get-started"

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
  grantUnverified = false,
  grantBound = false,
  notice,
  onLogIn,
}: {
  typed: string
  valid: boolean
  availability: NameAvailability
  checking: boolean
  resuming: boolean
  allowBlocked?: boolean
  grantUnverified?: boolean
  grantBound?: boolean
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
      {!notice && grantBound && (
        <p className="ww-invite__checking">
          This grant is already linked to a passkey. Continue with that passkey to finish signup.
        </p>
      )}
      {!notice && taken && !grantBound && (
        <p className="ww-invite__error" role="alert">
          {reserved && (!blocked || allowBlocked) ? (
            `@${typed} is being claimed by someone else.`
          ) : (
            <>
              @{typed} is reserved.{" "}
              <a
                className="ww-invite__link"
                href={RESERVED_NAMES_URL}
                target="_blank"
                rel="noreferrer"
              >
                Learn more
              </a>
            </>
          )}
        </p>
      )}
      {!notice && grantUnverified && (
        <p className="ww-invite__error" role="alert">
          We couldn't check this grant. Reload to try again.
        </p>
      )}
      {!notice && resuming && reserved && !taken && (
        <p className="ww-invite__checking">
          @{typed} is reserved. Continue with your passkey to pick it back up.
        </p>
      )}
      {!notice && availability === "available" && !grantBound && (
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
