import { HoldingRow, Shimmer, SkeletonBlock } from "@obsidion/web-ds"
import { useStore } from "@obsidion/front-core"
import { useSession } from "../../../session/session"
import { useActivityHost } from "../../../ui/activity/ActivityDetailHost/ActivityDetailHost"
import { COIN, HoldingLineRow } from "../HoldingLineRow/HoldingLineRow"
import { selectHoldingRows } from "../holdingRows"
import copy from "./SavingsHoldings.copy"
import styles from "./SavingsHoldings.module.css"

const Placeholder = () => (
  <HoldingRow
    icon={<SkeletonBlock width={COIN} height={COIN} radius={COIN / 2} />}
    title={<SkeletonBlock width={48} height={14} />}
    subtitle={<SkeletonBlock width={110} height={12} />}
    value={<SkeletonBlock width={56} height={14} />}
  />
)

/** "You're earning on": each Savings line's asset, yield, worth and rate; a row opens its details. */
export function SavingsHoldings({ onOpen }: { onOpen: (holdingId: string) => void }) {
  const { savingsLine, device, page } = useSession()
  const savings = useStore(savingsLine)
  const hidden = useStore(device, (s) => s.hideBalances)
  const { arriving } = useActivityHost().feed
  const rows = selectHoldingRows(savings, page.config.holdingCopy, arriving.vaultSwapping)
  return (
    <section
      className={styles.card}
      data-testid="savings-holdings"
      data-hydrated={rows.length > 0 || undefined}
      aria-busy={rows.length === 0}
    >
      <h3>{copy.earningOn}</h3>
      {rows.length > 0 ? (
        rows.map((row) => (
          <HoldingLineRow key={row.id} row={row} hidden={hidden} onClick={() => onOpen(row.id)} />
        ))
      ) : (
        <Shimmer className={styles.rows}>
          {(savings.lines.length > 0 ? savings.lines : [undefined]).map((_, i) => (
            <Placeholder key={i} />
          ))}
        </Shimmer>
      )}
    </section>
  )
}
