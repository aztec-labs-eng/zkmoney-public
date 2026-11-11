import type { ReactNode } from "react"
import { fmt } from "../../../lib/fmt"
import { ChainIcon } from "../../ChainIcon/ChainIcon"
import flowCopy from "../flow.copy"
import flowStyles from "../flow.module.css"
import copy from "./Crumb.copy"
import styles from "./Crumb.module.css"

/**
 * The picked network and coin over a step. Unlocked it opens the picker; locked it only names them.
 */
export function Crumb({
  network,
  coin,
  coinIcon,
  locked,
  onOpen,
  testId = "deposit-crumb",
}: {
  network: { chainId: number; name: string }
  coin: string
  coinIcon: ReactNode
  locked: boolean
  onOpen: () => void
  testId?: string
}) {
  if (locked)
    return (
      <div className={flowStyles.crumbBar}>
        <p className={styles.crumbLocked}>{fmt(copy.locked, { network: network.name, coin })}</p>
      </div>
    )
  return (
    <div className={flowStyles.crumbBar}>
      <button
        type="button"
        className={`zkm-btn-reset ${styles.crumb}`}
        data-testid={testId}
        aria-haspopup="dialog"
        aria-label={copy.change}
        onClick={onOpen}
      >
        <span className={styles.crumbCoin}>
          {coinIcon}
          <span className={styles.crumbChain}>
            <ChainIcon chainId={network.chainId} name={network.name} size={10} />
          </span>
        </span>
        <span className={styles.crumbText}>
          {fmt(flowCopy.crumb.label, { coin, network: network.name })}
        </span>
      </button>
    </div>
  )
}
