import type { CSSProperties, ReactNode } from "react"

export interface ZkMoneyRootProps {
  children?: ReactNode
  /** Remove the default 16px padding. */
  flush?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * Dark app canvas — the root wrapper every zk.money surface sits on.
 * Applies the #181818 background, primary text color, and Sen body font.
 * Wrap your whole screen (or preview) in this; components are designed for
 * dark surfaces and are illegible on white.
 */
export function ZkMoneyRoot({ children, flush = false, className, style }: ZkMoneyRootProps) {
  return (
    <div
      className={["zkm-root", className].filter(Boolean).join(" ")}
      style={{ padding: flush ? 0 : 16, ...style }}
    >
      {children}
    </div>
  )
}
