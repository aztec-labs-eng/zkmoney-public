import type { CSSProperties } from "react"
import { avatarColors } from "../avatarPalette"

export interface GradientInitialAvatarProps {
  name: string
  /** Gradient pair; omit to derive deterministically from `name`. */
  colors?: readonly [string, string]
  size?: number
  /** White "story" ring (current user). */
  ringed?: boolean
  className?: string
  style?: CSSProperties
}

/** Gradient circle avatar with centered uppercase initial; optional white ring.
 *  One element: the gradient is clipped to the content box (padding = the ring
 *  inset) and the ring is an inset box-shadow on the same box, so they can
 *  never drift apart. */
export function GradientInitialAvatar({
  name,
  colors,
  size = 44,
  ringed = false,
  className,
  style,
}: GradientInitialAvatarProps) {
  const [from, to] = colors ?? avatarColors(name)
  const ringWidth = size * 0.039
  const ringInset = ringed ? Math.max(2, size * 0.05) : 0
  const fontSize = (size - ringInset * 2) * 0.42
  const initial = (name.trim().replace(/^@/, "")[0] ?? "?").toUpperCase()
  return (
    <div
      className={["zkm-avatar", "zkm-avatar__disc", className].filter(Boolean).join(" ")}
      style={{
        width: size,
        height: size,
        boxSizing: "border-box",
        padding: ringInset,
        backgroundImage: `linear-gradient(135deg, ${from} 0%, ${to} 100%)`,
        backgroundClip: "content-box",
        boxShadow: ringed ? `inset 0 0 0 ${ringWidth}px #fff` : undefined,
        fontSize,
        ...style,
      }}
    >
      {initial}
    </div>
  )
}

export interface StoryRingAvatarProps {
  name: string
  /** Avatar disc diameter (ring adds to it). Default 48. */
  size?: number
  ringWidth?: number
  ringGap?: number
  /** Colored ring when true (default), white when false. */
  hasUnviewedStory?: boolean
  /** Ring color when unviewed. Default gold; Home top bar uses #A000FF. */
  unviewedRingColor?: string
  showNotificationDot?: boolean
  notificationDotColor?: string
  className?: string
}

/** Circular initial avatar with an outer story ring and optional top-right notification dot.
 *  Ring and disc share one element (gradient clipped to the content box, ring as
 *  an inset box-shadow); only the dot is a separate positioned child. */
export function StoryRingAvatar({
  name,
  size = 48,
  ringWidth = 2,
  ringGap = 2,
  hasUnviewedStory = true,
  unviewedRingColor = "#EED04E",
  showNotificationDot = false,
  notificationDotColor = "#F1F332",
  className,
}: StoryRingAvatarProps) {
  const outer = size + (ringWidth + ringGap) * 2
  const dot = Math.max(6, size * 0.18)
  const initial = (name.trim().replace(/^@/, "")[0] ?? "?").toUpperCase()
  return (
    <div
      className={["zkm-story-avatar", "zkm-avatar__disc", className].filter(Boolean).join(" ")}
      style={{
        width: outer,
        height: outer,
        boxSizing: "border-box",
        padding: ringWidth + ringGap,
        background: "linear-gradient(135deg, #9907FF 0%, #2E6DFE 100%)",
        backgroundClip: "content-box",
        boxShadow: `inset 0 0 0 ${ringWidth}px ${hasUnviewedStory ? unviewedRingColor : "#fff"}`,
        fontSize: size * 0.42,
      }}
    >
      {initial}
      {showNotificationDot && (
        <span
          className="zkm-story-avatar__dot"
          style={{ width: dot, height: dot, background: notificationDotColor }}
        />
      )}
    </div>
  )
}
