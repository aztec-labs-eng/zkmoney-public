import type { ReactNode } from "react"
import { GlassCircleButton } from "./GlassCircle"
import { Icon } from "./Icon"

export interface TopNavBarProps {
  /** Plain title, or use `titleNode` for a custom center (e.g. TopNavBarStackedTitle). */
  title?: string
  titleNode?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  className?: string
}

/** Centered-title top nav for tab screens; title stays true-center regardless of slot widths. */
export function TopNavBar({ title, titleNode, leading, trailing, className }: TopNavBarProps) {
  return (
    <div className={["zkm-top-nav", className].filter(Boolean).join(" ")}>
      <div className="zkm-top-nav__center">{titleNode ?? <span className="zkm-top-nav__title">{title}</span>}</div>
      <div className="zkm-top-nav__slots">
        <div>{leading}</div>
        <div>{trailing}</div>
      </div>
    </div>
  )
}

/** Two-line center title: name over muted @handle. */
export function TopNavBarStackedTitle({ name, handle }: { name: string; handle: string }) {
  return (
    <span className="zkm-top-nav__stacked">
      <span className="zkm-top-nav__title">{name}</span>
      <span className="zkm-top-nav__handle">{handle}</span>
    </span>
  )
}

/** Glass-circle icon button sized for nav bars. */
export function TopNavIconButton({
  icon,
  onClick,
  ariaLabel,
}: {
  icon: string
  onClick?: () => void
  ariaLabel?: string
}) {
  return (
    <GlassCircleButton onClick={onClick ?? (() => {})} ariaLabel={ariaLabel ?? icon}>
      <Icon name={icon} size={16} color="#fff" />
    </GlassCircleButton>
  )
}

export interface ScreenNavBarProps {
  title: string
  subtitle?: string
  /** Leading glass button glyph. Default "back". */
  leadingIcon?: "back" | "close"
  /** Omit to hide the leading button (title position is preserved). */
  onLeading?: () => void
  titleAlignment?: "center" | "leading"
  trailing?: ReactNode
  className?: string
}

/** Standard nav bar for full-screen/modal screens: glass back/close button + title (+subtitle) + trailing slot. */
export function ScreenNavBar({
  title,
  subtitle,
  leadingIcon = "back",
  onLeading,
  titleAlignment = "center",
  trailing,
  className,
}: ScreenNavBarProps) {
  const leadingButton = onLeading ? (
    <GlassCircleButton onClick={onLeading} ariaLabel={leadingIcon === "back" ? "Back" : "Close"}>
      <Icon name={leadingIcon === "back" ? "arrow-left" : "x"} size={leadingIcon === "back" ? 12 : 14} color="#fff" />
    </GlassCircleButton>
  ) : null
  const titleStack = (
    <span className="zkm-screen-nav__titles" style={{ alignItems: titleAlignment === "leading" ? "flex-start" : "center" }}>
      <span className="zkm-top-nav__title">{title}</span>
      {subtitle && <span className="zkm-top-nav__handle">{subtitle}</span>}
    </span>
  )
  if (titleAlignment === "leading") {
    return (
      <div className={["zkm-screen-nav zkm-screen-nav--leading", className].filter(Boolean).join(" ")}>
        {leadingButton}
        {titleStack}
        <span className="zkm-row-spacer" />
        {trailing}
      </div>
    )
  }
  return (
    <div className={["zkm-screen-nav", className].filter(Boolean).join(" ")}>
      <div className="zkm-screen-nav__center">{titleStack}</div>
      <div className="zkm-top-nav__slots">
        <div>{leadingButton}</div>
        <div>{trailing}</div>
      </div>
    </div>
  )
}
