import { useRef, useState, type ComponentProps, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { usePhoneLayout } from "../../../../ui/usePhoneLayout"
import { useSession } from "../../../../session/session"
import { OnboardingCard } from "../../OnboardingCard"
import { tagSubmit, type TagField } from "../../../registration/nameAvailability"
import {
  GoldenTicketArt,
  GoldenTicketHead,
  GoldenTicketIntro,
  ticketClaimLabel,
  ticketIntroShows,
} from "../GoldenTicketHead"
import { SignupStepper } from "../SignupStepper"
import copy from "./ChooseTagStep.copy"
import styles from "./ChooseTagStep.module.css"
import {
  TagAvailabilityNotes,
  type InviteNotice,
} from "../../../registration/TagAvailabilityNotes/TagAvailabilityNotes"

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
  tagField,
  onType,
  busy,
  notice,
  resuming = false,
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
  /** The tag field the signup flow keeps and probes. */
  tagField: TagField
  onType: (raw: string) => void
  busy: boolean
  notice?: InviteNotice
  resuming?: boolean
  boundGrantOwner?: boolean
  onBoundGrant?: (handle: string) => void
  onClaim: (handle: string) => void
  onLogIn: () => void
  /** Abandons the claim-status read the busy state is waiting on. */
  onCancel: () => void
  onClose: () => void
}) {
  // The phone intro covers the form: it stays out of reach until the intro is opened.
  const { device } = useSession()
  const [covered, setCovered] = useState(() => ticketIntroShows(device.get().ticketIntroSeen))
  const field = useRef<HTMLInputElement>(null)
  // On a phone focusing the field opens the keyboard and scrolls the sheet: the user taps it instead.
  const phone = usePhoneLayout()
  const { typed, status: availability, checking } = tagField
  const offer = tagSubmit(tagField, { resuming, boundGrantOwner, held })
  const { valid, recoverBoundGrant, allowBlocked, grantUnverified, submittable } = offer
  const submit = () => {
    if (!submittable || busy) return
    if (recoverBoundGrant) onBoundGrant?.(typed)
    else onClaim(typed)
  }
  return (
    <OnboardingCard
      className={`ww-modal--create ww-signup-step ww-ticket-step ${styles.step}`}
      onClose={busy ? undefined : onClose}
    >
      <form
        className={styles.layout}
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
            <span className="ww-invite-field__label">{copy.tagLabel}</span>
            <span className="ww-invite-field__input">
              <span>{copy.at}</span>
              <input
                aria-label={copy.tagLabel}
                placeholder={copy.tagPlaceholder}
                value={typed}
                ref={field}
                autoFocus={!phone && !typed && !covered}
                data-autofocus={(!phone && !covered) || undefined}
                onChange={(e) => onType(e.target.value)}
                disabled={busy}
              />
              <span>{copy.domain}</span>
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
          {split && <div className={styles.rows}>{split}</div>}
          {warning}
          <div className="ww-sheet__actions">
            <PrimaryGradientButton
              title={
                recoverBoundGrant
                  ? copy.continueWithPasskey
                  : (valid &&
                      ticketClaimLabel(
                        typed,
                        ticket.amount,
                        ticket.tokenDecimals,
                        ticket.tokenSymbol,
                      )) ||
                    copy.claimTag
              }
              isDisabled={!submittable}
              isLoading={busy}
              onClick={submit}
            />
            {busy && (
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-invite-cancel"
                onClick={onCancel}
              >
                {copy.cancel}
              </button>
            )}
            <p className="ww-invite-modal-foot">
              {copy.haveAccount}{" "}
              <button type="button" className="zkm-btn-reset ww-invite__link" onClick={onLogIn}>
                {copy.showPasskeys}
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
