import type { ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import { OnboardingCard } from "../OnboardingCard"
import { SignupStepper } from "./SignupStepper"

/**
 * Step two of a paylink-funded signup (Figma 11118:53767): the welcome for the reserved tag, the
 * payment's split (the account is paid for out of it, so the person sees what they keep before
 * creating it), then the ceremony. `actions` is the CTA or whatever the ceremony is showing
 * in its place (spinner, device gate, refusal); `notices` sits above it. A `gated` hold shows the
 * gate's own sheet alone: it carries the split itself. While
 * the ceremony runs (`busy`) the welcome steps aside; the split stays with the spinner.
 */
export function WelcomeStep({
  tag,
  resuming = false,
  gated = false,
  busy = false,
  split,
  notices,
  actions,
  onClose,
}: {
  tag: string
  resuming?: boolean
  gated?: boolean
  busy?: boolean
  /** The payment's split rows. */
  split?: ReactNode
  notices?: ReactNode
  actions: ReactNode
  onClose?: () => void
}) {
  return (
    <OnboardingCard className="ww-modal--create ww-signup-step" onClose={onClose}>
      <SignupStepper current={1} />
      {!gated && !busy && (
        <>
          <div className="ww-invite-modal-head">
            <span className="ww-invite-modal-badge">
              <Icon name="user-follow" size={32} color="#fff" />
            </span>
            <h2 className="ww-invite-modal-title ww-invite-modal-title--lg">
              {resuming ? "Continue your signup" : `Welcome ${tag}!`}
            </h2>
          </div>
        </>
      )}
      {!gated && split}
      {notices}
      {actions}
    </OnboardingCard>
  )
}
