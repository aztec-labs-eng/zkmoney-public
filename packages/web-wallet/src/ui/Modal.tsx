import { createContext, useCallback, useContext, useMemo, useRef, useState, type AnimationEventHandler, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react"
import { GradientText, TopNavIconButton } from "@obsidion/web-ds"
import { extensionAnswersPasskeys, onPasskeyRequest } from "@obsidion/passkey-web"
import { revealFocusedField, useKeyboardInset } from "./keyboardInset"
import { useStepDir, type StepDir } from "./flow/useFlowSteps"
import { useDomEffect, useDomLayoutEffect } from "./useDomEffect"

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
  useDomLayoutEffect(() => {
    active.current = suspended
    // Close from the top down; reopen in original show order so nested sheets stay on top.
    const stack = [...modals.current]
    if (suspended) stack.reverse().forEach((modal) => modal.suspend())
    else stack.forEach((modal) => modal.resume())
  }, [suspended])
  const value = useMemo(() => ({ suspended, register }), [suspended, register])
  return <SuspensionContext.Provider value={value}>{children}</SuspensionContext.Provider>
}

/**
 * An extension that answers WebAuthn inside the page (1Password, or Proton Pass through the wrapper
 * the page's lock kept aside) mounts its prompt in the topmost modal dialog. When that sheet
 * unmounts at hand-off the prompt goes with it before it can report closing, and the extension never
 * draws another: every later request hangs. While such a request is out, open sheets drop to
 * non-modal so the prompt mounts on the body.
 */
type DialogLayer = { reopen: () => void }
// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
const layers = new Set<DialogLayer>()
// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
let nonModal = false

if (typeof window !== "undefined") {
  onPasskeyRequest((active, kept) => {
    const next = active && (kept || extensionAnswersPasskeys())
    if (next === nonModal) return
    nonModal = next
    // In show order, so reopened modals stack as they did.
    for (const layer of [...layers]) layer.reopen()
  })
}

/** Opens a sheet in the current mode; `aria-modal` follows, since a non-modal sheet leaves the page reachable. */
function present(dialog: HTMLDialogElement) {
  dialog.setAttribute("aria-modal", String(!nonModal))
  if (nonModal) dialog.show()
  else dialog.showModal()
}

/**
 * Runs `then` once every finite animation under `el` whose target `pick` keeps has finished or been
 * canceled, and returns what cancels the wait. With none running, as under reduced motion, it runs
 * on the next microtask.
 */
function afterAnimations(el: Element, pick: (target: Element) => boolean, then: () => void) {
  let live = true
  const running = (el.getAnimations?.({ subtree: true }) ?? []).filter((animation) => {
    const effect = animation.effect as KeyframeEffect | null
    return effect?.getTiming().iterations !== Infinity && !!effect?.target && pick(effect.target)
  })
  void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
    if (live) then()
  })
  return () => {
    live = false
  }
}

/**
 * Reopens a sheet that stays on screen, landing every animation the reopen restarted at its end.
 * A looping one keeps looping: `finish()` throws on an infinite animation.
 */
function inPlace(dialog: HTMLDialogElement, open: () => void) {
  open()
  for (const animation of dialog.getAnimations?.({ subtree: true }) ?? []) {
    if (animation.effect?.getTiming().iterations !== Infinity) animation.finish()
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** React autofocus runs while the native dialog is hidden; explicit targets are focused after show. */
function focusDialog(dialog: HTMLDialogElement, options?: FocusOptions) {
  const requested = dialog.querySelector<HTMLElement>("[data-autofocus], .ww-autofocus input")
  if (requested && requested.closest("dialog") === dialog && !requested.matches(":disabled")) {
    requested.focus(options)
    if (document.activeElement === requested) return
  }
  const card = dialog.querySelector<HTMLElement>(":scope > .ww-modal")
  ;(card ?? dialog).focus(options)
}

/**
 * The field is focused at once, so iOS still opens its keyboard, without scrolling; once the open
 * animation has ended it is scrolled into view where the sheet landed.
 */
function focusDialogAfterOpen(dialog: HTMLDialogElement) {
  const card = dialog.querySelector<HTMLElement>(":scope > .ww-modal")
  if (!card?.getAnimations?.().length) return focusDialog(dialog)
  focusDialog(dialog, { preventScroll: true })
  afterAnimations(card, (target) => target === card, () => {
    const active = document.activeElement
    if (dialog.open && active instanceof HTMLElement && active !== card && dialog.contains(active))
      active.scrollIntoView?.({ block: "nearest" })
  })
}

/**
 * Plays an unmounted sheet's exit on an inert copy of it in the top layer. A popover, not a modal
 * dialog, so focus stays where the real close put it.
 */
function playClosing(dialog: HTMLDialogElement) {
  if (reducedMotion() || typeof dialog.showPopover !== "function") return
  const ghost = dialog.cloneNode(true) as HTMLDialogElement
  const scrolled: [number, number][] = []
  dialog.querySelectorAll("*").forEach((el, i) => {
    if (el.scrollTop > 0) scrolled.push([i, el.scrollTop])
  })
  const shown = new Set(document.querySelectorAll("dialog.ww-modal-overlay[open]"))
  // Once the commit is through, before paint; the node is still in the page after a StrictMode
  // remount or a reopen.
  queueMicrotask(() => {
    if (dialog.isConnected) return
    // A sheet that replaced this one plays its own entrance.
    if ([...document.querySelectorAll("dialog.ww-modal-overlay[open]")].some((d) => !shown.has(d))) return
    const nodes = ghost.querySelectorAll("*")
    ghost.removeAttribute("open")
    ghost.removeAttribute("aria-modal")
    ghost.setAttribute("inert", "")
    ghost.setAttribute("aria-hidden", "true")
    ghost.setAttribute("popover", "manual")
    ghost.dataset.closing = ""
    ghost.style.pointerEvents = "none"
    ghost.querySelectorAll(":scope > .ww-modal[inert]").forEach((card) => card.remove())
    ghost.querySelectorAll<HTMLElement>(":scope > .ww-modal").forEach((card) => {
      card.style.animation = ""
      card.style.display = ""
      delete card.dataset.phase
    })
    // On the body: a page's own rules must not reach it.
    document.body.appendChild(ghost)
    ghost.showPopover()
    for (const [i, top] of scrolled) nodes[i].scrollTop = top
    afterAnimations(ghost, () => true, () => {
      if (ghost.matches(":popover-open")) ghost.hidePopover()
      ghost.remove()
    })
  })
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
  useDomLayoutEffect(() => {
    closing.current = false
    const dialog = overlay.current
    return () => {
      closing.current = true
      opened.current = false
      const focused = document.activeElement
      const destination = focused instanceof HTMLElement && focused !== document.body && !dialog?.contains(focused) ? focused : null
      if (dialog?.open) {
        playClosing(dialog)
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
  useDomEffect(() => {
    const dialog = overlay.current
    if (!dialog?.isConnected || closing.current) return
    opener.current = document.activeElement
    opened.current = true
    let returnFocus: HTMLElement | null = null
    let lowered = false
    const lifecycle: ModalLifecycle = {
      // Drops an open sheet out of the top layer but leaves it on screen under the body portal.
      suspend() {
        paused.current = true
        if (!dialog.open) return
        const focused = document.activeElement
        returnFocus = focused instanceof HTMLElement && dialog.contains(focused) ? focused : null
        cleanupCloseEvents.current += 1
        dialog.close()
        dialog.setAttribute("aria-modal", "false")
        inPlace(dialog, () => dialog.show())
        // show() focuses the sheet's card; the dialog that suspends it records the focused element as the one to
        // return to when it closes, which is the control that opened it.
        returnFocus?.focus({ preventScroll: true })
        lowered = true
      },
      resume() {
        paused.current = false
        const wasLowered = lowered
        lowered = false
        if (!dialog.isConnected || closing.current || (dialog.open && !wasLowered)) return
        if (dialog.open) {
          cleanupCloseEvents.current += 1
          dialog.close()
        }
        if (wasLowered) inPlace(dialog, () => present(dialog))
        else present(dialog)
        if (returnFocus?.isConnected && dialog.contains(returnFocus)) returnFocus.focus({ preventScroll: true })
        if (!returnFocus || !dialog.contains(document.activeElement)) focusDialogAfterOpen(dialog)
        returnFocus = null
      },
    }
    // Reopens an open sheet in the current mode; the close it queues is not a dismissal.
    const layer: DialogLayer = {
      reopen() {
        if (!dialog.open) return
        const focused = document.activeElement
        cleanupCloseEvents.current += 1
        dialog.close()
        inPlace(dialog, () => present(dialog))
        if (focused instanceof HTMLElement && dialog.contains(focused)) focused.focus({ preventScroll: true })
      },
    }
    layers.add(layer)
    const unregister = register?.(lifecycle)
    if (!register) lifecycle.resume()
    return () => {
      layers.delete(layer)
      unregister?.()
    }
  }, [register])
  return { overlay, closing, opened, paused, cleanupCloseEvents, suspended: suspension?.suspended ?? false }
}

const FrameContext = createContext(false)
export const useModalFrame = () => useContext(FrameContext)

/** A persistent overlay for sequences that replace their card between steps. */
export function ModalFrame({ label, role = "dialog", onClose, overlayClassName, frameRef, onAnimationEnd, children }: {
  label?: string
  role?: "dialog" | "alertdialog"
  onClose?: () => void
  overlayClassName?: string
  frameRef?: RefObject<HTMLDialogElement | null>
  /** Every animation that ends inside the frame, bubbled. */
  onAnimationEnd?: AnimationEventHandler<HTMLElement>
  children: ReactNode
}) {
  const { overlay, closing, opened, paused, cleanupCloseEvents, suspended } = useDialogFocus()
  const setOverlay = useCallback((node: HTMLDialogElement | null) => {
    overlay.current = node
    if (frameRef) frameRef.current = node
  }, [overlay, frameRef])
  useKeyboardInset(overlay)
  useDomLayoutEffect(() => {
    const dialog = overlay.current
    // Native dismissal may change the step while keeping this frame mounted.
    if (!suspended && !paused.current && opened.current && dialog?.isConnected && !dialog.open && !closing.current) {
      present(dialog)
      focusDialog(dialog)
    }
    // A replaced sequence card can remove the focused control without replacing the dialog.
    if (dialog?.open && document.activeElement === document.body) {
      const card = dialog.querySelector<HTMLElement>(":scope > .ww-modal")
      ;(card ?? dialog).focus({ preventScroll: true })
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
      ref={setOverlay}
      tabIndex={-1}
      role={role}
      aria-modal="true"
      aria-label={label}
      className={["ww-modal-overlay", overlayClassName].filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
      onAnimationEnd={onAnimationEnd}
      onFocus={(e) => {
        const field = e.target
        if (field instanceof HTMLElement && field.matches("input, textarea, select")) void revealFocusedField(field)
      }}
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
          present(dialog)
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

/** The steps host a `Modal` renders into; null outside one and inside a step's own content. */
type StepsHost = {
  className?: string
  dir?: StepDir
  setClose: (close: (() => void) | undefined) => void
  /** A step's own card changed under the host, so the host swaps it in. */
  sync: () => void
}
const StepsContext = createContext<StepsHost | null>(null)

/** The flow card's easing (`--flow-ease`); outside a flow card, the same curve. */
const EASE = "var(--flow-ease, cubic-bezier(0.16, 1, 0.3, 1))"
const HEIGHT_TRANSITION = `height 0.2s ${EASE}`
/** A step swap's resize length: the card's `--flow-resize` (`ui/flow/flow.module.css`), else 264ms. */
const resizeMs = (el: HTMLElement) => {
  const value = getComputedStyle(el).getPropertyValue("--flow-resize").trim()
  const n = parseFloat(value)
  if (!Number.isFinite(n)) return 264
  return value.endsWith("ms") ? n : value.endsWith("s") ? n * 1000 : n
}
/** How far into a card's resize the next step starts entering. */
const ENTER_AT = 0.5
/** The card's own motion, and its step's: the animations on its children. */
const own = (card: Element) => (target: Element) => target === card
const steps = (card: Element) => (target: Element) => target.parentElement === card

/** A card's layout size, unrounded, so a height set from it is the one the card takes unset. */
const layoutSize = (el: HTMLElement) => {
  const style = getComputedStyle(el)
  return { w: parseFloat(style.width), h: parseFloat(style.height) }
}

const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

/**
 * Eases the overlay's card between sizes. A step swap runs in three phases, named on the card as
 * `data-phase`: the old card, put back as an inert ghost taking the new card's `data-dir`, plays
 * `leave`; the new card, its step hidden, resizes from the old size (`resize`); then its step plays
 * `enter`. Content that changes in place eases the card's height. Reduced motion swaps at once.
 */
function useCardSteps(dialog: RefObject<HTMLDialogElement | null>, enabled: boolean) {
  const card = useRef<HTMLElement | null>(null)
  const size = useRef<{ w: number; h: number } | null>(null)
  const detach = useRef<(() => void) | null>(null)
  const stop = useRef<(() => void) | null>(null)
  function animate(el: HTMLElement): void {
    if (stop.current) return
    const prev = size.current?.h ?? null
    el.style.height = ""
    // Layout size, so the card's own open transform does not skew it.
    const measured = layoutSize(el)
    const next = measured.h || 0
    // A closed dialog lays out nothing, so the card opens at its first real height.
    size.current = next ? measured : null
    if (prev === null || !next || Math.abs(next - prev) <= 1) return
    if (reducedMotion()) return
    el.style.overflow = "hidden"
    el.style.height = `${prev}px`
    void el.offsetHeight
    el.style.transition = HEIGHT_TRANSITION
    el.style.height = `${next}px`
    let cancelEnd = () => {}
    const clear = () => {
      cancelEnd()
      el.style.transition = ""
      el.style.height = ""
      el.style.overflow = ""
      stop.current = null
    }
    // Content that changed mid-transition is caught up from where the card landed.
    const done = () => {
      clear()
      if (el === card.current) animate(el)
    }
    cancelEnd = afterAnimations(el, own(el), done)
    stop.current = clear
  }
  /**
   * A flow's first card, when it opens on the picker: the step rises as the dialog opens. The
   * dialog shows after this layout pass, so the wait starts with the card's first animation.
   */
  function open(next: HTMLElement) {
    next.dataset.phase = "open"
    const done = () => {
      delete next.dataset.phase
      stop.current = null
      if (next === card.current) animate(next)
    }
    let cancel = () => {}
    const shown = () => {
      cancel = afterAnimations(next, (t) => own(next)(t) || steps(next)(t), done)
    }
    next.addEventListener("animationstart", shown, { once: true })
    stop.current = () => {
      next.removeEventListener("animationstart", shown)
      cancel()
      delete next.dataset.phase
      stop.current = null
    }
  }
  function swap(prev: HTMLElement, next: HTMLElement, from: { w: number; h: number }) {
    let cancel = () => {}
    const enterDelay = (delay: string) => {
      for (const child of Array.from(next.children)) (child as HTMLElement).style.animationDelay = delay
    }
    const unsize = () => {
      next.style.transition = ""
      next.style.width = ""
      next.style.height = ""
      next.style.overflow = ""
    }
    // The card keeps its measured height until the step has entered; a change meanwhile eases after.
    const finish = () => {
      delete next.dataset.phase
      enterDelay("")
      stop.current = null
      next.style.transition = ""
      next.style.width = ""
      next.style.overflow = ""
      if (next === card.current) animate(next)
      else next.style.height = ""
    }
    const enter = (height: number) => {
      next.style.transition = ""
      next.style.width = ""
      // Clips the step to the card while the card's shadow stays.
      next.style.overflow = "hidden"
      next.style.height = `${height}px`
      next.dataset.phase = "enter"
      cancel = afterAnimations(next, steps(next), finish)
    }
    const resize = () => {
      prev.remove()
      next.style.display = ""
      next.dataset.phase = "resize"
      const to = layoutSize(next)
      size.current = to
      if (Math.abs(to.w - from.w) <= 1 && Math.abs(to.h - from.h) <= 1) return enter(to.h)
      next.style.overflow = "hidden"
      next.style.width = `${from.w}px`
      next.style.height = `${from.h}px`
      void next.offsetHeight
      const ms = resizeMs(next)
      next.style.transition = `height ${ms}ms ${EASE}, width ${ms}ms ${EASE}`
      next.style.width = `${to.w}px`
      next.style.height = `${to.h}px`
      // The step starts entering part way through the resize; the card settles once both end.
      enterDelay(`${ms * ENTER_AT}ms`)
      next.dataset.phase = "enter"
      cancel = afterAnimations(next, (t) => own(next)(t) || steps(next)(t), finish)
    }
    if (next.dataset.dir) prev.dataset.dir = next.dataset.dir
    else delete prev.dataset.dir
    // A finished entrance left its own inline `none`; the leave needs the rule's animation.
    for (const child of Array.from(prev.children)) (child as HTMLElement).style.animation = ""
    prev.setAttribute("inert", "")
    prev.setAttribute("aria-hidden", "true")
    prev.dataset.phase = "leave"
    next.style.display = "none"
    next.before(prev)
    cancel = afterAnimations(prev, steps(prev), resize)
    stop.current = () => {
      cancel()
      prev.remove()
      next.style.display = ""
      unsize()
      enterDelay("")
      delete next.dataset.phase
      stop.current = null
    }
  }
  /** Swaps in the card React rendered, when it is not the one shown. */
  const sync = useCallback(() => {
    if (!enabled) return
    // A leaving ghost is inert; the live card is the one React rendered.
    const next = dialog.current?.querySelector<HTMLElement>(":scope > .ww-modal:not([inert])") ?? null
    if (next === card.current) return
    const prev = card.current
    const from = size.current
    stop.current?.()
    detach.current?.()
    detach.current = null
    card.current = next
    if (!next) return
    if (prev && from && !prev.isConnected && !reducedMotion()) swap(prev, next, from)
    else {
      animate(next)
      if (!prev && next.dataset.dir === "up" && !reducedMotion()) open(next)
    }
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (!stop.current) animate(next)
    })
    observer.observe(next)
    detach.current = () => observer.disconnect()
  }, [dialog, enabled])
  useDomLayoutEffect(sync)
  useDomLayoutEffect(() => () => {
    detach.current?.()
    stop.current?.()
    card.current = null
    size.current = null
  }, [])
  return sync
}

/**
 * One overlay for a flow whose steps are sheets: a `Modal` rendered directly inside becomes the
 * overlay's card, so steps swap in place. The current step's onClose is the overlay's.
 */
export function ModalSteps({ label, className, dir, animateHeight = false, onAnimationEnd, children }: {
  label: string
  /** Added to every step's card. */
  className?: string
  /** The direction the current step swapped in from. */
  dir?: StepDir
  animateHeight?: boolean
  onAnimationEnd?: AnimationEventHandler<HTMLElement>
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement | null>(null)
  const sync = useCardSteps(dialog, animateHeight)
  const close = useRef<(() => void) | undefined>(undefined)
  const [closable, setClosable] = useState(false)
  const host = useMemo<StepsHost>(() => ({
    className,
    dir,
    setClose: (next) => {
      close.current = next
      setClosable(!!next)
    },
    sync,
  }), [className, dir, sync])
  return (
    <ModalFrame label={label} frameRef={dialog} onClose={closable ? () => close.current?.() : undefined} onAnimationEnd={onAnimationEnd}>
      <StepsContext.Provider value={host}>{children}</StepsContext.Provider>
    </ModalFrame>
  )
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
  step,
  stepDepth = 0,
  children,
}: {
  title?: string
  label?: string
  onBack?: () => void
  onClose?: () => void
  className?: string
  variant?: "create" | "bare" | "page"
  role?: "dialog" | "alertdialog"
  /** The sheet's own step: inside `ModalSteps`, a new step is a new card, swapped in by depth. */
  step?: string
  stepDepth?: number
  children: ReactNode
}) {
  const steps = useContext(StepsContext)
  const stepDir = useStepDir(step ?? "", stepDepth)
  useDomLayoutEffect(() => {
    steps?.setClose(onClose)
  })
  // A new step is a new card, keyed below; the host sees it only when told.
  useDomLayoutEffect(() => {
    steps?.sync()
  }, [steps, step])
  const card = (
    <div
      key={steps ? step : undefined}
      data-dir={(steps && (stepDir || steps.dir)) || undefined}
      tabIndex={-1}
      onClick={(e: MouseEvent) => e.stopPropagation()}
      className={[
        "ww-modal",
        variant === "create" && "ww-modal--create",
        variant === "page" && "ww-modal--page",
        className,
        steps?.className,
      ].filter(Boolean).join(" ")}
    >
      {variant === "create" && onBack && (
        <div className="ww-modal__back">
          <TopNavIconButton icon="chevron-left" ariaLabel="Back" onClick={onBack} />
        </div>
      )}
      {variant === "create" && onClose && (
        <div className="ww-modal__close">
          <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
        </div>
      )}
      {(variant === undefined || variant === "page") && (title || onBack || onClose) && (
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
      <StepsContext.Provider value={null}>{children}</StepsContext.Provider>
    </div>
  )
  if (steps) return card
  return (
    <ModalFrame
      label={label ?? title}
      role={role}
      onClose={onClose}
      overlayClassName={variant === "page" ? "ww-modal-overlay--page" : undefined}
    >
      {card}
    </ModalFrame>
  )
}

/** Large centered modal with a fixed header and footer. */
export function PageModal({ title, onClose, footer, children, fitContent = false }: {
  title: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
  fitContent?: boolean
}) {
  return (
    <Modal title={title} onClose={onClose} variant="page" className={fitContent ? "ww-modal--page-fit" : undefined}>
      <div className="ww-page-modal__content">{children}</div>
      {footer && <div className="ww-page-modal__footer">{footer}</div>}
    </Modal>
  )
}

export function PageModalPanel({
  children,
  className,
  scrollable = true,
}: {
  children: ReactNode
  className?: string
  scrollable?: boolean
}) {
  return (
    <div
      className={
        scrollable
          ? "ww-page-modal__surface"
          : "ww-page-modal__surface ww-page-modal__surface--fixed"
      }
    >
      <div className="ww-page-modal__scroll">
        <div className={["ww-page-modal__panel", className].filter(Boolean).join(" ")}>{children}</div>
      </div>
    </div>
  )
}
