import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent, type ReactNode, type SyntheticEvent } from "react"
import { GradientText, TopNavIconButton } from "@obsidion/web-ds"

type ModalLifecycle = { suspend: () => void; resume: () => void }
const SuspensionContext = createContext<{
  suspended: boolean
  register: (modal: ModalLifecycle) => () => void
} | null>(null)

/** Body-portaled dialogs need native sheets to release both the top layer and background inertness. */
export function ModalSuspension({ suspended, children }: { suspended: boolean; children: ReactNode }) {
  const modals = useRef(new Set<ModalLifecycle>())
  const active = useRef(false)
  const register = useCallback((modal: ModalLifecycle) => {
    modals.current.add(modal)
    if (active.current) modal.suspend()
    else modal.resume()
    return () => { modals.current.delete(modal) }
  }, [])
  useLayoutEffect(() => {
    active.current = suspended
    // Close from the top down; reopen in original show order so nested sheets stay on top.
    const stack = [...modals.current]
    if (suspended) stack.reverse().forEach((modal) => modal.suspend())
    else stack.forEach((modal) => modal.resume())
  }, [suspended])
  const value = useMemo(() => ({ suspended, register }), [suspended, register])
  return <SuspensionContext.Provider value={value}>{children}</SuspensionContext.Provider>
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** React autofocus runs while the native dialog is hidden; explicit targets are focused after show. */
function focusDialog(dialog: HTMLDialogElement) {
  const requested = dialog.querySelector<HTMLElement>("[data-autofocus], .ww-autofocus input")
  if (requested && requested.closest("dialog") === dialog && !requested.matches(":disabled")) {
    requested.focus()
    if (document.activeElement === requested) return
  }
  const card = dialog.querySelector<HTMLElement>(":scope > .ww-modal")
  ;(card ?? dialog).focus()
}

/** Native modal dialogs make the background inert and keep nested sheets in focus order. */
function useDialogFocus() {
  const suspension = useContext(SuspensionContext)
  const register = suspension?.register
  const overlay = useRef<HTMLDialogElement>(null)
  const opener = useRef<Element | null>(null)
  const closing = useRef(false)
  const opened = useRef(false)
  const paused = useRef(false)
  const cleanupCloseEvents = useRef(0)
  useLayoutEffect(() => {
    closing.current = false
    const dialog = overlay.current
    return () => {
      closing.current = true
      opened.current = false
      const focused = document.activeElement
      const destination = focused instanceof HTMLElement && focused !== document.body && !dialog?.contains(focused) ? focused : null
      if (dialog?.open) {
        cleanupCloseEvents.current += 1
        dialog.close()
      }
      // Native close restores prior focus; preserve a destination that already took focus.
      if (destination?.isConnected) destination.focus({ preventScroll: true })
      // Dialog shims may leave focus in the closing surface instead of restoring the opener.
      else if (
        opener.current instanceof HTMLElement && opener.current.isConnected &&
        (document.activeElement === document.body || dialog?.contains(document.activeElement))
      ) opener.current.focus({ preventScroll: true })
    }
  }, [])
  // Previous passive cleanups (including the menu) restore their opener before this capture.
  useEffect(() => {
    const dialog = overlay.current
    if (!dialog?.isConnected || closing.current) return
    opener.current = document.activeElement
    opened.current = true
    let returnFocus: HTMLElement | null = null
    const lifecycle: ModalLifecycle = {
      suspend() {
        paused.current = true
        if (!dialog.open) return
        const focused = document.activeElement
        returnFocus = focused instanceof HTMLElement && dialog.contains(focused) ? focused : null
        cleanupCloseEvents.current += 1
        dialog.close()
      },
      resume() {
        paused.current = false
        if (!dialog.isConnected || closing.current || dialog.open) return
        dialog.showModal()
        if (returnFocus?.isConnected && dialog.contains(returnFocus)) returnFocus.focus({ preventScroll: true })
        if (!returnFocus || !dialog.contains(document.activeElement)) focusDialog(dialog)
        returnFocus = null
      },
    }
    if (register) return register(lifecycle)
    lifecycle.resume()
  }, [register])
  return { overlay, closing, opened, paused, cleanupCloseEvents, suspended: suspension?.suspended ?? false }
}

const FrameContext = createContext(false)
export const useModalFrame = () => useContext(FrameContext)

/** A persistent overlay for sequences that replace their card between steps. */
export function ModalFrame({ label, role = "dialog", onClose, children }: {
  label?: string
  role?: "dialog" | "alertdialog"
  onClose?: () => void
  children: ReactNode
}) {
  const { overlay, closing, opened, paused, cleanupCloseEvents, suspended } = useDialogFocus()
  useLayoutEffect(() => {
    const dialog = overlay.current
    // Native dismissal may change the step while keeping this frame mounted.
    if (!suspended && !paused.current && opened.current && dialog?.isConnected && !dialog.open && !closing.current) {
      dialog.showModal()
      focusDialog(dialog)
    }
    // A replaced sequence card can remove the focused control without replacing the dialog.
    if (dialog?.open && document.activeElement === document.body) {
      const card = dialog.querySelector<HTMLElement>(":scope > .ww-modal")
      ;(card ?? dialog).focus()
    }
  })
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    const dialog = overlay.current
    if (!dialog || (e.target as HTMLElement).closest("dialog") !== dialog) return
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      onClose?.()
      return
    }
    if (e.key !== "Tab") return
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (item) => !item.closest('[hidden], [inert]') && item.closest("dialog") === dialog,
    )
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    const card = dialog.querySelector(":scope > .ww-modal")
    if (e.shiftKey && (active === first || active === card || active === dialog)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return <FrameContext.Provider value={true}>
    <dialog
      ref={overlay}
      tabIndex={-1}
      role={role}
      aria-modal="true"
      aria-label={label}
      className="ww-modal-overlay"
      onKeyDown={onKeyDown}
      onClose={(e) => {
        e.stopPropagation()
        if (e.target !== e.currentTarget) return
        // Cleanup queues a close event, which can arrive after StrictMode reopens this node.
        if (cleanupCloseEvents.current > 0) {
          cleanupCloseEvents.current -= 1
          return
        }
        const dialog = e.currentTarget
        if (suspended || closing.current || !dialog.isConnected || dialog.open) return
        if (onClose) onClose()
        else {
          dialog.showModal()
          focusDialog(dialog)
        }
      }}
      // A top sheet must not trigger an underlying panel’s document outside-click listener.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}
      onCancel={(e: SyntheticEvent) => {
        e.preventDefault()
        e.stopPropagation()
        onClose?.()
      }}
    >
      {children}
    </dialog>
  </FrameContext.Provider>
}

/**
 * Shared flow sheet. Callers omit onClose while an operation must finish through its own controls.
 * Create and bare variants keep caller-owned content and existing specialized scroll containers.
 */
export function Modal({
  title,
  label,
  onBack,
  onClose,
  className,
  variant,
  role = "dialog",
  children,
}: {
  title?: string
  label?: string
  onBack?: () => void
  onClose?: () => void
  className?: string
  variant?: "create" | "bare"
  role?: "dialog" | "alertdialog"
  children: ReactNode
}) {
  return (
    <ModalFrame label={label ?? title} role={role} onClose={onClose}>
      <div
        tabIndex={-1}
        onClick={(e: MouseEvent) => e.stopPropagation()}
        className={["ww-modal", variant === "create" && "ww-modal--create", className].filter(Boolean).join(" ")}
      >
        {variant === "create" && onClose && (
          <div className="ww-modal__close">
            <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
          </div>
        )}
        {!variant && (title || onBack || onClose) && (
          <div className="ww-modal__head">
            <span className="ww-modal__head-slot">
              {onBack && <TopNavIconButton icon="chevron-left" ariaLabel="Back" onClick={onBack} />}
            </span>
            <span className="ww-modal__head-title">
              {title && <GradientText size={24} weight={700}>{title}</GradientText>}
            </span>
            <span className="ww-modal__head-slot">
              {onClose && <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />}
            </span>
          </div>
        )}
        {children}
      </div>
    </ModalFrame>
  )
}
