import type { CSSProperties } from "react"

/** White shield-with-eye glyph standing in for the app's "privacy-shield-eye" raster asset. */
function ShieldEyeGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        fill="#fff"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 1.5 L20.5 4.7 V11 C20.5 16.4 17 20.6 12 22.5 C7 20.6 3.5 16.4 3.5 11 V4.7 Z
           M12 7.9 C14.9 7.9 17.1 9.7 18.1 11.2 C17.1 12.7 14.9 14.5 12 14.5 C9.1 14.5 6.9 12.7 5.9 11.2 C6.9 9.7 9.1 7.9 12 7.9 Z"
      />
      <circle cx="12" cy="11.2" r="1.9" fill="#fff" />
    </svg>
  )
}

export interface OnchainPrivacyBannerProps {
  title?: string
  body?: string
  className?: string
  style?: CSSProperties
}

/**
 * "Private by default" gradient info banner shown on receive-via-link screens:
 * shield-with-eye glyph beside a title + one-line explainer on the brand gradient.
 */
export function OnchainPrivacyBanner({
  title = "Private by default",
  body = "This is a one-time unique address. It can't be linked to your zk.money @tag.",
  className,
  style,
}: OnchainPrivacyBannerProps) {
  return (
    <div className={["zkm-privacy-banner", className].filter(Boolean).join(" ")} style={style}>
      <ShieldEyeGlyph size={72} />
      <span className="zkm-privacy-banner__text">
        <span className="zkm-privacy-banner__title">{title}</span>
        <span className="zkm-privacy-banner__body">{body}</span>
      </span>
    </div>
  )
}
