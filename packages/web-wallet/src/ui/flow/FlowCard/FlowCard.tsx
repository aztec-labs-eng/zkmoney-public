import type { ReactNode } from "react"
import { GradientText } from "@obsidion/web-ds"
import { Modal } from "../../Modal"
import { CornerButton } from "../CornerButton/CornerButton"
import flowStyles from "../flow.module.css"
import styles from "./FlowCard.module.css"

/**
 * One step of a flow inside `ModalSteps`: the sheet with its close button, and back where set. With
 * a `title`, the buttons and title sit in a header bar over an unpadded body.
 */
export function FlowCard({
  label,
  title,
  titleAside,
  onBack,
  onClose,
  crumb,
  className,
  children,
}: {
  label: string
  title?: string
  /** Beside the bar title; it shrinks before the title does. */
  titleAside?: ReactNode
  onBack?: () => void
  onClose: () => void
  /** Shown between the corner buttons, over the step. */
  crumb?: ReactNode
  className?: string
  children: ReactNode
}) {
  const cls = [
    "ww-deposit-warning ww-deposit-sheet",
    flowStyles.step,
    title && flowStyles.barred,
    className,
  ]
  return (
    <Modal variant="bare" label={label} className={cls.filter(Boolean).join(" ")} onClose={onClose}>
      {title ? (
        <div className={flowStyles.bar}>
          {onBack && <CornerButton kind="back" onClick={onBack} />}
          {titleAside ? (
            <div className={styles.barHead}>
              <h2 className={styles.barTitle}>{title}</h2>
              {titleAside}
            </div>
          ) : (
            <h2 className={styles.barTitle}>{title}</h2>
          )}
          <CornerButton kind="close" onClick={onClose} />
        </div>
      ) : (
        <>
          {onBack && (
            <div className="ww-deposit-warning__back">
              <CornerButton kind="back" onClick={onBack} />
            </div>
          )}
          <div className="ww-deposit-warning__close">
            <CornerButton kind="close" onClick={onClose} />
          </div>
          {crumb}
        </>
      )}
      {children}
    </Modal>
  )
}

/** A step's title; `below` takes the subtitle's place. */
export function FlowHead({
  title,
  subtitle,
  below,
}: {
  title: string
  subtitle?: string
  below?: ReactNode
}) {
  return (
    <div className="ww-deposit-sheet__head">
      <GradientText size={24} weight={700}>
        {title}
      </GradientText>
      {below ?? (subtitle && <p>{subtitle}</p>)}
    </div>
  )
}
