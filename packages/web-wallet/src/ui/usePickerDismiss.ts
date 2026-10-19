import { useEffect, type RefObject } from "react"

/** Closes an open picker on an outside press, or on Escape with focus back on its trigger. */
export function usePickerDismiss(
  open: boolean,
  setOpen: (open: boolean) => void,
  anchorRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return
    // A sheet that scrolls clips the list. jsdom has no scrollIntoView.
    anchorRef.current?.lastElementChild?.scrollIntoView?.({ block: "nearest" })
    const onDown = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    // Capture: a sheet around the picker stops presses and closes on Escape.
    document.addEventListener("mousedown", onDown, true)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("mousedown", onDown, true)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open, setOpen, anchorRef, triggerRef])
}
