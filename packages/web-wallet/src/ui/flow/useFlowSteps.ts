import { useState } from "react"
import type { AnimationEvent } from "react"
import styles from "./flow.module.css"

/** A step swap's direction, as `ModalSteps` puts it on the card (`data-dir`); "" for none yet. */
export type StepDir = "fwd" | "back" | "up" | "settle" | ""

/** The direction of a sheet's own step changes: forward to a deeper step, back to a shallower one. */
export function useStepDir(key: string, depth: number): StepDir {
  const [seen, setSeen] = useState<{ key: string; depth: number; dir: StepDir }>({
    key,
    depth,
    dir: "",
  })
  if (seen.key !== key) setSeen({ key, depth, dir: depth < seen.depth ? "back" : "fwd" })
  return seen.key === key ? seen.dir : depth < seen.depth ? "back" : "fwd"
}

/**
 * Picks the direction of each step swap in a flow card; `ModalSteps` runs the swap's phases. Steps
 * move sideways by depth, the picker rises over the step and sinks away. `key` and `depth` are the
 * step under the picker; `picking` is whether the picker is open.
 */
export function useFlowSteps({
  key,
  depth,
  picking,
  opensOnPicker = false,
}: {
  key: string
  depth: number
  picking: boolean
  /** The first step is a network and coin picker, so the flow opens as the picker rises. */
  opensOnPicker?: boolean
}): {
  /** The picker is open. */
  showPicker: boolean
  /** The shown step's key. */
  key: string
  /** The swap's direction, for `ModalSteps`. */
  dir: StepDir
} {
  const shown = picking ? "picker" : key
  const shownDepth = depth + (picking ? 1 : 0)
  const [seen, setSeen] = useState<{ key: string; depth: number; dir: StepDir }>({
    key: shown,
    depth: shownDepth,
    dir: picking || opensOnPicker ? "up" : "",
  })
  if (seen.key !== shown) {
    const dir: StepDir =
      shown === "picker"
        ? "up"
        : seen.key === "picker"
        ? "settle"
        : shownDepth < seen.depth
        ? "back"
        : "fwd"
    setSeen({ key: shown, depth: shownDepth, dir })
  }
  return { showPicker: picking, key: shown, dir: seen.dir }
}

const ENTRANCES: ReadonlySet<string> = new Set([
  styles["step-fwd"],
  styles["step-back"],
  styles["step-up"],
  styles["fade-in"],
])

/**
 * Keeps a finished entrance finished. A dialog shown again (the passkey prompt lowers every sheet
 * to non-modal) restarts every animation its content still declares; an inline `none` outlives that.
 */
export function settleStep(e: AnimationEvent<HTMLElement>): void {
  if (!ENTRANCES.has(e.animationName)) return
  ;(e.target as HTMLElement).style.animation = "none"
}
