import {
  APPROVE_AGAIN_COPY,
  PHONE_STEPS_COPY,
  SIGN_IN_SHEET_COPY,
  type PasskeyHint,
  type PhoneReach,
  type StepsHero,
  stepsCopyFor,
} from "@obsidion/passkey-web"
import { NumberedStepRow, PrimaryGradientButton } from "@obsidion/web-ds"
import type { GateState } from "./ceremonyGate"

/** The device the steps ask for, drawn so the sheet reads at a glance for people who skip the words. */
function DeviceGlyph({ glyph }: { glyph: StepsHero["glyph"] }) {
  return (
    <svg viewBox="0 0 56 64" role="img" aria-hidden focusable="false">
      {glyph === "phone" ? (
        <>
          <rect
            x="11"
            y="3"
            width="34"
            height="58"
            rx="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <rect x="22" y="8" width="12" height="2.5" rx="1.25" fill="currentColor" />
          <rect x="23" y="53" width="10" height="2.5" rx="1.25" fill="currentColor" opacity="0.5" />
        </>
      ) : (
        <>
          <rect
            x="3"
            y="20"
            width="40"
            height="24"
            rx="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <path
            d="M43 27h7a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3h-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <circle cx="17" cy="32" r="5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        </>
      )}
    </svg>
  )
}

/** The mark on the line above the steps: the sheet that follows cannot be finished without the device. */
function WarningMark() {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="12" fill="var(--accent-gold)" />
      <path d="M12 5.5v7.5" stroke="#141414" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="12" cy="17.6" r="1.6" fill="#141414" />
    </svg>
  )
}

/**
 * The two things a laptop user does next before a creation, which asks for a cross-device
 * authenticator: `onChoose` names the route the browser opens on. `reach` is required so a new call
 * site cannot silently show a browser the phone steps for a route it just said it lacks. The steps
 * are worth showing: the phone that answers may be in another room.
 */
export function PhoneSteps({
  onChoose,
  onCancel,
  cancelLabel = PHONE_STEPS_COPY.cancelLabel,
  reach,
}: {
  onChoose: (hint: PasskeyHint) => void
  onCancel?: () => void
  cancelLabel?: string
  reach: PhoneReach
}) {
  const copy = stepsCopyFor(reach)
  const steps = copy.createSteps
  return (
    <div className="ww-invite-spinner ww-phone-steps" data-testid="phone-steps">
      <div className="ww-phone-steps__hero">
        <DeviceGlyph glyph={copy.hero.glyph} />
        <p className="ww-phone-steps__hero-title">
          <WarningMark />
          {copy.hero.title}
        </p>
      </div>
      <NumberedStepRow index={1}>{steps[0]}</NumberedStepRow>
      <NumberedStepRow index={2}>{steps[1]}</NumberedStepRow>
      <p className="ww-phone-steps__caption">{copy.caption}</p>
      {copy.routes.map((route, i) =>
        i === 0 ? (
          <PrimaryGradientButton
            key={route.hint}
            title={route.label}
            testId="phone-steps-continue"
            onClick={() => onChoose(route.hint)}
          />
        ) : (
          <button
            key={route.hint}
            type="button"
            className="zkm-btn-reset zkm-pressable ww-phone-steps__alt"
            data-testid={`phone-steps-${route.hint}`}
            onClick={() => onChoose(route.hint)}
          >
            {route.label}
          </button>
        ),
      )}
      {onCancel && (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-invite-pill"
          data-testid="phone-steps-cancel"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      )}
    </div>
  )
}

/**
 * The laptop sign-in sheet: one "Continue" that opens the browser's account chooser. The chooser
 * lists whatever holds the passkey — this computer's synced copy, a phone over QR, a security key —
 * and honours no routing hint, so the sheet names the action rather than promising a device.
 */
export function SignInSheet({
  onContinue,
  onCancel,
  busy = false,
  cancelLabel = SIGN_IN_SHEET_COPY.cancelLabel,
}: {
  onContinue: () => void
  onCancel?: () => void
  /** A ceremony is running: no second tap may start a competing prompt. */
  busy?: boolean
  cancelLabel?: string
}) {
  return (
    <div className="ww-invite-spinner ww-phone-steps" data-testid="sign-in-sheet">
      <p className="ww-phone-steps__hero-title">{SIGN_IN_SHEET_COPY.title}</p>
      <p className="ww-phone-steps__caption">{SIGN_IN_SHEET_COPY.subtitle}</p>
      <PrimaryGradientButton
        title={SIGN_IN_SHEET_COPY.continueLabel}
        testId="sign-in-continue"
        isLoading={busy}
        onClick={onContinue}
      />
      {onCancel && (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-invite-pill"
          data-testid="sign-in-cancel"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      )}
    </div>
  )
}

/**
 * The one tap before a sign-in's second passkey prompt, on every device. The prompt would
 * otherwise open seconds after the last tap, which a browser may refuse; the sheet also says why
 * the passkey is asked twice.
 */
export function ApproveAgainStep({
  onContinue,
  onCancel,
  cancelLabel = APPROVE_AGAIN_COPY.cancelLabel,
}: {
  onContinue: () => void
  onCancel?: () => void
  cancelLabel?: string
}) {
  return (
    <div className="ww-invite-spinner ww-phone-steps" data-testid="approve-again">
      <div className="ww-phone-steps__hero">
        <DeviceGlyph glyph="phone" />
        <p className="ww-phone-steps__hero-title">
          <WarningMark />
          {APPROVE_AGAIN_COPY.title}
        </p>
      </div>
      <p className="ww-phone-steps__caption">{APPROVE_AGAIN_COPY.body}</p>
      <PrimaryGradientButton
        title={APPROVE_AGAIN_COPY.continueLabel}
        testId="approve-again-continue"
        onClick={onContinue}
      />
      {onCancel && (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-invite-pill"
          data-testid="approve-again-cancel"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      )}
    </div>
  )
}

/**
 * What a screen shows while its gate holds: the "Sign in" sheet, the creation phone steps, or the
 * one tap before a sign-in's second prompt. The gate's prompt decides, so a sign-in hold hosted by a
 * creation screen still shows the "Sign in" sheet.
 */
export function GateStep({
  state,
  onCancel,
  cancelLabel,
}: {
  state: Extract<GateState, { kind: "awaiting-action" }>
  onCancel?: () => void
  cancelLabel?: string
}) {
  if (state.prompt === "approve-again") {
    return (
      <ApproveAgainStep
        onContinue={() => state.proceed()}
        onCancel={onCancel}
        cancelLabel={cancelLabel}
      />
    )
  }
  if (state.prompt === "sign-in") {
    return (
      <SignInSheet onContinue={() => state.proceed()} onCancel={onCancel} cancelLabel={cancelLabel} />
    )
  }
  // A creation names the cross-device route the browser then opens on.
  return (
    <PhoneSteps
      onChoose={(hint) => state.proceed(hint === "security-key" ? "security-key" : "phone")}
      onCancel={onCancel}
      cancelLabel={cancelLabel}
      reach={state.reach}
    />
  )
}
