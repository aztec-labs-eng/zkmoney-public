import { Children, type ReactNode } from "react"
import styles from "./IconStack.module.css"

/**
 * Overlapping round icons: the chains a bridge serves, or the coins an address takes. `front` puts
 * the first icon on top, each covering its right neighbor; `small` is the 16px disc.
 */
export function IconStack({
  children,
  front = false,
  small = false,
}: {
  children: ReactNode
  front?: boolean
  small?: boolean
}) {
  const cls = [styles.stack, front && styles.front, small && styles.small]
  return (
    <span className={cls.filter(Boolean).join(" ")}>
      {/* Laid out right to left, so the first icon paints last, over the rest. */}
      {front ? Children.toArray(children).reverse() : children}
    </span>
  )
}
