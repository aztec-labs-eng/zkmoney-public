/**
 * The chrome every cutover screen shares (Figma "Migration" page): the page frame with its top bar,
 * the sheet, and the cards, pills, banners, ring and stepper the screens compose. Presentational
 * only: nothing here reads the wallet.
 */
import { useRef, useState, type ReactNode } from "react"
import {
  GradientSpinner,
  GradientText,
  Icon,
  ProgressSpinner,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { BrandLockup } from "../../ui/BrandLockup"
import { LogoutBlockedModal } from "../../ui/LogoutBlockedModal"
import { LogoutModal } from "../../ui/LogoutModal"
import { Modal } from "../../ui/Modal"
import { TipRow } from "../../ui/TipRow"
import { BalanceSkeleton, TextSkeleton } from "../../ui/Skeletons"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { usePickerDismiss } from "../../ui/usePickerDismiss"
import "./cutover.css"

/** What the pill's menu signs out with: held behind its own ask while a registration lands. */
export interface CutoverLogout {
  blocked: () => boolean
  run: () => Promise<void>
}

export interface CutoverAccount {
  /** The tag without its "@". */
  tag: string
  /** With one, the pill opens the menu with Logout. */
  logout?: CutoverLogout
}

function PillBody({ account, phone }: { account: CutoverAccount; phone: boolean }) {
  return (
    <>
      <span className="ww-cutover__avatar" aria-hidden>
        {phone ? account.tag.replace(/^@/, "")[0]?.toUpperCase() : <Icon name="person" size={20} />}
      </span>
      <span className="ww-cutover__tag">
        <b>{account.tag}</b>
        <span>.zk.money</span>
      </span>
    </>
  )
}

/**
 * The tag pill at the top right: the initial on phones, a person on desktop (Figma 375:29151).
 * With a logout it opens the menu under it (489:38560), whose Logout asks first.
 */
export function AccountPill({ account, phone }: { account: CutoverAccount; phone: boolean }) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState<null | "confirm" | "blocked">(null)
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  usePickerDismiss(open, setOpen, anchor, trigger)
  const logout = account.logout
  if (!logout) {
    return (
      <span className="ww-cutover__account" data-testid="cutover-account">
        <PillBody account={account} phone={phone} />
      </span>
    )
  }
  const ask = () => {
    setOpen(false)
    setPrompt(logout.blocked() ? "blocked" : "confirm")
  }
  const run = () => void logout.run()
  return (
    <div className="ww-cutover__account-anchor" ref={anchor}>
      <button
        ref={trigger}
        type="button"
        className="zkm-btn-reset ww-cutover__account"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="cutover-account"
        onClick={() => setOpen(!open)}
      >
        <PillBody account={account} phone={phone} />
        <Icon name="chevron-down" size={16} className="ww-cutover__account-chevron" />
      </button>
      {open && (
        <div className="ww-cutover__menu" role="menu" aria-label="Account">
          <button
            type="button"
            role="menuitem"
            className="zkm-btn-reset ww-cutover__menu-item"
            data-testid="cutover-logout"
            onClick={ask}
          >
            <Icon name="logout" size={20} />
            Logout
          </button>
        </div>
      )}
      {prompt === "blocked" && (
        <LogoutBlockedModal onClose={() => setPrompt(null)} onConfirm={run} />
      )}
      {prompt === "confirm" && <LogoutModal onClose={() => setPrompt(null)} onConfirm={run} />}
    </div>
  )
}

/**
 * A full page: top bar, a centered column and, on phones, a footer docked over the bottom edge.
 * `center` keeps the column in the middle of the viewport, as the Done pages are.
 */
export function CutoverPage({
  account,
  onBack,
  footer,
  center,
  testId,
  children,
}: {
  /** None for a visitor without an account. */
  account?: CutoverAccount
  onBack?: () => void
  footer?: ReactNode
  center?: boolean
  testId?: string
  children: ReactNode
}) {
  const phone = usePhoneLayout()
  return (
    <div className="ww-cutover" data-phone={phone || undefined} data-testid={testId}>
      <header className="ww-cutover__bar">
        {onBack && phone ? (
          <TopNavIconButton icon="chevron-left" ariaLabel="Back" onClick={onBack} />
        ) : (
          <BrandLockup />
        )}
        {account && <AccountPill account={account} phone={phone} />}
      </header>
      <main className="ww-cutover__column" data-center={center || undefined}>
        {onBack && !phone && (
          <span className="ww-cutover__back">
            <TopNavIconButton icon="chevron-left" ariaLabel="Back" onClick={onBack} />
          </span>
        )}
        {children}
      </main>
      {footer && <footer className="ww-cutover__footer">{footer}</footer>}
    </div>
  )
}

/** A sheet docked to the bottom on phones and centered on desktop (Figma 375:29315, 409:33478). */
export function CutoverSheet({
  label,
  onClose,
  role,
  testId,
  className,
  children,
}: {
  label: string
  onClose?: () => void
  role?: "dialog" | "alertdialog"
  testId?: string
  className?: string
  children: ReactNode
}) {
  return (
    <Modal
      variant="bare"
      label={label}
      role={role}
      className={["ww-modal--create ww-cutover-sheet", className].filter(Boolean).join(" ")}
      onClose={onClose}
    >
      <div className="ww-cutover-sheet__body" data-testid={testId}>
        {onClose && (
          <div className="ww-modal__close">
            <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
          </div>
        )}
        {children}
      </div>
    </Modal>
  )
}

/** The gradient disc with a glyph that opens most screens and sheets. */
export function Badge({
  icon,
  size = 64,
  tone,
}: {
  icon: string
  size?: 64 | 80
  tone?: "warn" | "error"
}) {
  return (
    <span className="ww-cutover__badge" data-size={size} data-tone={tone} aria-hidden>
      <Icon name={icon} size={size / 2} />
    </span>
  )
}

export function Title({ children, size }: { children: string; size?: "lg" }) {
  return (
    <h1 className="ww-cutover__title" data-size={size}>
      {children}
    </h1>
  )
}

export function Lead({ children }: { children: ReactNode }) {
  return <p className="ww-cutover__lead">{children}</p>
}

export function Eyebrow({ children }: { children: string }) {
  return <span className="ww-cutover__eyebrow">{children}</span>
}

/** Dollars split as the card sets them: the cents smaller and dimmer. */
export function BigAmount({ value }: { value: string }) {
  const dot = value.lastIndexOf(".")
  if (dot < 0) return <span className="ww-cutover__amount">{value}</span>
  return (
    <span className="ww-cutover__amount">
      {value.slice(0, dot)}
      <small>{value.slice(dot)}</small>
    </span>
  )
}

/** One text line tall, so the card keeps its height when the figure lands. */
function HalfSkeleton() {
  return (
    <span className="ww-cutover__half-loading">
      <TextSkeleton width={72} />
    </span>
  )
}

/** The balance card: a total over its Spendable and Savings halves (Figma 375:29185). */
export function BalanceCard({
  label,
  total,
  spendable,
  savings,
  note,
  noteAction,
  stamp,
}: {
  label: string
  /** Each figure loads while undefined. */
  total?: string
  spendable?: string
  savings?: string
  /** The info strip under the halves. */
  note?: string
  /** A link at the end of the note (Figma 489:38760). */
  noteAction?: { label: string; onClick: () => void; testId?: string }
  /** The rotated pill on the top-right corner. */
  stamp?: string
}) {
  return (
    <div className="ww-cutover__card ww-cutover__balance" data-testid="cutover-balance">
      {stamp && <span className="ww-cutover__stamp">{stamp}</span>}
      <div className="ww-cutover__balance-total">
        <span className="ww-cutover__caption">{label}</span>
        {total === undefined ? <BalanceSkeleton height={39} /> : <BigAmount value={total} />}
      </div>
      <div className="ww-cutover__balance-split">
        <div>
          <span className="ww-cutover__caption">Spendable</span>
          {spendable === undefined ? <HalfSkeleton /> : <b>{spendable}</b>}
        </div>
        <div>
          <span className="ww-cutover__caption">Savings</span>
          {savings === undefined ? <HalfSkeleton /> : <b>{savings}</b>}
        </div>
      </div>
      {note && (
        <div className="ww-cutover__note">
          <Icon name="info-circle" size={16} />
          <span>
            {note}
            {noteAction && (
              <>
                {" "}
                <button
                  type="button"
                  className="zkm-btn-reset ww-cutover__note-link"
                  data-testid={noteAction.testId}
                  onClick={noteAction.onClick}
                >
                  {noteAction.label}
                </button>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

export interface DetailRow {
  label: string
  value: string
  /** A second line under the value. */
  note?: string
}

/** A rows card; `header` is the bold total row above a divider (Figma 388:30582). */
export function DetailsCard({ header, rows }: { header?: DetailRow; rows: DetailRow[] }) {
  return (
    <div className="ww-cutover__card ww-cutover__details">
      {header && (
        <div className="ww-cutover__row ww-cutover__row--head">
          <span>{header.label}</span>
          <b>{header.value}</b>
        </div>
      )}
      {rows.map((row) => (
        <div key={row.label} className="ww-cutover__row">
          <span>{row.label}</span>
          <span className="ww-cutover__row-value">
            {row.value}
            {row.note && <small>{row.note}</small>}
          </span>
        </div>
      ))}
    </div>
  )
}

/** The green feature pills (Figma 350:23847). */
export function Pills({ items }: { items: { icon: string; label: string }[] }) {
  return (
    <ul className="ww-cutover__pills">
      {items.map((item) => (
        <li key={item.label}>
          <Icon name={item.icon} size={14} />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

/** The gold "keep open" and green "safe to close" banners (Figma 389:31558). */
export function Banner({
  tone,
  title,
  body,
}: {
  tone: "warn" | "ok"
  title: string
  body: string
}) {
  return (
    <div
      className="ww-cutover__banner"
      data-tone={tone}
      role={tone === "warn" ? "alert" : "status"}
    >
      <Icon name="alert-triangle" size={22} />
      <span>
        <b>{title}</b>
        <span>{body}</span>
      </span>
    </div>
  )
}

/** The progress ring with its figure and caption (Figma 389:31548). */
export function ProgressRing({
  percent,
  caption,
  tip,
  spin,
}: {
  percent: number
  caption?: string
  /** Under the figure, behind an info mark: what the wait usually takes (Figma 409:34205). */
  tip?: string
  /** The arc turns, as a spinner, while it still shows the share done. */
  spin?: boolean
}) {
  return (
    <div className="ww-cutover__ring" data-testid="cutover-progress" data-spin={spin || undefined}>
      <ProgressSpinner
        progress={percent / 100}
        size={180}
        thickness={9}
        cap="butt"
        gradient
        color="rgba(255,255,255,0.32)"
      />
      <span className="ww-cutover__ring-label">
        <b>{Math.round(percent)}%</b>
        {caption && <small>{caption}</small>}
        {tip && (
          <TipRow
            className="ww-cutover__ring-tip"
            testId="cutover-ring-tip"
            mark={<Icon name="info-circle" size={16} />}
            label=""
          >
            {tip}
          </TipRow>
        )}
      </span>
    </div>
  )
}

export type StepState = "done" | "active" | "pending"

export interface Step {
  title: string
  /** The line under the title; purple while active, pink when it failed. */
  status?: string
  state: StepState
  failed?: boolean
}

/** The steps card with its rail (Figma 389:31563). */
export function Stepper({ header, steps }: { header?: DetailRow; steps: Step[] }) {
  return (
    <div className="ww-cutover__card ww-cutover__steps" data-testid="cutover-steps">
      {header && (
        <div className="ww-cutover__row ww-cutover__row--head ww-cutover__steps-head">
          <span>{header.label}</span>
          <b>{header.value}</b>
        </div>
      )}
      <ol>
        {steps.map((step, i) => (
          <li key={step.title} className="ww-cutover__step" data-state={step.state}>
            <span className="ww-cutover__rail">
              {step.state === "done" ? (
                <Icon name="check-circle" size={24} />
              ) : step.state === "active" ? (
                <GradientSpinner size={24} />
              ) : (
                <span className="ww-cutover__dot" />
              )}
              {i < steps.length - 1 && <span className="ww-cutover__line" />}
            </span>
            <span className="ww-cutover__step-text">
              <b>{step.title}</b>
              {step.status && <small data-failed={step.failed || undefined}>{step.status}</small>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * The numbered steps of a sheet: an always-open eyebrow card on desktop, a collapsible one closed
 * by default on phones (Figma 388:30582, 409:33997). Its state is not remembered.
 */
export function WhatHappensNext({
  title,
  eyebrow,
  steps,
}: {
  title: string
  eyebrow: string
  steps: readonly (readonly [string, string])[]
}) {
  const phone = usePhoneLayout()
  const [open, setOpen] = useState(false)
  const list = (
    <ol className="ww-cutover__next-steps">
      {steps.map(([label, caption], i) => (
        <li key={label}>
          <span className="ww-cutover__next-num" aria-hidden>
            {i + 1}
          </span>
          <span>
            <b>{label}</b>
            <small>{caption}</small>
          </span>
        </li>
      ))}
    </ol>
  )
  if (!phone) {
    return (
      <div className="ww-cutover__card ww-cutover__next">
        <Eyebrow>{eyebrow}</Eyebrow>
        {list}
      </div>
    )
  }
  return (
    <div
      className="ww-cutover__card ww-cutover__next ww-cutover__next--collapsible"
      data-open={open || undefined}
    >
      <button
        type="button"
        className="zkm-btn-reset ww-cutover__next-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {title}
        <Icon name="chevron-down" size={16} />
      </button>
      {open && list}
    </div>
  )
}

/** The quiet text action under a primary button. */
export function TextButton({
  children,
  onClick,
  disabled,
  testId,
}: {
  children: string
  onClick: () => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      className="zkm-btn-reset ww-cutover__text-btn"
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** A green-check fact line (Figma 401:1947 list, 400:1940 facts). */
export function Fact({ children }: { children: string }) {
  return (
    <span className="ww-cutover__fact">
      <Icon name="check-circle" size={18} />
      {children}
    </span>
  )
}

/** The sheet's gradient title (Figma 375:29315). */
export function SheetTitle({ children }: { children: string }) {
  return (
    <GradientText gradient="title" size={24} weight={700} className="ww-cutover-sheet__title">
      {children}
    </GradientText>
  )
}
