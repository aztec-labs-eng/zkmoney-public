import { useEffect, useRef, type ReactNode } from "react"

/** The browser contains focus and makes the page inert while the menu is open. */
export function MobileMenu({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const opener = document.activeElement
    const previousOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = "hidden"
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[aria-label="Close menu"]')?.focus()
    return () => {
      dialog.close()
      document.documentElement.style.overflow = previousOverflow
      if (document.activeElement && document.activeElement !== document.body) return
      if (opener instanceof HTMLElement && opener.isConnected && opener.getClientRects().length) {
        opener.focus({ preventScroll: true })
      } else {
        document
          .querySelector<HTMLElement>('.ww-sidebar [aria-current="page"]')
          ?.focus({ preventScroll: true })
      }
    }
  }, [])

  return (
    <dialog
      ref={ref}
      id="wallet-menu"
      className="ww-menu-dialog"
      aria-label="Wallet menu"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
        ]
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
      onClose={(event) => {
        if (event.target === event.currentTarget && !event.currentTarget.open) onClose()
      }}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {children}
    </dialog>
  )
}
