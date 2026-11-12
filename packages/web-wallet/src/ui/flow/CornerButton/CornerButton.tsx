import { GlassCircleButton, Icon } from "@obsidion/web-ds"
import copy from "./CornerButton.copy"
import styles from "./CornerButton.module.css"

const GLYPH = "rgba(var(--ink-rgb), 0.6)"
/** The arrow fills its box and the × does not, so a smaller arrow matches the × by eye. */
const GLYPH_SIZE = { back: 12, close: 18 }

/** A flow card's back or close disc. */
export function CornerButton({
  kind,
  label,
  onClick,
}: {
  kind: "back" | "close"
  /** Defaults to "Back" or "Close". */
  label?: string
  onClick: () => void
}) {
  return (
    <GlassCircleButton
      size={30}
      className={styles.disc}
      ariaLabel={label ?? copy[kind]}
      onClick={onClick}
    >
      <Icon
        name={kind === "back" ? "arrow-left" : "x"}
        size={GLYPH_SIZE[kind]}
        // The arrow's viewBox is wider than tall; a square box keeps it centered.
        style={{ width: GLYPH_SIZE[kind], height: GLYPH_SIZE[kind] }}
        strokeWidth={2.2}
        color={GLYPH}
      />
    </GlassCircleButton>
  )
}
