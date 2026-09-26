import { useState } from "react"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { normalizeTag } from "@obsidion/front-core"
import { OnboardingCard } from "../OnboardingCard"
import { nameIsUnavailable, useNameAvailability } from "../nameAvailability"
import { SignupStepper } from "./SignupStepper"
import { TagAvailabilityNotes, type InviteNotice } from "./TagAvailabilityNotes"

/**
 * Step one of a paylink-funded signup (Figma 11118:53472): the tag field inside the stepper modal,
 * over the invitation the visitor came from. "Claim tag" checks the name with the claim server and
 * moves to the passkey step.
 */
export function ChooseTagStep({
  initialHandle,
  busy,
  notice,
  resuming = false,
  allowBlocked = false,
  onClaim,
  onLogIn,
  onCancel,
  onClose,
}: {
  initialHandle?: string
  busy: boolean
  notice?: InviteNotice
  resuming?: boolean
  allowBlocked?: boolean
  onClaim: (handle: string) => void
  onLogIn: () => void
  /** Abandons the claim-status read the busy state is waiting on. */
  onCancel: () => void
  onClose: () => void
}) {
  const [typed, setTyped] = useState(normalizeTag(initialHandle ?? "") ?? "")
  const valid = normalizeTag(typed) !== null
  const { status: availability, checking } = useNameAvailability(typed, true)
  const taken = nameIsUnavailable(availability, { resuming, allowBlocked })
  const submittable = valid && !taken && !checking
  const submit = () => {
    if (submittable && !busy) onClaim(typed)
  }
  return (
    <OnboardingCard
      className="ww-modal--create ww-signup-step"
      onClose={busy ? undefined : onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <SignupStepper current={0} />
        <div className="ww-invite-modal-head">
          <span className="ww-invite-modal-badge">
            <Icon name="user-search" size={32} color="#fff" />
          </span>
          <h2 className="ww-invite-modal-title ww-invite-modal-title--lg">
            Choose your
            <br />
            zk.money @tag
          </h2>
        </div>
        <label className="ww-invite-field">
          <span className="ww-invite-field__label">Your tag</span>
          <span className="ww-invite-field__input">
            <span>@</span>
            <input
              aria-label="Your tag"
              placeholder="tag"
              value={typed}
              autoFocus={!initialHandle}
              data-autofocus
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
          notice={notice}
          onLogIn={onLogIn}
        />
        <PrimaryGradientButton
          title="Claim tag"
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
            Cancel
          </button>
        )}
        <p className="ww-invite-modal-foot">
          Already have an account?{" "}
          <button type="button" className="zkm-btn-reset ww-invite__link" onClick={onLogIn}>
            Show passkeys
          </button>
        </p>
      </form>
    </OnboardingCard>
  )
}
