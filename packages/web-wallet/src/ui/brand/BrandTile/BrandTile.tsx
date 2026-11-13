import appIconGlow from "../../../assets/home/app-icon-glow.svg"
import "../../shell.css"
import copy from "../brand.copy"

/** A square tile with a glow under the "zk." / "money" wordmark. */
export function BrandTile({ className }: { className?: string }) {
  return (
    <span className={className ? `ww-brand__tile ${className}` : "ww-brand__tile"} aria-hidden>
      <img src={appIconGlow} alt="" />
      <span>{copy.tile.zk}</span>
      <span>{copy.tile.money}</span>
    </span>
  )
}
