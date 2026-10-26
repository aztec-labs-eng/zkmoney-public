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

/**
 * How far the keyboard overlays a box ending at `bottom`, and the visible height; undefined where the
 * viewport is not exposed. Some iOS browsers already end fixed boxes above the keyboard, so measuring
 * the box itself keeps a sheet from being lifted twice.
 */
export function keyboardInset(
  win: Window = window,
  bottom = win.innerHeight,
): { inset: number; visible: number } | undefined {
  const viewport = win.visualViewport
  if (!viewport) return undefined
  const visible = Math.round(viewport.height)
  return {
    inset: Math.max(0, Math.round(bottom - viewport.height - viewport.offsetTop)),
    visible,
  }
}

/** Fields that raise the on-screen keyboard. */
const TYPED =
  "input:not([type=checkbox], [type=radio], [type=button], [type=submit]), textarea, [contenteditable]"

/**
 * Keeps the keyboard inset and the visible height on `root` while `active` and a field inside it has
 * focus, following the viewport. Without a focused field there is no keyboard, and Safari's own toolbar
 * resizes, which it makes as a sheet opens, would otherwise lift the sheet and drop it again.
 * `bottomOf` is where the box the keyboard covers ends: a fixed sheet's own box, or the page's height
 * for content in the page's flow.
 */
export function useKeyboardInset(
  root: RefObject<HTMLElement | null>,
  active = true,
  bottomOf: (element: HTMLElement) => number = (element) => element.getBoundingClientRect().bottom,
): void {
  useEffect(() => {
    const viewport = window.visualViewport
    const element = root.current
    if (!active || !viewport || !element) return
    const clear = () => {
      element.style.removeProperty(KEYBOARD_INSET_PROPERTY)
      element.style.removeProperty(VISIBLE_HEIGHT_PROPERTY)
    }
    const apply = () => {
      const focused = document.activeElement
      const measured =
        focused &&
        element.contains(focused) &&
        focused.matches(TYPED) &&
        keyboardInset(window, bottomOf(element))
      if (!measured) return clear()
      element.style.setProperty(KEYBOARD_INSET_PROPERTY, `${measured.inset}px`)
      element.style.setProperty(VISIBLE_HEIGHT_PROPERTY, `${measured.visible}px`)
    }
    apply()
    // The box can end above the keyboard only after the viewport's resize, so its own resize counts too.
    const box = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(apply)
    box?.observe(element, { box: "border-box" })
    window.addEventListener("resize", apply)
    viewport.addEventListener("resize", apply)
    viewport.addEventListener("scroll", apply)
    element.addEventListener("focusin", apply)
    element.addEventListener("focusout", apply)
    return () => {
      box?.disconnect()
      window.removeEventListener("resize", apply)
      viewport.removeEventListener("resize", apply)
      viewport.removeEventListener("scroll", apply)
      element.removeEventListener("focusin", apply)
      element.removeEventListener("focusout", apply)
      clear()
    }
  }, [root, active, bottomOf])
}

/** The page's height, for `useKeyboardInset` on content in the page's flow. */
export const pageBottom = () => window.innerHeight

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

/** Scrolls the page so `element` ends above the keyboard, once the keyboard has settled. */
export async function revealAboveKeyboard(element: HTMLElement): Promise<void> {
  await viewportSettled()
  const viewport = window.visualViewport
  if (!viewport || !element.isConnected) return
  const covered = element.getBoundingClientRect().bottom - viewport.offsetTop - viewport.height
  if (covered > 0) window.scrollBy({ top: covered })
}

/** Scrolls a field the keyboard would cover into view within its sheet, once the keyboard has settled. */
export async function revealFocusedField(field: HTMLElement): Promise<void> {
  await viewportSettled()
  const bottom = field.closest("dialog")?.getBoundingClientRect().bottom
  if ((keyboardInset(window, bottom)?.inset ?? 0) === 0 || document.activeElement !== field) return
  field.scrollIntoView?.({ block: "nearest" })
}
