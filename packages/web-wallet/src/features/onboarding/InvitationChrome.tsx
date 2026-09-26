import type { ReactNode } from "react"
import { BrandLockup } from "../../ui/BrandLockup"
import inviteGradient from "../../assets/onboarding/invite-gradient.svg"

/**
 * Full-bleed invitation frame (ULT-667): the designed gradient canvas, top bar with
 * the wordmark and the early-access pill, centered content. The modal steps of
 * the signup flow render over it.
 */
export function InvitationChrome({
  topBar = true,
  children,
}: {
  /** The onboarding carousel hides the bar (its frames carry only the gradient). */
  topBar?: boolean
  children: ReactNode
}) {
  return (
    <div className="ww-invite">
      <img className="ww-invite__gradient" src={inviteGradient} alt="" aria-hidden />
      {topBar && (
        <header className="ww-invite__topbar">
          <BrandLockup />
          <span className="ww-invite__pill" data-testid="early-access-pill">
            EARLY ACCESS
            <span className="ww-invite__pill-open">OPEN</span>
          </span>
        </header>
      )}
      <div className="ww-invite__center">{children}</div>
    </div>
  )
}
