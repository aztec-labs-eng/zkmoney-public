import { Spinner } from "@obsidion/web-ds"
import { tagError } from "../tagError"
import { nameIsUnavailable, type NameAvailability } from "../nameAvailability"
import { fmt } from "../../../lib/fmt"
import copy from "./TagAvailabilityNotes.copy"

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
          {copy.checking}
        </p>
      )}
      {typed && !valid && !notice && (
        <p className="ww-invite__error" role="alert">
          {tagError(typed)}
        </p>
      )}
      {!notice && grantBound && <p className="ww-invite__checking">{copy.grantBound}</p>}
      {!notice && taken && !grantBound && (
        <p className="ww-invite__error" role="alert">
          {reserved && (!blocked || allowBlocked) ? (
            fmt(copy.beingClaimed, { tag: typed })
          ) : (
            <>
              {fmt(copy.reserved, { tag: typed })}{" "}
              <a
                className="ww-invite__link"
                href={RESERVED_NAMES_URL}
                target="_blank"
                rel="noreferrer"
              >
                {copy.learnMore}
              </a>
            </>
          )}
        </p>
      )}
      {!notice && grantUnverified && (
        <p className="ww-invite__error" role="alert">
          {copy.grantUnverified}
        </p>
      )}
      {!notice && resuming && reserved && !taken && (
        <p className="ww-invite__checking">{fmt(copy.reservedResume, { tag: typed })}</p>
      )}
      {!notice && availability === "available" && !grantBound && (
        <p className="ww-invite__ok">{fmt(copy.available, { tag: typed })}</p>
      )}
      {notice?.kind === "error" && (
        <p className="ww-invite__error" role="alert">
          {notice.message}
        </p>
      )}
      {notice?.kind === "taken" && (
        <p className="ww-invite__error" role="alert">
          {fmt(copy.taken, { tag: notice.handle })}
          {onLogIn && (
            <>
              {" "}
              {copy.yours}{" "}
              <button type="button" className="zkm-btn-reset ww-invite__link" onClick={onLogIn}>
                {copy.logIn}
              </button>
              {copy.period}
            </>
          )}
        </p>
      )}
    </>
  )
}
