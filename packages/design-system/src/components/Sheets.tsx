import type { CSSProperties, ReactNode } from "react"
import { GlassCircleButton } from "./GlassCircle"
import { GradientText } from "./GradientText"
import { Icon } from "./Icon"

export interface SheetDragHandleProps {
  /** White fill opacity. Default 0.3. */
  opacity?: number
  className?: string
}

/** Top-of-sheet drag-handle capsule, 64x4. */
export function SheetDragHandle({ opacity = 0.3, className }: SheetDragHandleProps) {
  return <div className={["zkm-sheet-handle", className].filter(Boolean).join(" ")} style={{ opacity }} />
}

export interface SheetSurfaceProps {
  /** "all" rounds every corner (floating card); "top" for bottom-docked sheets. Default "all". */
  corners?: "all" | "top"
  children: ReactNode
  className?: string
  style?: CSSProperties
}

/** Bottom-sheet surface: #212121 fill, 24px corners, drag handle overlaid top-center. */
export function SheetSurface({ corners = "all", children, className, style }: SheetSurfaceProps) {
  return (
    <div
      className={["zkm-sheet-surface", className].filter(Boolean).join(" ")}
      style={{ borderRadius: corners === "top" ? "24px 24px 0 0" : 24, ...style }}
    >
      {children}
      <SheetDragHandle className="zkm-sheet-surface__handle" />
    </div>
  )
}

export interface ConfirmationSheetHeaderProps {
  title: string
  /** Omit to hide the back button. */
  onClose?: () => void
}

/** Confirmation-sheet header: centered title with a back arrow in a 40px glass circle at the left. */
export function ConfirmationSheetHeader({ title, onClose }: ConfirmationSheetHeaderProps) {
  return (
    <div className="zkm-confirm-sheet-header">
      {onClose && (
        <GlassCircleButton onClick={onClose} ariaLabel="Back" className="zkm-confirm-sheet-header__back">
          <Icon name="arrow-left" size={16} color="#fff" />
        </GlassCircleButton>
      )}
      <span className="zkm-confirm-sheet-header__title">{title}</span>
    </div>
  )
}

export interface ConfirmationSheetShellProps {
  title: string
  onClose?: () => void
  children: ReactNode
  /** Primary CTA slot rendered at the bottom. */
  primaryAction: ReactNode
  className?: string
}

/** Chrome for confirmation bottom sheets: drag handle, header, content, primary action. */
export function ConfirmationSheetShell({ title, onClose, children, primaryAction, className }: ConfirmationSheetShellProps) {
  return (
    <div className={["zkm-confirm-sheet", className].filter(Boolean).join(" ")}>
      <SheetDragHandle opacity={0.35} className="zkm-confirm-sheet__handle" />
      <ConfirmationSheetHeader title={title} onClose={onClose} />
      <div className="zkm-confirm-sheet__content">{children}</div>
      {primaryAction}
    </div>
  )
}

export interface ConfirmationSheetSectionLabelProps {
  children: ReactNode
}

/** Muted caption labeling a section of a confirmation sheet (e.g. "To", "Details"). */
export function ConfirmationSheetSectionLabel({ children }: ConfirmationSheetSectionLabelProps) {
  return <div className="zkm-confirm-sheet-section-label">{children}</div>
}

export interface ConfirmationSheetPartyCardProps {
  name: string
  handle: string
  /** Amount or summary at the trailing edge. */
  trailingText: string
  /** Auxiliary badge after the name. */
  nameBadge?: string
  /** trailingText color. Default primary text. */
  trailingColor?: string
  trailingSubtitle?: string
  /** Avatar slot at the leading edge. */
  avatar?: ReactNode
  className?: string
}

/** Counterparty card in a confirmation sheet: avatar, gradient name + handle, trailing amount. */
export function ConfirmationSheetPartyCard({
  name,
  handle,
  trailingText,
  nameBadge,
  trailingColor,
  trailingSubtitle,
  avatar,
  className,
}: ConfirmationSheetPartyCardProps) {
  return (
    <div className={["zkm-confirm-party-card", className].filter(Boolean).join(" ")}>
      {avatar}
      <span className="zkm-confirm-party-card__id">
        <span className="zkm-confirm-party-card__name-line">
          <GradientText size={16} weight={600} style={{ letterSpacing: 0.3 }}>
            {name}
          </GradientText>
          {nameBadge && <span className="zkm-confirm-party-card__badge">{nameBadge}</span>}
        </span>
        <span className="zkm-confirm-party-card__handle">{handle}</span>
      </span>
      <span className="zkm-row-spacer" />
      <span className="zkm-confirm-party-card__trailing">
        <span className="zkm-confirm-party-card__amount" style={trailingColor ? { color: trailingColor } : undefined}>
          {trailingText}
        </span>
        {trailingSubtitle && <span className="zkm-confirm-party-card__amount-sub">{trailingSubtitle}</span>}
      </span>
    </div>
  )
}

export interface ConfirmationSheetDetailRowProps {
  label: ReactNode
  value: ReactNode
}

/** Label/value line in a confirmation sheet (fee, total, network …). */
export function ConfirmationSheetDetailRow({ label, value }: ConfirmationSheetDetailRowProps) {
  return (
    <div className="zkm-confirm-detail-row">
      <span className="zkm-confirm-detail-row__label">{label}</span>
      <span className="zkm-confirm-detail-row__value">{value}</span>
    </div>
  )
}
