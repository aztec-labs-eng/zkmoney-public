import type { CSSProperties } from "react"
import { BrandTile } from "../BrandTile/BrandTile"
import styles from "./BrandIcon.module.css"

/** The brand tile, rounded. */
export function BrandIcon({ size = 32 }: { size?: number }) {
  return (
    <span
      className={styles.icon}
      style={{ "width": size, "height": size, "--brand-scale": size / 44 } as CSSProperties}
    >
      <BrandTile className={styles.tile} />
    </span>
  )
}
