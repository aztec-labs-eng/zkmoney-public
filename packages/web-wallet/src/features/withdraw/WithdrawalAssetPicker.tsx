import { useId, useRef, useState } from "react"
import { Icon } from "@obsidion/web-ds"
import { usePickerDismiss } from "../../ui/usePickerDismiss"
import { useOxideTuple } from "./useOxideTuple"
import {
  withdrawalReceiveAsset,
  withdrawalReceiveAssets,
  type WithdrawalReceiveAssetOption,
} from "./withdrawAssets"
import type { WithdrawalReceiveAsset } from "./withdrawAssets"

/** A labeled listbox over the given output choices; closes on an outside press or Escape. */
export function AssetPicker<A extends WithdrawalReceiveAsset>({
  value,
  options,
  onChange,
  label = "Receive as",
  inline,
}: {
  value: A
  options: readonly (WithdrawalReceiveAssetOption & { id: A })[]
  onChange: (asset: A) => void
  label?: string
  /** Sits inside another field: the label names the button without showing. */
  inline?: boolean
}) {
  const [open, setOpen] = useState(false)
  const listboxId = useId()
  const selected = withdrawalReceiveAsset(value)
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  usePickerDismiss(open, setOpen, anchorRef, triggerRef)

  return (
    <div className="ww-deposit__fact" ref={anchorRef}>
      {!inline && <span>{label}</span>}
      <button
        ref={triggerRef}
        type="button"
        className="zkm-btn-reset ww-deposit__pill"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
      >
        <img src={selected.icon} alt="" width={16} height={16} />
        {selected.symbol}
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
      </button>
      {open && (
        <div
          id={listboxId}
          className="ww-deposit__picker"
          role="listbox"
          aria-label={label}
          // A label around the picker would send a press on the padding to its input.
          onClick={(event) => event.preventDefault()}
        >
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              className="zkm-btn-reset ww-deposit__picker-row"
              aria-selected={option.id === value}
              onClick={() => {
                onChange(option.id)
                setOpen(false)
                triggerRef.current?.focus()
              }}
            >
              <img src={option.icon} alt="" width={30} height={30} />
              <span>
                <b>{option.symbol}</b>
                <small>{option.name}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The web withdrawal's picker: what the manifest can deliver, DAI-only until it answers. `only`
 * narrows that to what the destination accepts.
 */
export function WithdrawalAssetPicker({
  only,
  ...props
}: {
  value: WithdrawalReceiveAsset
  onChange: (asset: WithdrawalReceiveAsset) => void
  label?: string
  inline?: boolean
  only?: readonly WithdrawalReceiveAsset[]
}) {
  const options = withdrawalReceiveAssets(useOxideTuple() ?? {})
  return (
    <AssetPicker {...props} options={only ? options.filter((o) => only.includes(o.id)) : options} />
  )
}
