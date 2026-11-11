import { Shimmer, SkeletonBlock } from "@obsidion/web-ds"

/** Placeholder mirroring an ActivityListRow while the feed hydrates. */
function ActivityRowSkeleton() {
  return (
    <Shimmer>
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

/**
 * Placeholder for a hero figure, by default the home balance (zkm-type-hero is 50px/1.15). The
 * margins make up the figure's line height, so the figure lands without a jump.
 */
export function BalanceSkeleton({ width = 190, height = 46 }: { width?: number; height?: number }) {
  return (
    <Shimmer style={{ width: "fit-content", margin: "6px 0" }}>
      <SkeletonBlock width={width} height={height} radius={12} />
    </Shimmer>
  )
}

/** Placeholder for a one-line text value, e.g. a detail row's value. */
export function TextSkeleton({ width = 120 }: { width?: number }) {
  return (
    <Shimmer style={{ width: "fit-content" }}>
      <SkeletonBlock width={width} height={14} />
    </Shimmer>
  )
}
