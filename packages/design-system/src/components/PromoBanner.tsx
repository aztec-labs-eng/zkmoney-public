import { Icon } from "./Icon"

export interface PromoBannerProps {
  /** Leading icon name. Default "gift". */
  icon?: string
  title: string
  /** CTA row label (e.g. "Invite friends"). */
  ctaLabel: string
  onCta?: () => void
  onDismiss?: () => void
  className?: string
}

/**
 * Brand-gradient promo banner (e.g. "Invite friends and earn up to $50."):
 * icon + title with a dismiss ✕, darker CTA footer row with a chevron.
 */
export function PromoBanner({ icon = "gift", title, ctaLabel, onCta, onDismiss, className }: PromoBannerProps) {
  return (
    <div className={["zkm-promo", className].filter(Boolean).join(" ")}>
      <div className="zkm-promo__body">
        <span className="zkm-promo__icon">
          <Icon name={icon} size={16} color="#fff" />
        </span>
        <span className="zkm-promo__title">{title}</span>
        {onDismiss && (
          <button type="button" className="zkm-btn-reset zkm-promo__dismiss" onClick={onDismiss} aria-label="Dismiss">
            <Icon name="x" size={12} strokeWidth={2.5} />
          </button>
        )}
      </div>
      <button type="button" className="zkm-btn-reset zkm-promo__cta" onClick={onCta}>
        <span>{ctaLabel}</span>
        <Icon name="chevron-right" size={12} />
      </button>
    </div>
  )
}
