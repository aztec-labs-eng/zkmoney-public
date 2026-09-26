import { Modal, useModalFrame } from "../../ui/Modal"
import type { ReactNode } from "react"
import { GradientSpinner, Icon, TopNavIconButton } from "@obsidion/web-ds"

/**
 * One signup step in the shared modal lifecycle. The optional banner spans the card header.
 */
export function OnboardingCard({
  onClose,
  banner,
  narrow = false,
  className,
  children,
}: {
  /** Renders the close X; omit for states that must resolve via their own buttons. */
  onClose?: () => void
  banner?: string
  /** Compact spinner/success card instead of the full step card. */
  narrow?: boolean
  className?: string
  children: ReactNode
}) {
  const framed = useModalFrame()
  const cardClass = [narrow && "ww-modal--narrow", className].filter(Boolean).join(" ")
  const content = <>
      {banner && (
        <div className="ww-invite-banner" role="status">
          <Icon name="shield-check" size={24} color="var(--accent-green)" />
          <span>{banner}</span>
        </div>
      )}
      {onClose && (
        <div className="ww-modal__close">
          <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
        </div>
      )}
      {children}
  </>
  return framed ? (
    <div className={["ww-modal", cardClass].filter(Boolean).join(" ")} tabIndex={-1}>
      {content}
    </div>
  ) : (
    <Modal variant="bare" label="Account setup" onClose={onClose} className={cardClass}>
      {content}
    </Modal>
  )
}

/** Spinner body shared by the loading states: spinner, label, and a cancel when the op allows one. */
export function OnboardingSpinnerBody({
  label,
  onCancel,
  cancelLabel = "Cancel sign-in",
}: {
  label: string
  onCancel?: () => void
  cancelLabel?: string
}) {
  return (
    <div className="ww-invite-spinner">
      <GradientSpinner />
      <span className="ww-invite-spinner__label">{label}</span>
      {onCancel && (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-invite-pill"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      )}
    </div>
  )
}
