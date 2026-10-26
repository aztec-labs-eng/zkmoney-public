const CELL = { gridArea: "1 / 1" } as const
const HIDDEN_CELL = { ...CELL, visibility: "hidden" } as const

/**
 * Copy whose wording waits on a read: every variant sits in one cell, so the box always takes the
 * tallest one's height, and only `shown` is visible. Nothing shows while `shown` is undefined.
 */
export function StableCopy({ variants, shown }: { variants: readonly string[]; shown?: number }) {
  return (
    <span style={{ display: "grid" }}>
      {variants.map((text, i) => (
        <span
          key={i}
          style={i === shown ? CELL : HIDDEN_CELL}
          aria-hidden={i !== shown || undefined}
        >
          {text}
        </span>
      ))}
    </span>
  )
}
