import type { ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import styles from "./MethodOption.module.css"

const chevron = (size: number) => (
  <span className={styles.chevron}>
    <Icon name="chevron-right" size={size} color="var(--text-secondary)" />
  </span>
)

/**
 * A card with a chevron that opens a way to move funds. Plain, it is a row with an icon, the
 * recommended one framed; as a `banner` it is the page's entry banner.
 */
export function MethodOption({
  icon,
  title,
  body,
  recommended = false,
  banner = false,
  onOpen,
  testId,
  children,
}: {
  icon?: ReactNode
  title: string
  body: string
  recommended?: boolean
  banner?: boolean
  onOpen: () => void
  testId?: string
  children?: ReactNode
}) {
  if (banner)
    return (
      <button
        type="button"
        className={`zkm-btn-reset zkm-pressable ${styles.banner}`}
        data-testid={testId}
        onClick={onOpen}
      >
        <span className={styles.text}>
          <b>{title}</b>
          <span>{body}</span>
        </span>
        <span className={styles.foot}>
          {children}
          {chevron(10)}
        </span>
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
      {chevron(16)}
    </button>
  )
}
