import {
  APPROVE_AGAIN_COPY,
  PHONE_HELP_COPY,
  PHONE_STEPS_COPY,
  SIGN_IN_SHEET_COPY,
  type PasskeyHint,
  type PhoneReach,
  type StepsHero,
  currentUserAgentInfoSync,
  extensionAnswersPasskeys,
  stepsCopyFor,
} from "@obsidion/passkey-web"
import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import qrPreview from "../../assets/onboarding/passkey-qr-preview.png"
import { PASSKEYS_DOCS_URL, TERMS_URL } from "../../lib/links"
import { routeForHints, type GateState } from "./ceremonyGate"

/** A label under the reason for the phone; its tooltip opens above the card while hovered or focused. */
function TipRow({
  mark,
  label,
  gold,
  testId,
  children,
}: {
  mark: ReactNode
  label: string
  /** A warning row: gold, as the warn box is. */
  gold?: boolean
  testId?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <div className="ww-phone-steps__tiprow" data-testid={testId}>
      <button
        type="button"
        className={
          gold
            ? "zkm-btn-reset ww-phone-steps__tiprow-label ww-phone-steps__tiprow-label--gold"
            : "zkm-btn-reset ww-phone-steps__tiprow-label"
        }
        aria-describedby={id}
      >
        {mark}
        {label}
      </button>
      <div className="ww-phone-steps__tip" role="tooltip" id={id}>
        {children}
      </div>
    </div>
  )
}

/** The managers and keys that work. */
function SupportedPasskeys() {
  const { label, title, providers, refused } = PHONE_STEPS_COPY.supported
  return (
    <TipRow mark={<Icon name="info-circle" size={14} />} label={label}>
      <strong>{title}</strong>
      <ul>
        {providers.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <p>{refused}</p>
    </TipRow>
  )
}

/** Why the passkey is the only way in, for a synced passkey and for a key. */
function PasskeyLoss() {
  const { label, title, body } = PHONE_STEPS_COPY.loss
  return (
    <TipRow gold mark={<Icon name="alert-triangle" size={14} />} label={label}>
      <strong>{title}</strong>
      {body.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </TipRow>
  )
}

/** What to pick when this computer offers to save the passkey: an extension's pop-up, Windows Hello. */
function ThisComputer({ extension, windows }: { extension: boolean; windows: boolean }) {
  const { label, title, extension: lines, refused } = PHONE_STEPS_COPY.thisComputer
  return (
    <TipRow
      gold
      testId="phone-steps-this-computer"
      mark={<Icon name="alert-triangle" size={14} />}
      label={label}
    >
      <strong>{title}</strong>
      {extension && lines.map((line) => <p key={line}>{line}</p>)}
      {windows && <p>{PHONE_HELP_COPY.windows}</p>}
      <p>{refused}</p>
    </TipRow>
  )
}

/** One sentence the user acts on in the browser's prompt, shown only where it applies. */
function StepsNote({ testId, children }: { testId: string; children: string }) {
  return (
    <p className="ww-phone-steps__note" data-testid={testId}>
      <Icon name="info-circle" size={14} />
      {children}
    </p>
  )
}

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

/** The gold box on a sign-up step: what losing the passkey, or the key, means. */
export function PasskeyWarn({
  alert,
  testId,
  children,
}: {
  /** Announced to assistive technology when it appears. */
  alert?: boolean
  testId?: string
  children: ReactNode
}) {
  return (
    <div className="ww-passkey-warn" role={alert ? "alert" : undefined} data-testid={testId}>
      <Icon name="alert-triangle" size={16} color="var(--accent-gold)" />
      <div className="ww-passkey-warn__body">{children}</div>
    </div>
  )
}

/**
 * The creation sheet, the campaign's sign-up sheet in the wallet's frame so a passkey is offered the
 * same way on both fronts. The phone variant: the button drawn over a blurred picture of the
 * browser's QR step, so the picture is not taken for the code to scan, and under the card a link
 * that swaps the sheet to its key variant. The key variant: what a key means for the wallet, the
 * button that opens the browser's sheet on the key, and a way back. Only the two buttons open the
 * browser's sheet. Where the browser reports no phone route the key variant is all there is, with
 * no way back. `reach` is required so a new call site cannot silently show a browser the phone route
 * it just said it lacks.
 */
export function PhoneSteps({
  onChoose,
  onCancel,
  cancelLabel = PHONE_STEPS_COPY.cancelLabel,
  reach,
  details,
  disabled,
}: {
  onChoose: (hints: readonly PasskeyHint[]) => void
  onCancel?: () => void
  cancelLabel?: string
  reach: PhoneReach
  /** What the signup commits to, above both routes: a payment's split. */
  details?: ReactNode
  /** Both routes wait: what they would commit to is not priced yet, or cannot be afforded. */
  disabled?: boolean
}) {
  const [keyPicked, setKeyPicked] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const swapped = useRef(false)
  // A swap removes the control that had focus; the variant's primary button takes it.
  useEffect(() => {
    if (!swapped.current) return
    swapped.current = false
    root.current?.querySelector<HTMLElement>(".ww-phone-steps__primary")?.focus()
  }, [keyPicked])
  const pick = (key: boolean) => {
    swapped.current = true
    setKeyPicked(key)
  }
  const reachCopy = stepsCopyFor(reach)
  const keyOnly = reachCopy === PHONE_STEPS_COPY.noPhone
  const copy = keyPicked ? PHONE_STEPS_COPY.noPhone : reachCopy
  const [route, alt] = copy.routes
  const phone = route.hint === "hybrid"
  const extension = extensionAnswersPasskeys("create")
  const windows = currentUserAgentInfoSync().osFamily === "windows"
  return (
    <div
      ref={root}
      className="ww-invite-spinner ww-phone-steps ww-phone-steps--create"
      data-testid="phone-steps"
    >
      <span className="ww-phone-steps__badge">
        <Icon name="key" size={28} color="#fff" />
      </span>
      <div className="ww-phone-steps__heading">
        <p className="ww-phone-steps__hero-title">{copy.title}</p>
        <p className="ww-phone-steps__sub">{copy.subtitle}</p>
      </div>
      {phone ? (
        <>
          {details}
          <div className="ww-phone-steps__preview">
            <div className="ww-phone-steps__shot">
              <span className="ww-phone-steps__crop">
                <img src={qrPreview} alt="" width={304} height={333} />
              </span>
              <button
                type="button"
                className="zkm-btn-reset ww-phone-steps__show ww-phone-steps__primary"
                data-testid="phone-steps-continue"
                disabled={disabled}
                onClick={() => onChoose([route.hint])}
              >
                <span className="ww-phone-steps__pill">{route.label}</span>
              </button>
            </div>
            {/* The Windows line shows twice: under the button here, and in the card's tooltip below. */}
            {windows && (
              <StepsNote testId="phone-steps-windows-under-button">
                {PHONE_HELP_COPY.windows}
              </StepsNote>
            )}
            <div className="ww-phone-steps__why">
              <p className="ww-phone-steps__why-title">
                <Icon name="shield-check" size={16} color="var(--accent-green)" />
                {PHONE_STEPS_COPY.why.title}
              </p>
              <p className="ww-phone-steps__why-body">
                {PHONE_STEPS_COPY.why.body}{" "}
                <a href={PASSKEYS_DOCS_URL} target="_blank" rel="noreferrer">
                  {PHONE_STEPS_COPY.why.link}
                </a>
                .
              </p>
              <SupportedPasskeys />
              <PasskeyLoss />
              {(extension || windows) && <ThisComputer extension={extension} windows={windows} />}
            </div>
          </div>
        </>
      ) : (
        <>
          <PasskeyWarn alert>
            <p>{PHONE_STEPS_COPY.noPhone.note}</p>
            <p>{PHONE_STEPS_COPY.noPhone.models}</p>
          </PasskeyWarn>
          {extension && (
            <StepsNote testId="phone-steps-extension">{PHONE_STEPS_COPY.extension}</StepsNote>
          )}
          {details}
          <PrimaryGradientButton
            title={route.label}
            testId="phone-steps-continue"
            className="ww-phone-steps__primary"
            isDisabled={disabled}
            onClick={() => onChoose([route.hint])}
          />
        </>
      )}
      {alt && (
        <button
          type="button"
          className="zkm-btn-reset ww-phone-steps__alt"
          data-testid="phone-steps-security-key"
          disabled={disabled}
          onClick={() => pick(true)}
        >
          {alt.label}
        </button>
      )}
      {keyPicked && !keyOnly && (
        <button
          type="button"
          className="zkm-btn-reset ww-phone-steps__alt"
          data-testid="phone-steps-back"
          disabled={disabled}
          onClick={() => pick(false)}
        >
          {PHONE_STEPS_COPY.noPhone.back}
        </button>
      )}
      <p className="ww-phone-steps__legal">
        This is experimental software. Use at your own risk. By signing up you agree to the{" "}
        <a href={TERMS_URL} target="_blank" rel="noreferrer">
          Terms &amp; Conditions
        </a>
        .
      </p>
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
  details,
}: {
  state: Extract<GateState, { kind: "awaiting-action" }>
  onCancel?: () => void
  cancelLabel?: string
  /** A creation's payment split, shown on its sheet. */
  details?: ReactNode
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
      <SignInSheet
        onContinue={() => state.proceed()}
        onCancel={onCancel}
        cancelLabel={cancelLabel}
      />
    )
  }
  // The phone route also names a security key, which keeps a password manager's extension from
  // answering here.
  return (
    <PhoneSteps
      onChoose={(hints) => state.proceed(routeForHints(hints))}
      onCancel={onCancel}
      cancelLabel={cancelLabel}
      reach={state.reach}
      details={details}
    />
  )
}
