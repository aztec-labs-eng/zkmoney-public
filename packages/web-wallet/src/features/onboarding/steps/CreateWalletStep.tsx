import { PrimaryGradientButton } from "@obsidion/web-ds"
import { BrandLockup } from "../../../ui/BrandLockup"
import { PRIVACY_URL, TERMS_URL } from "../../../lib/links"
import type { InviteNotice } from "../../registration/TagAvailabilityNotes/TagAvailabilityNotes"
import { LandingFeatureCards, useLandingRate } from "./LandingFeatureCards"
import { BootSplash } from "../../../ui/PxeBoot"
import copy from "./CreateWalletStep.copy"

/** The landing for a visitor with nothing here yet: the claim server draws their tag. */
export function CreateWalletStep({
  busy,
  returning = false,
  notice,
  onCreate,
  onLogIn,
  onCancel,
}: {
  busy: boolean
  /** This browser opened an account before: "Log in" leads and "Create Account" moves to the footer. */
  returning?: boolean
  /** The draw failed; renders under the button. */
  notice?: InviteNotice
  onCreate: () => void
  onLogIn: () => void
  /** Abandons the draw the busy state is waiting on. */
  onCancel: () => void
}) {
  const rate = useLandingRate()
  if (!rate.ready) return <BootSplash />
  const loginFirst = returning && !busy
  return (
    <div className="ww-landing">
      <LandingFeatureCards apy={rate.apy} />
      <div className="ww-invite__content ww-landing__form">
        <div style={{ marginBottom: 32 }}>
          <BrandLockup />
        </div>
        <h1 className="ww-invite__title">{copy.title}</h1>
        <p className="ww-invite__subtitle">{copy.subtitle}</p>
        {loginFirst ? (
          <PrimaryGradientButton title={copy.logIn} onClick={onLogIn} testId="have-wallet" />
        ) : (
          <PrimaryGradientButton
            title={copy.create}
            isLoading={busy}
            onClick={onCreate}
            testId="create-wallet"
          />
        )}
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
            {copy.cancel}
          </button>
        ) : loginFirst ? (
          <p className="ww-invite__footer">
            {copy.newHere}{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={onCreate}
              data-testid="create-wallet"
            >
              {copy.create}
            </button>
          </p>
        ) : (
          <p className="ww-invite__footer">
            {copy.haveAccount}{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={onLogIn}
              data-testid="have-wallet"
            >
              {copy.logIn}
            </button>
          </p>
        )}
        <nav className="ww-landing__legal">
          <a href={TERMS_URL} target="_blank" rel="noreferrer">
            {copy.terms}
          </a>
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
            {copy.privacy}
          </a>
        </nav>
      </div>
    </div>
  )
}
