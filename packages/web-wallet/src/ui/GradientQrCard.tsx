import type { ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import { renderSVG } from "uqr"

/** White-on-gradient QR over a copyable label band — the app's standard share card. */
export function GradientQrCard({
  payload,
  label,
  ariaLabel,
  copied,
  onCopy,
  copyIcon,
}: {
  payload: string
  label: string
  ariaLabel: string
  copied: boolean
  onCopy: () => void
  /** Optional copy glyph; copied feedback keeps its checkmark. */
  copyIcon?: ReactNode
}) {
  return (
    <div className="ww-qr-card">
      <div
        aria-label={ariaLabel}
        className="ww-qr-card__code"
        dangerouslySetInnerHTML={{
          __html: renderSVG(payload, { whiteColor: "transparent", blackColor: "#fff" }),
        }}
      />
      <button type="button" className="zkm-btn-reset ww-qr-card__label" onClick={onCopy}>
        <span>{label}</span>
        {copied ? <Icon name="check" size={16} /> : (copyIcon ?? <Icon name="copy" size={16} />)}
      </button>
    </div>
  )
}
