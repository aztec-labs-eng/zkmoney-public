import { useId, type AnimationEvent, type ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import styles from "./RingLoader.module.css"

/**
 * Bridging: the front and back faces flip. Arriving: the landing coin breathes. Arrived and failed:
 * stopped, marked with a check or an alert.
 */
export type RingPhase = "bridging" | "arriving" | "arrived" | "failed"

/** The token size the ring's faces are drawn at. */
export const RING_TOKEN_SIZE = 72

/** A transfer's progress ring. Every layer stays mounted so a phase change transitions. */
export function RingLoader({
  phase,
  next,
  onLanded,
  front,
  back,
  landing,
}: {
  phase: RingPhase
  /** The phase the ring heads to once its motion lands. */
  next?: RingPhase
  /** Each time the flip lands on its front face or the breathe on its first size, with `next`. */
  onLanded?: (phase: RingPhase) => void
  /** The flipper's two faces, drawn at `RING_TOKEN_SIZE`. */
  front: ReactNode
  back: ReactNode
  /** The landing icon, drawn at `RING_TOKEN_SIZE`. */
  landing: ReactNode
}) {
  const gradient = useId()
  // The flipper's turns bubble to the center; each element reports its own.
  const land = (e: AnimationEvent) => {
    if (e.target === e.currentTarget) onLanded?.(next ?? phase)
  }
  return (
    <div className={styles.ring} data-phase={phase} aria-hidden>
      <span className={styles.ripple} />
      <span className={styles.ripple} />
      <svg className={styles.track} viewBox="0 0 136 136">
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className={styles.stopA} />
            <stop offset="1" className={styles.stopB} />
          </linearGradient>
        </defs>
        <circle className={styles.rail} cx="68" cy="68" r="62" />
        <circle className={styles.arc} cx="68" cy="68" r="62" stroke={`url(#${gradient})`} />
      </svg>
      <div className={styles.center} onAnimationIteration={land}>
        <span className={`${styles.token} ${styles.flipper}`} onAnimationIteration={land}>
          <span className={styles.face}>{front}</span>
          <span className={`${styles.face} ${styles.back}`}>{back}</span>
        </span>
        <span className={`${styles.token} ${styles.dest}`}>
          <span className={styles.coin}>{landing}</span>
          <span className={`${styles.mark} ${styles.check}`}>
            <Icon name="check" size={14} color="var(--surface-sheet)" strokeWidth={3} />
          </span>
          <span className={`${styles.mark} ${styles.alert}`}>
            <Icon name="alert-circle" size={20} color="var(--accent-pink)" />
          </span>
        </span>
      </div>
    </div>
  )
}
