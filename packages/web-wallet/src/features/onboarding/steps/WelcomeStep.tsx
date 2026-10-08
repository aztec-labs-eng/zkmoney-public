import type { ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import { OnboardingCard } from "../OnboardingCard"
import { SignupStepper } from "./SignupStepper"

/**
 * Step two of a paylink-funded signup (Figma 11118:53767): what the passkey does for the reserved
 * tag, the payment's split (the account is paid for out of it, so the person sees what they keep
 * before creating it), then the ceremony. `actions` is the CTA or whatever the ceremony is showing
 * in its place (spinner, device gate, refusal); `notices` sits above it. A `gated` hold shows the
 * gate's own sheet alone: it carries the split itself. While
 * the ceremony runs (`busy`) the welcome and the points step aside; the split stays with the spinner.
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
          <ul className="ww-invite-facts">
            {tag && (
              <li>
                <Icon name="at" size={20} color="#fff" />
                <span>Reserve &lsquo;{tag}.zk.money&rsquo; as your zk.money payments @tag.</span>
              </li>
            )}
            <li>
              <Icon name="key" size={20} color="#fff" />
              <span>Sign in with a passkey. No password, no seed phrase.</span>
            </li>
            <li>
              <Icon name="install" size={20} color="#fff" />
              <span>Backed up by your passkey provider. Nothing to write down or remember.</span>
            </li>
          </ul>
        </>
      )}
      {!gated && split}
      {notices}
      {actions}
    </OnboardingCard>
  )
}
