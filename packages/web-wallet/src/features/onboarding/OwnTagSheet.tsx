import { useEffect, useState } from "react"
import { normalizeTag } from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { fireOnboardingEvent } from "../../lib/analytics"
import { Modal } from "../../ui/Modal"
import { PAY_PRICE } from "./ChooseNameSheet"
import { useNameAvailability } from "./nameAvailability"
import { TagAvailabilityNotes } from "./steps/TagAvailabilityNotes"
import { loadTagDraft, saveTagDraft } from "./tagPick"

/** The own-tag pick, before or after the passkey. What is typed is kept for the tab. */
export function OwnTagSheet(props: {
  onClose: () => void
  onPick: (name: string) => Promise<void>
  /** A verified past user: the pick is free. */
  free: boolean
  submitLabel: string
  /** Shown while the pick is paid. */
  onVerify?: () => void
  /** Before any account. */
  onLogIn?: () => void
  /** The tag already held, which a pick must differ from. */
  current?: string
}) {
  const [typed, setTyped] = useState(loadTagDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const name = normalizeTag(typed)
  const fresh = name !== null && name !== props.current
  const { status, checking } = useNameAvailability(typed, fresh)
  const available = fresh && !checking && status === "available"
  useEffect(() => {
    fireOnboardingEvent("name_sheet_opened", { screen: "activation" })
  }, [])
  return (
    <Modal
      variant="bare"
      className="ww-deposit-warning ww-deposit-sheet ww-pick-tag"
      label="Choose your zk.money @tag"
      onClose={busy ? undefined : props.onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={busy ? undefined : props.onClose} />
      </div>
      <span className="ww-pick-tag__icon">
        <Icon name="user-search" size={32} color="#fff" />
      </span>
      <GradientText size={24} weight={700}>
        Choose your
        <br />
        zk.money @tag
      </GradientText>
      <label className="ww-choose-name__name">
        <span className="ww-invite-field__label">Your tag</span>
        <span className="ww-invite-field__input ww-choose-name__field">
          <span>@</span>
          <input
            aria-label="Your tag"
            placeholder="tag"
            value={typed}
            autoFocus
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value.replace(/^@/, "").toLowerCase()
              setTyped(next)
              saveTagDraft(next)
            }}
          />
          {available && <Icon name="check-circle" size={16} color="var(--accent-green)" />}
          <span>.zk.money</span>
          <b className="ww-pick-tag__price" data-free={props.free || undefined}>
            {props.free ? "Free" : PAY_PRICE}
          </b>
        </span>
        {available ? (
          <p className="ww-choose-name__ok">Tag available</p>
        ) : (
          <TagAvailabilityNotes
            typed={typed}
            valid={name !== null}
            availability={status}
            checking={checking}
            resuming={false}
          />
        )}
        {error && (
          <p className="ww-invite__error" role="alert">
            {error}
          </p>
        )}
      </label>
      <PrimaryGradientButton
        title={props.submitLabel}
        testId="own-tag-sign-up"
        isDisabled={!available}
        isLoading={busy}
        onClick={async () => {
          if (!available || busy) return
          setBusy(true)
          setError(undefined)
          try {
            await props.onPick(name)
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
          } finally {
            setBusy(false)
          }
        }}
      />
      {props.onVerify && !props.free && (
        <p className="ww-invite-modal-foot">
          Used zk.money before?{" "}
          <button
            type="button"
            className="zkm-btn-reset ww-invite__link"
            data-testid="own-tag-verify"
            disabled={busy}
            onClick={props.onVerify}
          >
            Verify for free
          </button>
        </p>
      )}
      {props.onLogIn && (
        <p className="ww-invite-modal-foot">
          Already have an account?{" "}
          <button
            type="button"
            className="zkm-btn-reset ww-invite__link"
            disabled={busy}
            onClick={props.onLogIn}
          >
            Sign in
          </button>
        </p>
      )}
    </Modal>
  )
}
