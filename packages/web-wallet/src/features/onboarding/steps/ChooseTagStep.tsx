import { useRef, useState, type ComponentProps, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { normalizeTag } from "@obsidion/front-core"
import { usePhoneLayout } from "../../../ui/usePhoneLayout"
import { OnboardingCard } from "../OnboardingCard"
import { nameIsUnavailable, useNameAvailability, type RouteNameGrant } from "../nameAvailability"
import {
  GoldenTicketArt,
  GoldenTicketHead,
  GoldenTicketIntro,
  ticketClaimLabel,
  ticketIntroShows,
} from "./GoldenTicketHead"
import { SignupStepper } from "./SignupStepper"
import { TagAvailabilityNotes, type InviteNotice } from "./TagAvailabilityNotes"

/**
 * Step one of a paylink-funded signup (mockup frame 6): the golden ticket, what the link pays, and
 * the tag field and the payment's split inside the stepper modal, over the invitation the visitor
 * came from. The claim button checks the name with the claim server and moves to the passkey step.
 */
export function ChooseTagStep({
  ticket,
  split,
  warning,
  held = false,
  initialHandle,
  busy,
  notice,
  resuming = false,
  grant,
  boundGrantOwner = false,
  onBoundGrant,
  onClaim,
  onLogIn,
  onCancel,
  onClose,
}: {
  ticket: ComponentProps<typeof GoldenTicketHead>
  /** The payment's split rows and notices. */
  split?: ReactNode
  /** Read before the tap that starts the passkey. */
  warning?: ReactNode
  /** The split cannot pay for the account yet. */
  held?: boolean
  initialHandle?: string
  busy: boolean
  notice?: InviteNotice
  resuming?: boolean
  grant?: RouteNameGrant
  boundGrantOwner?: boolean
  onBoundGrant?: (handle: string) => void
  onClaim: (handle: string) => void
  onLogIn: () => void
  /** Abandons the claim-status read the busy state is waiting on. */
  onCancel: () => void
  onClose: () => void
}) {
  const [typed, setTyped] = useState(normalizeTag(initialHandle ?? "") ?? "")
  // The phone intro covers the form: it stays out of reach until the intro is opened.
  const [covered, setCovered] = useState(ticketIntroShows)
  const field = useRef<HTMLInputElement>(null)
  // On a phone focusing the field opens the keyboard and scrolls the sheet: the user taps it instead.
  const phone = usePhoneLayout()
  const valid = normalizeTag(typed) !== null
  const grantToken = grant?.handle === normalizeTag(typed) ? grant.token : undefined
  const {
    status: availability,
    checking,
    grantValid,
    grantBound,
  } = useNameAvailability(typed, true, grantToken)
  const recoverBoundGrant = Boolean(grantToken && grantBound && !boundGrantOwner)
  const allowBlocked = Boolean(grantToken && (grantValid || (grantBound && boundGrantOwner)))
  const grantUnverified = Boolean(grantToken && availability === "unknown" && !checking)
  const taken = nameIsUnavailable(availability, { resuming, allowBlocked })
  const submittable = valid && (!taken || recoverBoundGrant) && !checking && !grantUnverified
  const submit = () => {
    if (!submittable || busy || held) return
    if (recoverBoundGrant) onBoundGrant?.(typed)
    else onClaim(typed)
  }
  return (
    <OnboardingCard
      className="ww-modal--create ww-signup-step ww-ticket-step"
      onClose={busy ? undefined : onClose}
    >
      <form
        className="ww-ticket-step__layout"
        inert={covered}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="ww-ticket-step__main">
          <SignupStepper current={0} />
          <GoldenTicketHead {...ticket} />
          <label className="ww-invite-field">
            <span className="ww-invite-field__label">Your tag</span>
            <span className="ww-invite-field__input">
              <span>@</span>
              <input
                aria-label="Your tag"
                placeholder="tag"
                value={typed}
                ref={field}
                autoFocus={!phone && !initialHandle && !covered}
                data-autofocus={(!phone && !covered) || undefined}
                onChange={(e) => setTyped(e.target.value.replace(/^@/, "").toLowerCase())}
                disabled={busy}
              />
              <span>.zk.money</span>
            </span>
          </label>
          <TagAvailabilityNotes
            typed={typed}
            valid={valid}
            availability={availability}
            checking={checking}
            resuming={resuming}
            allowBlocked={allowBlocked}
            grantUnverified={grantUnverified}
            grantBound={recoverBoundGrant}
            notice={notice}
            onLogIn={onLogIn}
          />
          {split && <div className="ww-ticket-rows">{split}</div>}
          {warning}
          <div className="ww-sheet__actions">
            <PrimaryGradientButton
              title={
                recoverBoundGrant
                  ? "Continue with passkey"
                  : (valid &&
                      ticketClaimLabel(
                        typed,
                        ticket.amount,
                        ticket.tokenDecimals,
                        ticket.tokenSymbol,
                      )) ||
                    "Claim tag"
              }
              isDisabled={!submittable || held}
              isLoading={busy}
              onClick={submit}
            />
            {busy && (
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-invite-cancel"
                onClick={onCancel}
              >
                Cancel
              </button>
            )}
            <p className="ww-invite-modal-foot">
              Already have an account?{" "}
              <button type="button" className="zkm-btn-reset ww-invite__link" onClick={onLogIn}>
                Show passkeys
              </button>
            </p>
          </div>
        </div>
        <GoldenTicketArt {...ticket} tag={valid ? typed : ""} />
      </form>
      <GoldenTicketIntro
        {...ticket}
        onGone={() => {
          flushSync(() => setCovered(false))
          if (!phone) field.current?.focus()
        }}
      />
    </OnboardingCard>
  )
}
