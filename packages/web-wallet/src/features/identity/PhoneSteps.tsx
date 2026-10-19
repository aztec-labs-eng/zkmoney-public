import {
  APPROVE_AGAIN_COPY,
  type KeyWarning,
  type LaptopCreation,
  PHONE_STEPS_COPY,
  SIGN_IN_SHEET_COPY,
  SIGN_UP_SHEET_COPY,
  type PhoneReach,
  type SignUpChoice,
  type SignUpOptions,
  type SignUpSheetLine,
  type StepsHero,
} from "@obsidion/passkey-web"
import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { PASSKEYS_DOCS_URL, TERMS_URL } from "../../lib/links"
import { PHONE_CREATION, type GateState } from "./ceremonyGate"
import { SignUpChoiceSelect } from "./SignUpChoiceSelect"
import { SIGN_UP_ICONS, signUpSheetOptions } from "./signUpSheetOptions"

/**
 * A label whose tip opens above its row on a press; a second press, Escape, or a press or focus
 * elsewhere closes it. Never on hover: the pointer often rests here when the sheet appears.
 */
function TipRow({
  mark,
  label,
  testId,
  children,
}: {
  mark: ReactNode
  label: string
  testId?: string
  children: ReactNode
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: Event) => {
      if (!row.current?.contains(event.target as Node)) setOpen(false)
    }
    // Capture: the sheet around the tip closes on an Escape that reaches it.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", closeOnEscape, true)
    return () => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape, true)
    }
  }, [open])
  return (
    <div
      ref={row}
      className="ww-phone-steps__tiprow"
      data-testid={testId}
      data-open={open || undefined}
      onBlur={(event) => {
        // Focus moved to another control; text selected inside the tip moves it nowhere.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="zkm-btn-reset ww-phone-steps__tiprow-label"
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
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

/** Under Continue: the help page's list of the passkeys that work. */
function DocsLink() {
  const { label, anchor } = PHONE_STEPS_COPY.local.docs
  return (
    <div className="ww-phone-steps__facts">
      <a
        className="ww-phone-steps__docs"
        data-testid="phone-steps-docs"
        href={`${PASSKEYS_DOCS_URL}#${anchor}`}
        target="_blank"
        rel="noreferrer"
      >
        {label}
      </a>
    </div>
  )
}

/** One sentence the user acts on in the browser's prompt, shown only where it applies. */
function StepsNote({ testId, children }: { testId?: string; children: ReactNode }) {
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

/** What a key means for the wallet, behind a line like the advice above it. */
function KeyWarningLine({ warning }: { warning: KeyWarning }) {
  return (
    <TipRow
      testId="phone-steps-key-warning"
      mark={<Icon name="info-circle" size={14} />}
      label={warning.label}
    >
      <strong>{warning.label}</strong>
      <p>{warning.note}</p>
      <p>{warning.models}</p>
    </TipRow>
  )
}

/** Over the picker: why the sheet opened where it did, or how to add 1Password. */
function SheetLine({ line }: { line: SignUpSheetLine }) {
  if (line.kind === "unfinished") {
    return (
      <p className="ww-phone-steps__unfinished" role="alert" data-testid="phone-steps-unfinished">
        {line.text}
      </p>
    )
  }
  return <StepsNote testId={`phone-steps-${line.kind}`}>{line.text}</StepsNote>
}

/** The legal line and the cancel pill the sheet ends with. */
function SheetFoot({ onCancel, cancelLabel }: { onCancel?: () => void; cancelLabel: string }) {
  return (
    <>
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
    </>
  )
}

/** The red line over a running creation: a script zk.money cannot use answers the page. */
export function ExtensionWarning({ text }: { text: string }) {
  return (
    <p className="ww-phone-steps__warning" role="alert" data-testid="phone-steps-extension-warning">
      {text}
    </p>
  )
}

/**
 * The laptop sign-up sheet: where the new passkey will live, picked from what `signUpOptionsFor`
 * offers, the picked option's advice, and one Continue that opens the browser's prompt. The options
 * are read once the browser has answered and kept for the mount, so nothing moves under a user
 * looking at them: not an extension that appears later, nor a refusal counted meanwhile. `reach` is
 * required so a new call site cannot silently offer a browser the phone it just said it lacks.
 */
export function PhoneSteps({
  onChoose,
  onCancel,
  cancelLabel = PHONE_STEPS_COPY.cancelLabel,
  reach,
  creation = PHONE_CREATION,
  openOn,
  unfinished,
  details,
  disabled,
  loading,
  busy,
  warning,
  tag,
}: {
  /** The option picked, the managers behind it, and the warning the running sheet then shows. */
  onChoose: (choice: SignUpChoice, supported: readonly string[], warning?: string) => void
  onCancel?: () => void
  cancelLabel?: string
  reach: PhoneReach
  creation?: LaptopCreation
  /** The option to open on, where the probes still offer it. */
  openOn?: SignUpChoice
  /** The sheet re-opens after the browser's prompt closed with nothing made. */
  unfinished?: boolean
  /** What the signup commits to, above the picker: a payment's split. */
  details?: ReactNode
  /** Nothing can start: what it would commit to is not priced yet, or cannot be afforded. */
  disabled?: boolean
  /** The browser has not yet said what it allows: the heading and a waiting button only. */
  loading?: boolean
  /** The chosen option is running: the loading layout under this label. */
  busy?: string
  /** Over the running button, while the creation runs with an extension zk.money cannot use. */
  warning?: string
  /** Bare tag the passkey is for, shown under the heading. */
  tag?: string
}) {
  const pickerLabel = useId()
  const sheet = useRef<SignUpOptions>(undefined)
  if (!loading && !busy && sheet.current === undefined) {
    sheet.current = signUpSheetOptions({ creation, reach, preferred: openOn, unfinished })
  }
  const [picked, setPicked] = useState<SignUpChoice>()
  const tagPill = tag && (
    <span className="ww-tag-pill ww-tag-pill--sm">
      <strong>@{tag}</strong>
      <span>.zk.money</span>
    </span>
  )
  const top = (
    <>
      <span className="ww-phone-steps__badge">
        <Icon name="key" size={28} color="#fff" />
      </span>
      <div className="ww-phone-steps__heading">
        <p className="ww-phone-steps__hero-title">{SIGN_UP_SHEET_COPY.title}</p>
        {tagPill}
      </div>
      {details}
    </>
  )

  const classes = "ww-invite-spinner ww-phone-steps ww-phone-steps--create"
  if (loading || busy || !sheet.current) {
    return (
      <div className={classes} data-testid="phone-steps">
        {top}
        {busy && warning && <ExtensionWarning text={warning} />}
        <PrimaryGradientButton
          title={busy ?? "Checking this browser…"}
          testId="phone-steps-loading"
          isLoading
        />
        <SheetFoot onCancel={onCancel} cancelLabel={cancelLabel} />
      </div>
    )
  }

  const { options, selected, line, warning: sheetWarning } = sheet.current
  const option = options.find((o) => o.id === (picked ?? selected)) ?? options[0]
  return (
    <div className={classes} data-testid="phone-steps" data-choice={option.id}>
      {top}
      {/* Both lines speak to a Windows or Linux user outside Chrome, so they sit together. */}
      {creation.chromeTip && (
        <StepsNote testId="phone-steps-chrome-tip">
          <span>
            <strong>{PHONE_STEPS_COPY.chromeTip.lead}</strong>{" "}
            {PHONE_STEPS_COPY.chromeTip[creation.chromeTip]}
          </span>
        </StepsNote>
      )}
      {line && <SheetLine line={line} />}
      {options.length > 1 && (
        <p className="ww-phone-steps__picker-label" id={pickerLabel}>
          {SIGN_UP_SHEET_COPY.pickerLabel}
        </p>
      )}
      <SignUpChoiceSelect
        options={options.map((o) => ({
          id: o.id,
          icon: SIGN_UP_ICONS[o.id],
          label: o.label,
          description: o.description,
        }))}
        selected={option.id}
        onChange={setPicked}
        labelledBy={pickerLabel}
        disabled={disabled}
      />
      <div className="ww-phone-steps__advice">
        {/* The key warning sits outside, so opening its tip is not read as new advice. */}
        <div className="ww-phone-steps__advice" aria-live="polite" data-testid="phone-steps-advice">
          {option.advice.map((text) => (
            <StepsNote key={text}>{text}</StepsNote>
          ))}
        </div>
        {option.keyWarning && <KeyWarningLine warning={option.keyWarning} />}
      </div>
      <PrimaryGradientButton
        title={SIGN_UP_SHEET_COPY.continueLabel}
        testId="phone-steps-continue"
        isDisabled={disabled}
        onClick={() => onChoose(option.id, option.supported, sheetWarning)}
      />
      <DocsLink />
      <SheetFoot onCancel={onCancel} cancelLabel={cancelLabel} />
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
  tag,
  onPick,
}: {
  state: Extract<GateState, { kind: "awaiting-action" }>
  onCancel?: () => void
  cancelLabel?: string
  /** A creation's payment split, shown on its sheet. */
  details?: ReactNode
  /** Bare tag the passkey is for. */
  tag?: string
  /** The sheet's warning for the run that follows, handed over in the same click as the pick. */
  onPick?: (warning: string | undefined) => void
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
  return (
    <PhoneSteps
      onChoose={(choice, _supported, warning) => {
        onPick?.(warning)
        state.proceed(choice)
      }}
      onCancel={onCancel}
      cancelLabel={cancelLabel}
      reach={state.reach}
      creation={state.creation}
      openOn={state.openOn}
      unfinished={state.unfinished}
      details={details}
      tag={tag}
    />
  )
}
