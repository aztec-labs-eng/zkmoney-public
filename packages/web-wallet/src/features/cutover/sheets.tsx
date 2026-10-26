/**
 * The upgrade's sheets: Move your funds (Figma 388:30582), the working beat (409:36603, 409:36710),
 * Leave upgrade? (389:31506) and the error (409:37782).
 */
import { DestructiveActionButton, GradientSpinner, PrimaryGradientButton } from "@obsidion/web-ds"
import stopBadge from "../../assets/cutover/stop-badge.png"
import { errorCopy, leaveCopy, moveFundsCopy, upgradingCopy, workingCopy } from "./cutoverCopy"
import {
  Badge,
  Banner,
  CutoverSheet,
  DetailsCard,
  Lead,
  SheetTitle,
  TextButton,
  WhatHappensNext,
} from "./parts"

export interface MoveFigures {
  total: string
  spendable: string
  savings: string
}

/** 2 · Sign: what the upgrade moves, and the passkey that starts it. */
export function MoveFundsSheet({
  figures,
  approvals,
  disabled,
  onConfirm,
  onClose,
}: {
  /** Absent when the upgrade moves no funds and only updates the account. */
  figures?: MoveFigures
  /** Passkey confirmations still to give. */
  approvals: number
  disabled?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const { title, body } = figures ? moveFundsCopy : moveFundsCopy.update
  return (
    <CutoverSheet label={title} testId="cutover-move-funds" onClose={onClose}>
      <Badge icon="key" />
      <SheetTitle>{title}</SheetTitle>
      <Lead>{body}</Lead>
      {figures && (
        <DetailsCard
          header={{ label: moveFundsCopy.moving, value: figures.total }}
          rows={[
            { label: "Spendable", value: figures.spendable },
            { label: "Savings", value: figures.savings },
          ]}
        />
      )}
      <WhatHappensNext
        title={moveFundsCopy.next}
        eyebrow={moveFundsCopy.nextEyebrow}
        steps={moveFundsCopy.steps(approvals)}
      />
      <PrimaryGradientButton
        title={approvals > 0 ? moveFundsCopy.button : moveFundsCopy.start}
        isDisabled={disabled}
        testId="cutover-confirm-upgrade"
        onClick={onConfirm}
      />
    </CutoverSheet>
  )
}

/**
 * The beat over a proving run. The browser opens a passkey prompt only from a tap, so a run that
 * waits for its next approval shows "Use passkey".
 */
export function WorkingSheet({
  ask,
  signing,
  onSign,
  onCancel,
}: {
  /** The approval the run waits to be tapped for. */
  ask?: { number: number; total: number } | null
  /** The browser's passkey prompt is open. */
  signing?: boolean
  onSign: () => void
  onCancel: () => void
}) {
  const stage = ask
    ? workingCopy.ask(ask.number, ask.total)
    : signing
    ? workingCopy.signing
    : workingCopy.preparing
  return (
    <CutoverSheet label={stage} role="alertdialog" testId="cutover-working">
      <div className="ww-cutover__working" aria-live="polite">
        {ask ? <Badge icon="key" /> : <GradientSpinner size={48} />}
        <span className="ww-cutover__working-stage">{stage}</span>
        <Banner
          tone="warn"
          title={upgradingCopy.keepOpen.title}
          body={upgradingCopy.keepOpen.body}
        />
        {ask && (
          <PrimaryGradientButton
            title={workingCopy.usePasskey}
            testId="cutover-use-passkey"
            onClick={onSign}
          />
        )}
        <PrimaryGradientButton
          title={workingCopy.cancel}
          buttonStyle="dark"
          isDisabled={signing}
          testId="cutover-cancel"
          onClick={onCancel}
        />
      </div>
    </CutoverSheet>
  )
}

/** Leave upgrade?: the safe choice first, the stop under it. */
export function LeaveSheet({
  sending,
  onStay,
  onStop,
}: {
  /** Every proof is done, so a stop pauses the run. */
  sending?: boolean
  onStay: () => void
  onStop: () => void
}) {
  return (
    <CutoverSheet
      label={leaveCopy.title}
      role="alertdialog"
      testId="cutover-leave"
      onClose={onStay}
    >
      <span className="ww-cutover__hero" aria-hidden>
        <img src={stopBadge} alt="" />
      </span>
      <SheetTitle>{leaveCopy.title}</SheetTitle>
      <Lead>{sending ? leaveCopy.sendingBody : leaveCopy.body}</Lead>
      <div className="ww-cutover__actions">
        <PrimaryGradientButton title={leaveCopy.stay} testId="cutover-stay" onClick={onStay} />
        <DestructiveActionButton title={leaveCopy.stop} icon="x-circle" onClick={onStop} />
      </div>
    </CutoverSheet>
  )
}

/** S3: what stopped the upgrade, with Retry and support. */
export function ErrorSheet({
  what,
  reference,
  onRetry,
  onSupport,
  onClose,
}: {
  what: string
  /** The run's id, for support. */
  reference: string
  onRetry: () => void
  onSupport: () => void
  onClose: () => void
}) {
  const rows = [
    [errorCopy.what, what],
    [errorCopy.reference, reference],
  ] as const
  return (
    <CutoverSheet
      label={errorCopy.title}
      role="alertdialog"
      testId="cutover-error"
      onClose={onClose}
    >
      <Badge icon="alert-triangle" tone="error" />
      <SheetTitle>{errorCopy.title}</SheetTitle>
      <Lead>{errorCopy.body}</Lead>
      <div className="ww-cutover__card ww-cutover__summary">
        {rows.map(([label, value]) => (
          <div key={label} className="ww-cutover__row">
            <span>{label}</span>
            <span className="ww-cutover__row-value">{value}</span>
          </div>
        ))}
      </div>
      <div className="ww-cutover__actions">
        <PrimaryGradientButton title={errorCopy.retry} testId="cutover-retry" onClick={onRetry} />
        <TextButton onClick={onSupport}>{errorCopy.support}</TextButton>
      </div>
    </CutoverSheet>
  )
}
