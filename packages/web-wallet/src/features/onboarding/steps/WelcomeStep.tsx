import type { ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import { OnboardingCard } from "../OnboardingCard"
import { SignupStepper } from "./SignupStepper"

/**
 * Step two of a paylink-funded signup (Figma 11118:53767): what the passkey does for the reserved
 * tag, then the ceremony. The tag price is not quoted here — the payment covers it, and the split
 * is reviewed before the claim on the next step. `actions` is the CTA or whatever the ceremony is
 * showing in its place (spinner, device gate, refusal); `notices` sits above it.
 */
export function WelcomeStep({
  tag,
  resuming = false,
  notices,
  actions,
  onClose,
}: {
  tag: string
  resuming?: boolean
  notices?: ReactNode
  actions: ReactNode
  onClose?: () => void
}) {
  return (
    <OnboardingCard className="ww-modal--create ww-signup-step" onClose={onClose}>
      <SignupStepper current={1} />
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
      {notices}
      {actions}
    </OnboardingCard>
  )
}
