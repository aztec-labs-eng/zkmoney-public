import { useEffect, useLayoutEffect } from "react"
import type { DependencyList, EffectCallback } from "react"

/**
 * An effect for DOM-only work: focus, DOM or `window` listeners, observers, measuring,
 * `document.title`, the screen wake lock and the camera. It never fetches, writes a store or runs
 * a timer that drives app work; that work belongs in a screen flow, a runtime task or a store.
 */
export function useDomEffect(effect: EffectCallback, deps?: DependencyList): void {
  useEffect(effect, deps)
}

/** `useDomEffect` with layout timing: the DOM work runs before the browser paints. */
export function useDomLayoutEffect(effect: EffectCallback, deps?: DependencyList): void {
  useLayoutEffect(effect, deps)
}
