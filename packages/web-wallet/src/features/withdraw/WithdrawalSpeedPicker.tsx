import { useId, useRef, useState } from "react"
import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { Icon } from "@obsidion/web-ds"
import { tokenAmount } from "../../ui/format"
import type { FasterWithdrawal } from "./useFasterWithdrawal"
import { usePickerDismiss } from "./WithdrawalAssetPicker"

export type WithdrawalSpeed = "standard" | "faster"

export const FASTER_WITHDRAWAL_SETTLED_NOTE = "Already as fast as it can be, so no tip is needed."

export function etaLabel(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `About ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `About ${hours} h ${rest} min` : `About ${hours} h`
}

export const FASTER_WITHDRAWAL_CHECKING = "Checking…"

/** The Speed row while the first Faster quote is worked out. */
export function WithdrawalSpeedChecking() {
  return (
    <div className="ww-deposit__fact" aria-busy="true">
      <span>Speed</span>
      <span className="ww-deposit__pill ww-deposit__pill--label ww-deposit__pill--pending">
        {FASTER_WITHDRAWAL_CHECKING}
      </span>
    </div>
  )
}

/** Standard (no tip) or Faster (a prover tip), each with its ETA. */
export function WithdrawalSpeedPicker({
  value,
  onChange,
  faster,
  settled,
  fasterBlocked,
}: {
  value: WithdrawalSpeed
  onChange: (speed: WithdrawalSpeed) => void
  faster: FasterWithdrawal
  /** No tip would help: Faster shows as chosen and the choice is closed. */
  settled?: boolean
  /** Why Faster cannot be chosen now; it is listed but disabled. */
  fasterBlocked?: string
}) {
  const [open, setOpen] = useState(false)
  const labelId = useId()
  const listboxId = useId()
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tip = `${tokenAmount(formatUnits(faster.proverTip, DEFAULT_DECIMALS))} DAI`
  // Both ETAs run from the burn's landing: the confirmation ahead of it is this device's proving.
  const options: { id: WithdrawalSpeed; name: string; detail: string; disabled?: boolean }[] = [
    {
      id: "standard",
      name: "Standard",
      detail: `${etaLabel(faster.standardEtaSeconds)} once confirmed`,
    },
    {
      id: "faster",
      name: "Faster",
      detail: fasterBlocked ?? `${etaLabel(faster.tippedEtaSeconds)} once confirmed · ${tip}`,
      disabled: fasterBlocked !== undefined,
    },
  ]
  const selected = options.find((o) => o.id === (settled ? "faster" : value)) ?? options[0]

  usePickerDismiss(open, setOpen, anchorRef, triggerRef)

  return (
    <>
      <div className="ww-deposit__fact" ref={anchorRef}>
        <span id={labelId}>Speed</span>
        <button
          ref={triggerRef}
          type="button"
          className="zkm-btn-reset ww-deposit__pill ww-deposit__pill--label"
          aria-labelledby={labelId}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          disabled={settled}
          onClick={() => setOpen((current) => !current)}
        >
          {selected.name}
          {!settled && <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />}
        </button>
        {open && !settled && (
          <div
            id={listboxId}
            className="ww-deposit__picker"
            role="listbox"
            aria-labelledby={labelId}
          >
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
      {settled && <small className="ww-withdraw__fee-note">{FASTER_WITHDRAWAL_SETTLED_NOTE}</small>}
    </>
  )
}
