import { useState, type ReactNode } from "react"
import { GradientText, PrimaryGradientButton } from "@obsidion/web-ds"
import flowCopy from "../flow.copy"
import flowStyles from "../flow.module.css"
import { decimalInput } from "../../format"
import { TransferWidget, type TransferAsset } from "../../TransferWidget/TransferWidget"
import { WalletPill } from "../WalletPill/WalletPill"
import copy from "./AmountStep.copy"
import styles from "./AmountStep.module.css"

/**
 * The note under To: nothing before an amount, a dash before any fee, the last fee faded while the
 * next is quoted, or why no fee came.
 */
export type FeeNote = "none" | "unknown" | { figure: string; stale?: boolean } | { error: string }

interface AmountField {
  who: string
  onPickWho?: () => void
  whoTestId?: string
  value: string
  /** Unset, the field is read-only. */
  onChange?: (text: string) => void
  /** Replaces the field's default accessible name. */
  ariaLabel?: string
  inputTestId?: string
  testId?: string
  asset: TransferAsset
}

export interface AmountStepProps {
  title: string
  /** The wallet the move runs through, under the title. */
  pill?: { name: string; address: string }
  /** Under the title when there is no pill. */
  subtitle?: string
  send: AmountField & {
    /** Read while `loading`. */
    balance?: { figure: string; loading?: boolean }
    /** In place of the balance, such as what a fixed amount sends. */
    note?: string
    max?: { onClick: () => void; disabled?: boolean }
  }
  receive: AmountField & {
    /** The figure follows from a typed From and may differ from what lands. */
    approx?: boolean
    fee: FeeNote
    feeTestId?: string
  }
  /** Shown as soon as they apply. */
  errors?: readonly string[]
  /** Why the button is off, shown once it is pressed, until the amounts change. */
  disabledHint?: string
  /** Route notices under the fields. */
  notices?: ReactNode
  button: {
    title: string
    disabled?: boolean
    loading?: boolean
    onClick: () => void
    testId?: string
  }
}

/** The step every move sizes its amount on: deposits from a wallet and withdrawals. */
export function AmountStep({
  title,
  pill,
  subtitle,
  send,
  receive,
  errors = [],
  disabledHint,
  notices,
  button,
}: AmountStepProps) {
  // The amounts the disabled button was pressed at.
  const typed = `${send.value}|${receive.value}`
  const [pressedAt, setPressedAt] = useState<string>()
  const input = (field: AmountField, label: string, autoFocus = false) => (
    <input
      data-autofocus={autoFocus || undefined}
      inputMode="decimal"
      placeholder="0"
      aria-label={field.ariaLabel ?? label}
      data-testid={field.inputTestId}
      readOnly={!field.onChange}
      value={field.value}
      onChange={(e) => field.onChange?.(decimalInput(e.target.value.trim()))}
    />
  )
  const { fee } = receive
  // A fee still being quoted shimmers like a balance still being read.
  const feeLine = (figure: string, loading: boolean) => (
    <span data-testid={receive.feeTestId}>
      {flowCopy.fee}{" "}
      <span className="ww-available" aria-busy={loading || undefined}>
        {figure}
      </span>
    </span>
  )
  const feeNote =
    fee === "none"
      ? undefined
      : fee === "unknown"
      ? feeLine(flowCopy.feeZero, true)
      : "error" in fee
      ? fee.error
      : feeLine(fee.figure, !!fee.stale)
  const sendNote =
    send.note ??
    (send.balance && (
      <>
        {copy.balance}{" "}
        <span className="ww-available" aria-busy={send.balance.loading || undefined}>
          {send.balance.figure}
        </span>
      </>
    ))
  return (
    <>
      <div className="ww-deposit-sheet__head ww-deposit-sheet__head--tight">
        <GradientText size={24} weight={700} className={flowStyles.headTitle}>
          {title}
        </GradientText>
        {pill ? (
          <WalletPill wallet={pill.name} address={pill.address} />
        ) : (
          subtitle && <p className="ww-deposit-sheet__sub--sm">{subtitle}</p>
        )}
      </div>
      <div className="ww-fund__fields">
        <TransferWidget
          from={{
            label: copy.from,
            who: send.who,
            onPickWho: send.onPickWho,
            whoTestId: send.whoTestId,
            testId: send.testId,
            amount: input(send, copy.sendAmount, true),
            note: (sendNote || send.max) && (
              <>
                {sendNote}
                {send.max && (
                  <button
                    type="button"
                    className="zkm-btn-reset ww-pay__max"
                    data-testid="amount-max"
                    disabled={send.max.disabled}
                    onClick={send.max.onClick}
                  >
                    {copy.max}
                  </button>
                )}
              </>
            ),
            asset: send.asset,
          }}
          to={{
            label: copy.to,
            who: receive.who,
            onPickWho: receive.onPickWho,
            whoTestId: receive.whoTestId,
            testId: receive.testId,
            approx: receive.approx,
            amount: input(receive, copy.receiveAmount),
            note: feeNote,
            asset: receive.asset,
          }}
        />
        {errors.map((error) => (
          <span key={error} className="ww-pay__error">
            {error}
          </span>
        ))}
        {notices}
      </div>
      {disabledHint && pressedAt === typed && <span className="ww-pay__error">{disabledHint}</span>}
      {/* A disabled button takes no clicks, so the wrapper hears one. */}
      <span className={styles.cta} onClick={() => button.disabled && setPressedAt(typed)}>
        <PrimaryGradientButton
          title={button.title}
          testId={button.testId}
          isDisabled={button.disabled}
          isLoading={button.loading}
          onClick={button.onClick}
          className="ww-deposit-sheet__cta"
        />
      </span>
    </>
  )
}
