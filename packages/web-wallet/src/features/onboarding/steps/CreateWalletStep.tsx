import { PrimaryGradientButton } from "@obsidion/web-ds"
import { BrandLockup } from "../../../ui/BrandLockup"
import { PRIVACY_URL, TERMS_URL } from "../../../lib/links"
import type { InviteNotice } from "./TagAvailabilityNotes"
import { LandingFeatureCards } from "./LandingFeatureCards"
import { useLiveSavingsApy } from "../../savings/savingsGateway"
import { BootSplash } from "../../../ui/PxeBoot"

/** The landing for a visitor with nothing here yet: the claim server draws their tag. */
export function CreateWalletStep({
  busy,
  notice,
  onCreate,
  onLogIn,
  onCancel,
}: {
  busy: boolean
  /** The draw failed; renders under the button. */
  notice?: InviteNotice
  onCreate: () => void
  onLogIn: () => void
  /** Abandons the draw the busy state is waiting on. */
  onCancel: () => void
}) {
  // The live rate is the first card's headline: the page waits for it rather than swap it in.
  const rate = useLiveSavingsApy()
  if (!rate.settled) return <BootSplash />
  return (
    <div className="ww-landing">
      <LandingFeatureCards apy={rate.apy} />
      <div className="ww-invite__content ww-landing__form">
        <div style={{ marginBottom: 32 }}>
          <BrandLockup />
        </div>
        <h1 className="ww-invite__title">Your money, private by default</h1>
        <PrimaryGradientButton
          title="Get started"
          isLoading={busy}
          onClick={onCreate}
          testId="create-wallet"
        />
        {notice?.kind === "error" && (
          <p className="ww-invite__error" role="alert">
            {notice.message}
          </p>
        )}
        {busy ? (
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-invite-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : (
          <p className="ww-invite__footer">
            I already have an account{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={onLogIn}
              data-testid="have-wallet"
            >
              Log in
            </button>
          </p>
        )}
        <nav className="ww-landing__legal">
          <a href={TERMS_URL} target="_blank" rel="noreferrer">
            TERMS AND CONDITIONS
          </a>
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
            PRIVACY POLICY
          </a>
        </nav>
      </div>
    </div>
  )
}
