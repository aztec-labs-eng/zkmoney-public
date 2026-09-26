import type { ChatMessage } from "@obsidion/front-core"
import { GradientInitialAvatar, Icon, Spinner, avatarColors } from "@obsidion/web-ds"
import { bubbleViewOf } from "./contactChat"

/** Amount bubble for the contact payments chat: counterparty avatar + glass bubble, left (incoming)
 *  or right (outgoing). The body is the control that opens the message's detail sheet; `actions`
 *  sit beside it as siblings, never inside it. */
export function ChatBubble({
  message,
  leftName,
  rightName,
  actions,
  onOpen,
}: {
  message: ChatMessage
  /** Avatar seed for incoming bubbles (the contact). */
  leftName: string
  /** Avatar seed for outgoing bubbles (the user). */
  rightName: string
  /** Open-request buttons, rendered left→right; the last one is the gradient primary. */
  actions?: { label: string; onClick: () => void; disabled?: boolean }[]
  onOpen: () => void
}) {
  const view = bubbleViewOf(message.role)
  const right = view.side === "right"
  const avatarName = right ? rightName : leftName
  return (
    <div className="ww-chat__row" data-side={view.side}>
      <GradientInitialAvatar name={avatarName} colors={avatarColors(avatarName)} size={40} />
      <div className="ww-bubble" data-side={view.side} data-error={view.error || undefined}>
        <div
          className="ww-bubble__body"
          role="button"
          aria-label={view.request ? "Request details" : "Transaction details"}
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onOpen()
            }
          }}
        >
          <span
            className="ww-bubble__pill"
            data-gold={view.request || undefined}
            data-settled={view.settled || undefined}
          >
            {view.label}
            <Icon name={view.icon} size={12} color="currentColor" />
          </span>
          <span
            className="ww-bubble__amount"
            style={{ textDecoration: view.struck ? "line-through" : undefined }}
          >
            {view.request || view.settled ? message.amount.replace(/^[+-]/, "") : message.amount}
          </span>
          {!view.request && (
            <span className="ww-bubble__time">
              {message.timeLabel}
              {view.tick === "proving" && <Spinner size={12} />}
              {/* A received row is only ever recorded once it is on-chain, so it never doubles. */}
              {/* Mempool tick stays muted — green is reserved for mined, or a Pending bubble
                  reads as success. */}
              {view.tick === "sent" && (
                <Icon name="check" size={14} color="var(--text-secondary)" />
              )}
              {view.tick === "mined" && (
                <Icon name={right ? "double-check" : "check"} size={14} color="#2ecc71" />
              )}
            </span>
          )}
        </div>
        {actions && actions.length > 0 && (
          <span className="ww-bubble__actions">
            {actions.map((a, i) => (
              <button
                key={a.label}
                type="button"
                className="zkm-btn-reset ww-bubble__btn"
                data-primary={i === actions.length - 1 || undefined}
                disabled={a.disabled}
                onClick={a.onClick}
              >
                {a.label}
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
