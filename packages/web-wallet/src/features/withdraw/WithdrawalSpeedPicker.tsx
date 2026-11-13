import { useId, useRef, useState } from "react"
import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { Icon } from "@obsidion/web-ds"
import { fmt } from "../../lib/fmt"
import { tokenAmount } from "../../ui/format"
import type { FasterWithdrawal } from "./useFasterWithdrawal"
import { usePickerDismiss } from "../../ui/usePickerDismiss"
import copy from "./WithdrawalSpeedPicker.copy"

export type WithdrawalSpeed = "standard" | "faster"

export function etaLabel(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `About ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `About ${hours} h ${rest} min` : `About ${hours} h`
}

/** The Speed row while the first Faster quote is worked out. */
export function WithdrawalSpeedChecking() {
  return (
    <div className="ww-deposit__fact" aria-busy="true">
      <span>{copy.speed}</span>
      <span className="ww-deposit__pill ww-deposit__pill--label ww-deposit__pill--pending">
        {copy.checking}
      </span>
    </div>
  )
}

/** The checking pill alone, as a fact's value where the row is drawn around it. */
export function SpeedCheckingPill() {
  return (
    <span
      className="ww-deposit__pill ww-deposit__pill--label ww-deposit__pill--pending"
      aria-busy="true"
    >
      {copy.checking}
    </span>
  )
}

interface SpeedChoiceProps {
  value: WithdrawalSpeed
  onChange: (speed: WithdrawalSpeed) => void
  faster: FasterWithdrawal
  /** No tip would help: Faster shows as chosen and the choice is closed. */
  settled?: boolean
  /** Why Faster cannot be chosen now; it is listed but disabled. */
  fasterBlocked?: string
  /** The choice is frozen, as while the burn it priced goes out. */
  disabled?: boolean
  /** Seconds the trip takes after the release, such as a bridge's leg; both ETAs add them. */
  afterSeconds?: number
}

/** Standard (no tip) or Faster (a prover tip), each with its ETA. */
export function WithdrawalSpeedPicker(props: SpeedChoiceProps) {
  const labelId = useId()
  return (
    <>
      <div className="ww-deposit__fact">
        <span id={labelId}>{copy.speed}</span>
        <SpeedChoicePill {...props} labelId={labelId} />
      </div>
      {props.settled && <small className="ww-withdraw__fee-note">{copy.settledNote}</small>}
    </>
  )
}

/** The choice's pill and the list it opens, named by the row's `labelId` or by `label` alone. */
export function SpeedChoicePill({
  value,
  onChange,
  faster,
  settled,
  fasterBlocked,
  disabled,
  afterSeconds = 0,
  labelId,
  label,
}: SpeedChoiceProps & { labelId?: string; label?: string }) {
  const [open, setOpen] = useState(false)
  const listboxId = useId()
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tip = `${tokenAmount(formatUnits(faster.proverTip, DEFAULT_DECIMALS))} DAI`
  // Both ETAs run from the burn's landing: the confirmation ahead of it is this device's proving.
  const options: { id: WithdrawalSpeed; name: string; detail: string; disabled?: boolean }[] = [
    {
      id: "standard",
      name: copy.standard,
      detail: fmt(copy.eta, { eta: etaLabel(faster.standardEtaSeconds + afterSeconds) }),
    },
    {
      id: "faster",
      name: copy.faster,
      detail:
        fasterBlocked ??
        fmt(copy.fasterDetail, { eta: etaLabel(faster.tippedEtaSeconds + afterSeconds), tip }),
      disabled: fasterBlocked !== undefined,
    },
  ]
  const selected = options.find((o) => o.id === (settled ? "faster" : value)) ?? options[0]
  const named = labelId ? { "aria-labelledby": labelId } : { "aria-label": label }

  usePickerDismiss(open, setOpen, anchorRef, triggerRef)

  return (
    <div className="ww-speed-choice" ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className="zkm-btn-reset ww-deposit__pill ww-deposit__pill--label"
        {...named}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={settled || disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {selected.name}
        {!settled && <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />}
      </button>
      {open && !settled && !disabled && (
        <div id={listboxId} className="ww-deposit__picker" role="listbox" {...named}>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              className="zkm-btn-reset ww-deposit__picker-row"
              aria-selected={option.id === value}
              disabled={option.disabled}
              onClick={() => {
                onChange(option.id)
                setOpen(false)
                triggerRef.current?.focus()
              }}
            >
              <span>
                <b>{option.name}</b>
                <small>{option.detail}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
