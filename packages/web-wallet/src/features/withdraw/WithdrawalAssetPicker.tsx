import { useEffect, useId, useRef, useState } from "react"
import { Icon } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { getOxideTuple } from "../../config/oxideTuple"
import {
  WITHDRAWAL_RECEIVE_ASSETS,
  withdrawalReceiveAsset,
  withdrawalReceiveAssets,
  type WithdrawalReceiveAssetOption,
} from "./withdrawAssets"
import type { WithdrawalReceiveAsset } from "./withdrawAssets"

/**
 * Which outputs this deployment can actually deliver, per its oxide manifest. DAI-only until the
 * tuple answers, so a slow or failed manifest fetch never offers a swap route the relayer cannot
 * execute.
 */
function useReceiveAssetOptions(): readonly WithdrawalReceiveAssetOption[] {
  const [options, setOptions] = useState<readonly WithdrawalReceiveAssetOption[]>(() =>
    WITHDRAWAL_RECEIVE_ASSETS.filter((o) => o.direct),
  )
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const tuple = await getOxideTuple(getConfig())
        if (active) setOptions(withdrawalReceiveAssets(tuple))
      } catch {
        // Stay DAI-only: a manifest we cannot read cannot promise a relayer either.
      }
    })()
    return () => {
      active = false
    }
  }, [])
  return options
}

export function WithdrawalAssetPicker({
  value,
  onChange,
  label = "Receive as",
}: {
  value: WithdrawalReceiveAsset
  onChange: (asset: WithdrawalReceiveAsset) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const options = useReceiveAssetOptions()
  const labelId = useId()
  const listboxId = useId()
  const selected = withdrawalReceiveAsset(value)
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div className="ww-deposit__fact" ref={anchorRef}>
      <span id={labelId}>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="zkm-btn-reset ww-deposit__pill"
        aria-labelledby={labelId}
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
        <div id={listboxId} className="ww-deposit__picker" role="listbox" aria-labelledby={labelId}>
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
