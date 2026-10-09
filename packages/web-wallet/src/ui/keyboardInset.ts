/**
 * Where the on-screen keyboard overlays the page instead of resizing it (iOS Safari ignores
 * `interactive-widget=resizes-content`), the visual viewport is the only measure of what is still
 * visible. A sheet reads the keyboard's inset and the visible height from custom properties on its
 * root and lifts itself above the keyboard; where the page resizes instead, the inset is zero and
 * nothing changes.
 */
import { useEffect, type RefObject } from "react"

export const KEYBOARD_INSET_PROPERTY = "--ww-keyboard-inset"
export const VISIBLE_HEIGHT_PROPERTY = "--ww-visible-height"

/** The keyboard's overlay height and the visible height; undefined where the viewport is not exposed. */
export function keyboardInset(
  win: Window = window,
): { inset: number; visible: number } | undefined {
  const viewport = win.visualViewport
  if (!viewport) return undefined
  const visible = Math.round(viewport.height)
  return {
    inset: Math.max(0, Math.round(win.innerHeight - viewport.height - viewport.offsetTop)),
    visible,
  }
}

/** Keeps the keyboard inset and the visible height on `root` while `active`, following the viewport. */
export function useKeyboardInset(root: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const viewport = window.visualViewport
    const element = root.current
    if (!active || !viewport || !element) return
    const apply = () => {
      const measured = keyboardInset()
      if (!measured) return
      element.style.setProperty(KEYBOARD_INSET_PROPERTY, `${measured.inset}px`)
      element.style.setProperty(VISIBLE_HEIGHT_PROPERTY, `${measured.visible}px`)
    }
    apply()
    viewport.addEventListener("resize", apply)
    viewport.addEventListener("scroll", apply)
    return () => {
      viewport.removeEventListener("resize", apply)
      viewport.removeEventListener("scroll", apply)
      element.style.removeProperty(KEYBOARD_INSET_PROPERTY)
      element.style.removeProperty(VISIBLE_HEIGHT_PROPERTY)
    }
  }, [root, active])
}

/** Resolves once the visual viewport has stopped resizing: `quietMs` without a resize, `maxMs` at most. */
export function viewportSettled(quietMs = 120, maxMs = 600): Promise<void> {
  const viewport = window.visualViewport
  if (!viewport) return Promise.resolve()
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      clearTimeout(quiet)
      clearTimeout(limit)
      viewport.removeEventListener("resize", bump)
      resolve()
    }
    const bump = () => {
      clearTimeout(quiet)
      quiet = setTimeout(done, quietMs)
    }
    const limit = setTimeout(done, maxMs)
    viewport.addEventListener("resize", bump)
    bump()
  })
}

/** Scrolls a field the keyboard would cover into view within its sheet, once the keyboard has settled. */
export async function revealFocusedField(field: HTMLElement): Promise<void> {
  await viewportSettled()
  if ((keyboardInset()?.inset ?? 0) === 0 || document.activeElement !== field) return
  field.scrollIntoView?.({ block: "nearest" })
}
