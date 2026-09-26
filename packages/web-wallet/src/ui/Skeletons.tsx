import type { CSSProperties } from "react"
import { Shimmer } from "@obsidion/web-ds"

/** Neutral placeholder block sized like the content it stands in for. */
function SkeletonBlock({
  width,
  height,
  radius = 8,
  style,
}: {
  width: number | string
  height: number
  radius?: number
  style?: CSSProperties
}) {
  // --surface-strong lands at ~7% white once the shimmer dims it to 35% opacity.
  return (
    <div
      aria-hidden
      style={{ width, height, borderRadius: radius, background: "var(--surface-strong)", ...style }}
    />
  )
}

/** Placeholder mirroring an ActivityListRow while the feed hydrates. */
function ActivityRowSkeleton() {
  return (
    // The shimmer band fills the wrapper, so it needs the row's radius or it sweeps a square.
    <Shimmer style={{ borderRadius: "var(--radius-12)", overflow: "hidden" }}>
      <div className="zkm-activity-row">
        <div className="zkm-activity-row__top">
          <SkeletonBlock width={44} height={44} radius={22} />
          <div className="zkm-activity-row__who">
            <SkeletonBlock width={130} height={14} />
            <SkeletonBlock width={90} height={11} />
          </div>
          <div className="zkm-activity-row__right">
            <SkeletonBlock width={72} height={14} />
          </div>
        </div>
      </div>
    </Shimmer>
  )
}

export function ActivityListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <ActivityRowSkeleton key={i} />
      ))}
    </>
  )
}

/** Placeholder for the home hero balance (zkm-type-hero is 50px/1.15). */
export function BalanceSkeleton() {
  return (
    <Shimmer
      style={{ width: "fit-content", borderRadius: 12, overflow: "hidden", margin: "6px 0" }}
    >
      <SkeletonBlock width={190} height={46} radius={12} />
    </Shimmer>
  )
}
