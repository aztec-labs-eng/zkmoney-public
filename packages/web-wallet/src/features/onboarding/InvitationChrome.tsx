import { useState, type ReactNode } from "react"
import { BrandLockup } from "../../ui/BrandLockup"
import { EndpointsModal, customEndpointsLabel } from "../../ui/EndpointsModal"
import { useEndpointsHeld } from "../../session/endpointsHold"
import { usePxeBoot, type BootPage } from "../../ui/PxeBoot"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import inviteGradient from "../../assets/onboarding/invite-gradient.svg"
import landingGradient from "../../assets/onboarding/landing-gradient.svg"

/**
 * Full-bleed invitation frame (ULT-667): the designed gradient canvas, top bar with
 * the wordmark and, off phones, the early-access pill, centered content. The modal steps of
 * the signup flow render over it.
 */
export function InvitationChrome({
  actions,
  bare = false,
  landing = false,
  pill = true,
  page,
  children,
}: {
  /** Controls at the bar's end, after the pill. */
  actions?: ReactNode
  /** Drops the wordmark and the early-access pill, for content that carries its own. */
  bare?: boolean
  /** The fresh-start landing's darker canvas. */
  landing?: boolean
  /** The early-access pill; off for pages that are not an invitation (the 404). */
  pill?: boolean
  page: BootPage
  children: ReactNode
}) {
  const phone = usePhoneLayout()
  return (
    <div className="ww-invite">
      {landing ? (
        <img className="ww-invite__gradient--landing" src={landingGradient} alt="" aria-hidden />
      ) : (
        <img className="ww-invite__gradient" src={inviteGradient} alt="" aria-hidden />
      )}
      <header className="ww-invite__topbar">
        {!bare && <BrandLockup />}
        <span className="ww-invite__topbar-end">
          <EndpointsPill page={page} />
          {!bare && pill && !phone && (
            <span className="ww-invite__pill" data-testid="early-access-pill">
              EARLY ACCESS
              <span className="ww-invite__pill-open">OPEN</span>
            </span>
          )}
          {actions}
        </span>
      </header>
      <div className="ww-invite__center">{children}</div>
    </div>
  )
}

/**
 * The way to the endpoint editor before sign-in, where Settings is out of reach. Saving reloads the
 * page, so it is disabled while the PXE boots or a screen holds it.
 */
function EndpointsPill({ page }: { page: BootPage }) {
  const { config } = page
  const [open, setOpen] = useState(false)
  const held = useEndpointsHeld()
  const { bootStatus } = usePxeBoot(page)
  const label = customEndpointsLabel(config.endpoints)
  return (
    <>
      <button
        type="button"
        className="zkm-btn-reset ww-invite__pill"
        data-testid="invite-endpoints"
        disabled={held || bootStatus === "booting"}
        onClick={() => setOpen(true)}
      >
        {(label ?? "Endpoints").toUpperCase()}
      </button>
      {open && <EndpointsModal config={config} onClose={() => setOpen(false)} />}
    </>
  )
}
