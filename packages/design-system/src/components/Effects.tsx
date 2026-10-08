import { useId, type CSSProperties, type ReactNode } from "react"
import { Icon } from "./Icon"

export interface ShimmerProps {
  /** false renders children untouched at full opacity. Default true. */
  active?: boolean
  children: ReactNode
  className?: string
  style?: CSSProperties
}

/**
 * Loading shimmer: dims its children to 35% opacity and sweeps a white
 * highlight band across them every 1.4s while active.
 */
export function Shimmer({ active = true, children, className, style }: ShimmerProps) {
  return (
    <div
      className={["zkm-shimmer", active ? "zkm-shimmer--active" : "", className]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      <div className="zkm-shimmer__content">{children}</div>
      {active && <div className="zkm-shimmer__band" />}
    </div>
  )
}

export interface DoubleCheckIconProps {
  /** Default success green #56E79D. */
  color?: string
  size?: number
}

/** "✓✓" delivered/settled marker (MicroDoubleCheckIconShape). */
export function DoubleCheckIcon({ color = "#56E79D", size = 14 }: DoubleCheckIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        fill={color}
        d="M7.55551 4.84156C7.71641 4.60082 8.04199 4.53555 8.28305 4.69606C8.5243 4.85689 8.58939 5.18332 8.42855 5.42457L4.92855 10.6746C4.84131 10.8053 4.70021 10.8905 4.54379 10.906C4.38736 10.9215 4.23214 10.8657 4.12094 10.7546L2.02035 8.65406C1.81576 8.44904 1.81556 8.11678 2.02035 7.91188C2.22538 7.70685 2.55849 7.70685 2.76352 7.91188L4.41 9.55934L7.55551 4.84156Z"
      />
      <path
        fill={color}
        d="M11.289 4.84154C11.4499 4.60081 11.7755 4.53549 12.0165 4.69604C12.2578 4.85687 12.3229 5.1833 12.162 5.42455L8.66202 10.6746C8.5748 10.8053 8.43366 10.8905 8.27726 10.906C8.12084 10.9215 7.96561 10.8657 7.8544 10.7546L5.75382 8.65404C5.54917 8.44901 5.54897 8.11677 5.75382 7.91186C5.95884 7.70683 6.29196 7.70683 6.49698 7.91186L8.14347 9.55932L11.289 4.84154Z"
      />
    </svg>
  )
}

export interface SpinnerProps {
  size?: number
  /** Default secondary text color. */
  color?: string
  /** Seconds per revolution. Default 1.4. */
  period?: number
}

/** Open-arc pending spinner: 80% stroke arc with round caps, rotating continuously. */
export function Spinner({
  size = 10,
  color = "var(--text-secondary)",
  period = 1.4,
}: SpinnerProps) {
  const strokeWidth = Math.max(1.5, size * 0.12)
  const r = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * r
  return (
    <svg
      className="zkm-spinner-icon"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      style={{ animationDuration: `${period}s` }}
      aria-label="Loading"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${circumference * 0.8} ${circumference * 0.2}`}
      />
    </svg>
  )
}

export interface ProgressSpinnerProps {
  /** Share done, 0–1. */
  progress: number
  size?: number
  /** Default secondary text color. */
  color?: string
}

/** `Spinner`'s stroke as a determinate ring: a faint track filled clockwise from the top. */
export function ProgressSpinner({
  progress,
  size = 10,
  color = "var(--text-secondary)",
}: ProgressSpinnerProps) {
  const strokeWidth = Math.max(1.5, size * 0.12)
  const r = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * r
  const done = Math.min(1, Math.max(0, progress))
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(done * 100)}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeOpacity={0.25}
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${circumference * done} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 300ms ease-out" }}
      />
    </svg>
  )
}

const GRADIENT_SPINNER_ARC =
  "M40 20C40 23.9556 38.827 27.8224 36.6294 31.1114C34.4318 34.4004 31.3082 36.9638 27.6537 38.4776C23.9991 39.9913 19.9778 40.3874 16.0982 39.6157C12.2186 38.844 8.65491 36.9392 5.85786 34.1421C3.06081 31.3451 1.156 27.7814 0.384294 23.9018C-0.38741 20.0222 0.00865672 16.0009 1.52241 12.3463C3.03616 8.69181 5.59961 5.56824 8.8886 3.37061C12.1776 1.17298 16.0444 0 20 0V4C16.8355 4 13.7421 4.93838 11.1109 6.69649C8.47969 8.45459 6.42893 10.9534 5.21793 13.8771C4.00693 16.8007 3.69007 20.0177 4.30744 23.1214C4.9248 26.2251 6.44865 29.0761 8.68629 31.3137C10.9239 33.5513 13.7749 35.0752 16.8786 35.6926C19.9823 36.3099 23.1993 35.9931 26.1229 34.7821C29.0466 33.5711 31.5454 31.5203 33.3035 28.8891C35.0616 26.2579 36 23.1645 36 20H40Z"

export interface GradientSpinnerProps {
  /** Default 40 — sized for modal / hero loading states. */
  size?: number
  /** Seconds per revolution. Default 1.4. */
  period?: number
}

/** Three-quarter purple→blue filled arc; rotates via the spinner keyframes. */
export function GradientSpinner({ size = 40, period = 1.4 }: GradientSpinnerProps) {
  const gradId = `zkm-spinner-grad-${useId().replace(/:/g, "")}`
  return (
    <svg
      className="zkm-spinner-icon"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      style={{ animationDuration: `${period}s` }}
      aria-label="Loading"
    >
      <defs>
        <linearGradient id={gradId} x1="20" y1="0" x2="20" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7C3AED" />
          <stop offset="1" stopColor="#2D6BFF" />
        </linearGradient>
      </defs>
      <path d={GRADIENT_SPINNER_ARC} fill={`url(#${gradId})`} />
    </svg>
  )
}

export interface GlassRowCardProps {
  children: ReactNode
  /** Gap between rows. Default 16. */
  rowSpacing?: number
  /** Inner padding. Default "16px 20px". */
  padding?: number | string
  /** Corner radius. Default 12. */
  radius?: number
  className?: string
  style?: CSSProperties
}

/** Translucent card (white @ 5%) stacking rows vertically — settings groups, detail lists. */
export function GlassRowCard({
  children,
  rowSpacing = 16,
  padding = "16px 20px",
  radius = 12,
  className,
  style,
}: GlassRowCardProps) {
  return (
    <div
      className={["zkm-glass-row-card", className].filter(Boolean).join(" ")}
      style={{ gap: rowSpacing, padding, borderRadius: radius, ...style }}
    >
      {children}
    </div>
  )
}

export interface TitledGlassRowCardProps extends GlassRowCardProps {
  title: string
}

/** GlassRowCard with a muted caption title above it. */
export function TitledGlassRowCard({
  title,
  children,
  className,
  ...rest
}: TitledGlassRowCardProps) {
  return (
    <div className={["zkm-titled-glass-row-card", className].filter(Boolean).join(" ")}>
      <span className="zkm-titled-glass-row-card__title">{title}</span>
      <GlassRowCard {...rest}>{children}</GlassRowCard>
    </div>
  )
}

export interface CopyableLinkRowProps {
  url: string
  copied?: boolean
  onCopy: () => void
  ariaLabel?: string
  className?: string
  style?: CSSProperties
}

/** Truncated URL in a glass row — tap copies. Copy/share CTAs stay with the caller. */
export function CopyableLinkRow({
  url,
  copied = false,
  onCopy,
  ariaLabel = "Copy link",
  className,
  style,
}: CopyableLinkRowProps) {
  return (
    <button
      type="button"
      className={["zkm-btn-reset zkm-pressable", className].filter(Boolean).join(" ")}
      style={{ width: "100%", display: "block", textAlign: "inherit", ...style }}
      aria-label={ariaLabel}
      onClick={onCopy}
    >
      <GlassRowCard>
        <div className="zkm-copyable-link-row">
          <Icon name="link" size={18} color="var(--text-secondary)" />
          <span className="zkm-copyable-link-row__url">{url}</span>
          <Icon name="copy" size={16} color={copied ? "var(--accent-green)" : "#fff"} />
        </div>
      </GlassRowCard>
    </button>
  )
}
