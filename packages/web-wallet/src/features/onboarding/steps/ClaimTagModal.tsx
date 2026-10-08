import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { OnboardingCard, OnboardingSpinnerBody } from "../OnboardingCard"

/**
 * Claim retry modal: shown when the auto-started claim fails so it can be
 * retried without minting a second passkey. Busy variant is the claiming spinner.
 */
export function ClaimTagModal({
  handle,
  busy,
  error,
  onClaim,
  onCancel,
  onClose,
}: {
  handle: string
  busy: boolean
  error?: string
  onClaim: () => void
  /** Stops watching the in-flight claim and returns to the idle modal. */
  onCancel: () => void
  onClose: () => void
}) {
  if (busy) {
    return (
      <OnboardingCard
        className="ww-modal--create"
        banner={`People pay to '${handle}.zk.money', instead of a complex 0x hex address.`}
      >
        <OnboardingSpinnerBody label="Claiming your tag…" onCancel={onCancel} />
      </OnboardingCard>
    )
  }
  return (
    <OnboardingCard onClose={onClose}>
      <div className="ww-invite-modal-head">
        <Icon name="check-seal" size={56} color="#A000FF" />
        <h2 className="ww-invite-modal-title">You're almost in</h2>
        <p className="ww-invite-modal-body">
          Claim '{handle}.zk.money' as your zk.money payments @tag.
        </p>
      </div>
      {error && (
        <p className="ww-invite-modal-error" role="alert">
          {error}
        </p>
      )}
      <PrimaryGradientButton title="Claim @tag" onClick={onClaim} />
    </OnboardingCard>
  )
}

/** The brief "All set!" success card between the claim and the wallet. */
export function AllSetModal() {
  return (
    <OnboardingCard narrow>
      <div className="ww-invite-spinner" data-testid="all-set">
        <Icon name="check-circle" size={32} color="var(--accent-green)" />
        <span className="zkm-type-body" style={{ color: "var(--text-primary)" }}>
          All set!
        </span>
      </div>
    </OnboardingCard>
  )
}
