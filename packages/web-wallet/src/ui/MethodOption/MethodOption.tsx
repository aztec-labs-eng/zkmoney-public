import type { ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import glowBlue from "../../assets/deposit/glow-blue.svg"
import glowGreen from "../../assets/deposit/glow-green.svg"
import glowPurple from "../../assets/deposit/glow-purple.svg"
import styles from "./MethodOption.module.css"

const GLOWS = { blue: glowBlue, green: glowGreen, purple: glowPurple } as const

/**
 * A card that opens a way to move funds. Plain, it is a row with an icon and a chevron, the
 * recommended one framed; with a `glow` it is the page's entry banner, the glow naming the kind.
 */
export function MethodOption({
  icon,
  title,
  body,
  recommended = false,
  glow,
  onOpen,
  testId,
  children,
}: {
  icon?: ReactNode
  title: string
  body: string
  recommended?: boolean
  glow?: keyof typeof GLOWS
  onOpen: () => void
  testId?: string
  children?: ReactNode
}) {
  if (glow)
    return (
      <button
        type="button"
        className={`zkm-btn-reset zkm-pressable ${styles.banner}`}
        data-testid={testId}
        onClick={onOpen}
      >
        <img className={styles.glow} src={GLOWS[glow]} alt="" />
        <span className={styles.text}>
          <b>{title}</b>
          <span>{body}</span>
        </span>
        {children}
      </button>
    )
  return (
    <button
      type="button"
      className={
        `zkm-btn-reset zkm-pressable ww-deposit__connect ${styles.row}` +
        (recommended ? " ww-paymethod--best" : "")
      }
      data-testid={testId}
      onClick={onOpen}
    >
      <span className={`ww-deposit__connect-icon ${styles.icon}`}>
        {icon}
      </span>
      <span className="ww-deposit__connect-text">
        <b>{title}</b>
        <span className={styles.body}>{body}</span>
        {children}
      </span>
      <span className={styles.chevron}>
        <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
      </span>
    </button>
  )
}
