import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

/** Stays mounted through its slide out; with no animation running it closes at once. */
export function MobileMenu({
  open,
  children,
  onClose,
}: {
  open: boolean
  children: ReactNode
  onClose: () => void
}) {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  const closed = useCallback(() => setMounted(false), [])
  return mounted ? (
    <MenuDialog closing={!open} onClosed={closed} onClose={onClose}>
      {children}
    </MenuDialog>
  ) : null
}

/** The browser contains focus and makes the page inert while the menu is open. */
function MenuDialog({
  closing,
  children,
  onClose,
  onClosed,
}: {
  closing: boolean
  children: ReactNode
  onClose: () => void
  onClosed: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const opener = document.activeElement
    const previousOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = "hidden"
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[aria-label="Close menu"]')?.focus()
    // The slide starts from a painted frame, so the work of opening cannot swallow it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => dialog.setAttribute("data-shown", ""))
    })
    return () => {
      cancelAnimationFrame(frame)
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
  useLayoutEffect(() => {
    if (!closing) return
    const animations = ref.current!.getAnimations?.({ subtree: true }) ?? []
    if (animations.length === 0) return onClosed()
    let live = true
    const done = () => live && onClosed()
    void Promise.all(animations.map((animation) => animation.finished)).then(done, done)
    const timer = setTimeout(done, 1000)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [closing, onClosed])

  return (
    <dialog
      ref={ref}
      id="wallet-menu"
      className="ww-menu-dialog"
      aria-label="Wallet menu"
      data-closing={closing || undefined}
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
