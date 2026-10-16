import {
  APPROVE_AGAIN_COPY,
  type LaptopCreation,
  PHONE_HELP_COPY,
  PHONE_STEPS_COPY,
  SIGN_IN_SHEET_COPY,
  type PasskeyHint,
  type PhoneReach,
  type StepsHero,
  type SupportedCopy,
  currentUserAgentInfoSync,
  extensionAnswersPasskeys,
  extensionLineFor,
  localNoteFor,
  repeatedRefusalLineFor,
  stepsCopyFor,
  supportedFor,
} from "@obsidion/passkey-web"
import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { Warning } from "../../ui/Warning"
import qrPreview from "../../assets/onboarding/passkey-qr-preview.png"
import { PASSKEYS_DOCS_URL, TERMS_URL } from "../../lib/links"
import { localRefusalsOverLimit } from "../../platform/auth/localRefusals"
import { PHONE_CREATION, routeForHints, type GateState, type SheetVariant } from "./ceremonyGate"

/**
 * A label under a variant's button. A press opens its tip above the row; a second press, Escape,
 * or a press or focus elsewhere closes it. Never on hover: the pointer often rests here when the
 * sheet appears.
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
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: Event) => {
      if (!row.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", closeOutside)
    return () => document.removeEventListener("pointerdown", closeOutside)
  }, [open])
  return (
    <div
      ref={row}
      className="ww-phone-steps__tiprow"
      data-testid={testId}
      data-open={open || undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false)
      }}
      onBlur={(event) => {
        // Focus moved to another control; text selected inside the tip moves it nowhere.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
        }
      }}
    >
      <button
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

/** The managers and keys that work on this variant. */
function SupportedPasskeys({ copy }: { copy: SupportedCopy }) {
  const { label, title, providers, refused } = copy
  return (
    <TipRow
      testId="phone-steps-supported"
      mark={<Icon name="info-circle" size={14} />}
      label={label}
    >
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

/** Where Chrome could create on this computer and this browser cannot: why to switch, behind a label. */
function ChromeTip({ kind }: { kind: "apple" | "gpm" }) {
  const { label, title } = PHONE_STEPS_COPY.chromeTip
  return (
    <TipRow
      testId="phone-steps-chrome-tip"
      mark={<Icon name="info-circle" size={14} />}
      label={label}
    >
      <strong>{title}</strong>
      <p>{PHONE_STEPS_COPY.chromeTip[kind]}</p>
    </TipRow>
  )
}

/** Under a variant's button: which passkeys work on it, the Chrome tip where one applies, and the docs link. */
function Facts({
  supported,
  chromeTip,
}: {
  supported: SupportedCopy
  chromeTip?: "apple" | "gpm"
}) {
  return (
    <div className="ww-phone-steps__facts">
      <SupportedPasskeys copy={supported} />
      {chromeTip && <ChromeTip kind={chromeTip} />}
      <a className="ww-phone-steps__docs" href={PASSKEYS_DOCS_URL} target="_blank" rel="noreferrer">
        {PHONE_STEPS_COPY.docsLink}
      </a>
    </div>
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

/** A link under a variant's card that swaps the sheet to another variant. */
function AltLink({
  testId,
  disabled,
  onClick,
  children,
}: {
  testId: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="zkm-btn-reset ww-phone-steps__alt"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** The top-left arrow that returns to the variant this one was reached from. */
function BackArrow({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <div className="ww-phone-steps__back">
      <TopNavIconButton
        icon="chevron-left"
        ariaLabel="Back"
        testId="phone-steps-back"
        disabled={disabled}
        onClick={onClick}
      />
    </div>
  )
}

/** The legal line and the cancel pill every variant ends with. */
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

/**
 * The variant the sheet opens on. `openOn` is honoured where the probes allow it; otherwise this
 * computer where it may create, else the phone, else the key.
 */
function initialVariant(
  localOk: boolean,
  phoneOk: boolean,
  openOn: SheetVariant | undefined,
): SheetVariant {
  const want = openOn ?? (localOk ? "local" : "phone")
  if (want === "local") return localOk ? "local" : phoneOk ? "phone" : "key"
  if (want === "phone") return phoneOk ? "phone" : localOk ? "local" : "key"
  return "key"
}

/**
 * The creation sheet, the campaign's sign-up sheet in the wallet's frame so a passkey is offered the
 * same way on both fronts. Three variants, one shown at a time. The local variant, where
 * `creation` says this laptop may create on its own password manager: the button that opens the
 * browser's prompt on this computer, and links to the other two. A row with 1Password alone opens
 * on the phone unless an extension answers, with "Have 1Password?" as the way to this computer.
 * The phone variant: the button drawn over a blurred picture of the browser's QR step, so the
 * picture is not taken for the code to scan, and under the card a link that swaps the sheet to its
 * key variant. The key variant: what a key means for the wallet, the button that opens the
 * browser's sheet on the key, and a way back. Only the three buttons open the browser's sheet.
 * Where the browser reports no phone route the phone variant is never shown. `reach` is required
 * so a new call site cannot silently show a browser the phone route it just said it lacks.
 */
export function PhoneSteps({
  onChoose,
  onCancel,
  cancelLabel = PHONE_STEPS_COPY.cancelLabel,
  reach,
  creation = PHONE_CREATION,
  openOn,
  from,
  unfinished,
  details,
  disabled,
  loading,
  busy,
  tag,
}: {
  /**
   * The hints the picked route sends, and the variant it was picked from — or the one its Back
   * returns to, so a closed prompt or a refusal can re-open it the same way.
   */
  onChoose: (hints: readonly PasskeyHint[], from: SheetVariant) => void
  onCancel?: () => void
  cancelLabel?: string
  reach: PhoneReach
  creation?: LaptopCreation
  /** The variant to open on; default this computer where it may create, else the phone. */
  openOn?: SheetVariant
  /** With `openOn`, the variant its Back returns to. */
  from?: SheetVariant
  /** The sheet re-opens after the browser's prompt closed with nothing made. */
  unfinished?: boolean
  /** What the signup commits to, above both routes: a payment's split. */
  details?: ReactNode
  /** Both routes wait: what they would commit to is not priced yet, or cannot be afforded. */
  disabled?: boolean
  /** The browser has not yet said which variants it allows: the heading and a waiting button only. */
  loading?: boolean
  /** The chosen route is running: the loading layout under this label. */
  busy?: string
  /** Bare tag the passkey is for, shown under the heading. */
  tag?: string
}) {
  const tagPill = tag && (
    <span className="ww-tag-pill ww-tag-pill--sm">
      <strong>@{tag}</strong>
      <span>.zk.money</span>
    </span>
  )
  const localOk = creation.local
  const phoneOk = reach !== "no-hybrid"
  const extension = extensionAnswersPasskeys("create")
  const onePasswordAlone = creation.local && creation.managers.every((m) => m === "1password")
  // A manager this row cannot use kept answering on this computer while an extension answers.
  const refusedOften = creation.local && localRefusalsOverLimit(extension)
  // Where the sheet opens, decided once the browser has answered and kept for the mount, so an
  // extension that appears later moves no sheet the user is looking at. A row with 1Password alone
  // opens on the phone, or the key where no phone can be reached: on a fresh sheet when no
  // extension answers, and whenever refusals are over the limit. A prompt that closed with nothing
  // made was no refusal.
  const opened = useRef<{ variant: SheetVariant; byLimit?: "phone" | "key" }>(undefined)
  if (!loading && opened.current === undefined) {
    const steered =
      onePasswordAlone &&
      !unfinished &&
      (refusedOften ? (openOn ?? "local") === "local" : openOn === undefined && !extension)
    const steeredTo = steered ? (phoneOk ? "phone" : "key") : undefined
    opened.current = {
      variant: steeredTo ?? initialVariant(localOk, phoneOk, openOn),
      ...(steeredTo && refusedOften ? { byLimit: steeredTo } : {}),
    }
  }
  const opening = opened.current?.variant ?? initialVariant(localOk, phoneOk, openOn)
  // The variant shown and where it was reached from, so its Back knows where to go. Unset until
  // the first swap.
  const [nav, setNav] = useState<{ picked: SheetVariant; cameFrom?: SheetVariant }>()
  const { picked, cameFrom } = nav ?? {
    picked: opening,
    cameFrom: from !== openOn ? from : undefined,
  }
  // A pick the probes no longer allow falls back to the key, which every laptop can use.
  const shown: SheetVariant =
    picked === "local" && localOk ? "local" : picked === "phone" && phoneOk ? "phone" : "key"
  const root = useRef<HTMLDivElement>(null)
  // A swap removes the control that had focus: a forward swap gives it to the new variant's primary
  // button, a Back to the control that opened the variant being left.
  const focusNext = useRef<string | undefined>(undefined)
  const opener = useRef<string | undefined>(undefined)
  useEffect(() => {
    const target = focusNext.current
    if (!target) return
    focusNext.current = undefined
    const next =
      target === "primary"
        ? root.current?.querySelector<HTMLElement>(".ww-phone-steps__primary")
        : root.current?.querySelector<HTMLElement>(`[data-testid="${target}"]`)
    next?.focus()
  }, [picked])
  const forward = (to: SheetVariant, via: string) => {
    opener.current = via
    focusNext.current = "primary"
    setNav({ picked: to, cameFrom: picked })
  }
  const back = (to: SheetVariant) => {
    // A variant the sheet opened on had no opener; its destination's primary takes focus instead.
    focusNext.current = opener.current ?? "primary"
    opener.current = undefined
    setNav({ picked: to })
  }

  const classes = "ww-invite-spinner ww-phone-steps ww-phone-steps--create"
  if (loading || busy) {
    return (
      <div ref={root} className={classes} data-testid="phone-steps" data-variant="loading">
        <span className="ww-phone-steps__badge">
          <Icon name="key" size={28} color="#fff" />
        </span>
        <div className="ww-phone-steps__heading">
          <p className="ww-phone-steps__hero-title">{PHONE_STEPS_COPY.local.title}</p>
          {tagPill}
        </div>
        {details}
        <PrimaryGradientButton
          title={busy ?? "Checking this browser…"}
          testId="phone-steps-loading"
          className="ww-phone-steps__primary"
          isLoading
        />
        <SheetFoot onCancel={onCancel} cancelLabel={cancelLabel} />
      </div>
    )
  }

  const windows = currentUserAgentInfoSync().osFamily === "windows"
  // Only on the variant the sheet opened on: the other one did not come first.
  const byLimit = opened.current?.byLimit
  const steeredNote = byLimit && shown === byLimit && (
    <StepsNote testId="phone-steps-steered">{PHONE_STEPS_COPY.local.steered[byLimit]}</StepsNote>
  )
  // The control that leads to this computer on a row with 1Password alone says so.
  const localLabel = onePasswordAlone ? PHONE_STEPS_COPY.local.switchToOnePassword : undefined
  const keyLink = (
    <AltLink
      testId="phone-steps-security-key"
      disabled={disabled}
      onClick={() => forward("key", "phone-steps-security-key")}
    >
      <Icon name="key" size={16} />
      {PHONE_STEPS_COPY.routes[1]!.label}
    </AltLink>
  )

  let body: ReactNode
  if (shown === "local" && creation.local) {
    const copy = stepsCopyFor(reach, creation)
    const [route, ...alts] = copy.routes
    const repeated = repeatedRefusalLineFor(creation)
    const note = extension ? undefined : localNoteFor(creation)
    body = (
      <>
        <div className="ww-phone-steps__heading">
          <p className="ww-phone-steps__hero-title">{copy.title}</p>
          {tagPill}
        </div>
        {details}
        {unfinished && (
          <p
            className="ww-phone-steps__unfinished"
            role="alert"
            data-testid="phone-steps-unfinished"
          >
            {PHONE_STEPS_COPY.local.unfinished}
          </p>
        )}
        {note && <StepsNote testId="phone-steps-pick-manager">{note}</StepsNote>}
        <PrimaryGradientButton
          title={route!.label}
          testId="phone-steps-local"
          className="ww-phone-steps__primary"
          isDisabled={disabled}
          onClick={() => onChoose([route!.hint], "local")}
        />
        {extension && (
          <p className="ww-phone-steps__managers" data-testid="phone-steps-extension">
            {extensionLineFor(creation)}
          </p>
        )}
        {refusedOften && repeated && (
          <p className="ww-phone-steps__managers" data-testid="phone-steps-refused-often">
            {repeated}
          </p>
        )}
        <div className="ww-phone-steps__alts">
          {alts.map((alt) =>
            alt.hint === "hybrid" ? (
              <AltLink
                key={alt.hint}
                testId="phone-steps-phone"
                disabled={disabled}
                onClick={() => forward("phone", "phone-steps-phone")}
              >
                <Icon name="qr-code" size={16} />
                {alt.label}
              </AltLink>
            ) : (
              <AltLink
                key={alt.hint}
                testId="phone-steps-security-key"
                disabled={disabled}
                onClick={() => forward("key", "phone-steps-security-key")}
              >
                <Icon name="key" size={16} />
                {alt.label}
              </AltLink>
            ),
          )}
        </div>
        <Facts supported={supportedFor(creation)} />
      </>
    )
  } else if (shown === "phone") {
    const copy = PHONE_STEPS_COPY
    const [route] = copy.routes
    body = (
      <>
        <div className="ww-phone-steps__heading">
          <p className="ww-phone-steps__hero-title">{copy.title}</p>
          {tagPill}
        </div>
        {steeredNote}
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
              onClick={() =>
                onChoose([route!.hint], cameFrom === "local" && localOk ? "local" : "phone")
              }
            >
              <span className="ww-phone-steps__pill">{route!.label}</span>
            </button>
          </div>
          {windows && <StepsNote testId="phone-steps-windows">{PHONE_HELP_COPY.windows}</StepsNote>}
        </div>
        <div className="ww-phone-steps__alts">
          {keyLink}
          {cameFrom === "local" && localOk && localLabel ? (
            <AltLink testId="phone-steps-back" disabled={disabled} onClick={() => back("local")}>
              <Icon name="fingerprint" size={16} />
              {localLabel}
            </AltLink>
          ) : (
            localOk && (
              <AltLink
                testId="phone-steps-switch-local"
                disabled={disabled}
                onClick={() =>
                  cameFrom === "local"
                    ? back("local")
                    : forward("local", "phone-steps-switch-local")
                }
              >
                <Icon name="fingerprint" size={16} />
                {localLabel ?? copy.local.switchToLocal}
              </AltLink>
            )
          )}
        </div>
        {cameFrom === "local" && localOk && !localLabel && (
          <BackArrow disabled={disabled} onClick={() => back("local")} />
        )}
        <Facts supported={supportedFor()} chromeTip={creation.chromeTip || undefined} />
      </>
    )
  } else {
    const copy = PHONE_STEPS_COPY.noPhone
    const [route] = copy.routes
    // The way back: where this variant came from while that is still allowed, else this computer,
    // else the phone where it can be reached. A retry carries the key itself as the origin.
    const backTo =
      cameFrom === "local" && localOk
        ? "local"
        : cameFrom === "phone" && phoneOk
        ? "phone"
        : localOk
        ? "local"
        : phoneOk
        ? "phone"
        : undefined
    body = (
      <>
        <div className="ww-phone-steps__heading">
          <p className="ww-phone-steps__hero-title">{copy.title}</p>
          {tagPill}
        </div>
        {extension && (
          <StepsNote testId="phone-steps-extension">{PHONE_STEPS_COPY.extension}</StepsNote>
        )}
        {steeredNote}
        {details}
        <PrimaryGradientButton
          title={route!.label}
          testId="phone-steps-continue"
          className="ww-phone-steps__primary"
          isDisabled={disabled}
          onClick={() => onChoose([route!.hint], backTo ?? "key")}
        />
        {(phoneOk || localOk) && (
          <div className="ww-phone-steps__alts">
            {phoneOk && (
              <AltLink
                testId="phone-steps-phone"
                disabled={disabled}
                onClick={() =>
                  backTo === "phone" ? back("phone") : forward("phone", "phone-steps-phone")
                }
              >
                <Icon name="qr-code" size={16} />
                {copy.back}
              </AltLink>
            )}
            {localOk && (
              <AltLink
                testId="phone-steps-switch-local"
                disabled={disabled}
                onClick={() =>
                  backTo === "local" ? back("local") : forward("local", "phone-steps-switch-local")
                }
              >
                <Icon name="fingerprint" size={16} />
                {localLabel ?? PHONE_STEPS_COPY.local.switchToLocal}
              </AltLink>
            )}
          </div>
        )}
        <Warning tone="info" role="note" title={copy.detailsLabel}>
          <p>{copy.note}</p>
          <p>{copy.models}</p>
        </Warning>
        {backTo && <BackArrow disabled={disabled} onClick={() => back(backTo)} />}
      </>
    )
  }
  return (
    <div ref={root} className={classes} data-testid="phone-steps" data-variant={shown}>
      <span className="ww-phone-steps__badge">
        <Icon name="key" size={28} color="#fff" />
      </span>
      {body}
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
}: {
  state: Extract<GateState, { kind: "awaiting-action" }>
  onCancel?: () => void
  cancelLabel?: string
  /** A creation's payment split, shown on its sheet. */
  details?: ReactNode
  /** Bare tag the passkey is for. */
  tag?: string
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
  // answering there; this computer's route names no key, so the managers can answer.
  return (
    <PhoneSteps
      onChoose={(hints, from) => state.proceed(routeForHints(hints), from)}
      onCancel={onCancel}
      cancelLabel={cancelLabel}
      reach={state.reach}
      creation={state.creation}
      openOn={state.openOn}
      from={state.from}
      unfinished={state.unfinished}
      details={details}
      tag={tag}
    />
  )
}
