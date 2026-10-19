/**
 * One upgrade as one sheet: what reaches the balance, then a row per batch with its figure and
 * where it is. A row opens the batch's deposit, where its recovery lives, or the batch itself
 * before its deposit is seen.
 */
import { Fragment } from "react"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { GradientText, Icon, type StatusBadgeStyle } from "@obsidion/web-ds"
import { formatUnits } from "viem"
import { upgradeBatchFigure } from "@obsidion/front-core"
import { whenLabel } from "../detailRows"
import { usdFigure } from "../format"
import { Modal } from "../Modal"
import { depositStatus } from "./DepositDetailModal"
import { DepositFact } from "./DepositFact"
import { DepositStatusValue } from "./DepositStatusValue"
import type { UpgradeLeg, UpgradeRun } from "./upgradeRuns"

const SENT: Record<UpgradeLeg["batch"]["state"], { label: string; badge: StatusBadgeStyle }> = {
  planned: { label: "Approved", badge: "pending" },
  sent: { label: "Leaving old version", badge: "pending" },
  refunded: { label: "Arriving", badge: "pending" },
  received: { label: "Arriving", badge: "pending" },
}

/** A leg's deposit speaks for it once seen and funded; until then, where its batch is. */
export function legStatus(leg: UpgradeLeg): { label: string; badge: StatusBadgeStyle } {
  const funded = leg.arrival && (leg.arrival.sweepTxHash || Number(leg.arrival.amount) > 0)
  return funded ? depositStatus(leg.arrival!) : SENT[leg.batch.state]
}

export function UpgradeRunDetailModal({
  run,
  onViewLeg,
  onClose,
}: {
  run: UpgradeRun
  /** Opens the leg's own detail sheet in place of this one. */
  onViewLeg: (leg: UpgradeLeg) => void
  onClose: () => void
}) {
  const figure = (amount: bigint) => usdFigure(formatUnits(amount, DEFAULT_DECIMALS))
  return (
    <Modal
      variant="create"
      label="Upgrade details"
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <Icon name="wallet" size={32} color="#fff" />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          +{figure(run.total)}
        </GradientText>
        <small>Upgrade · {whenLabel(run.time)}</small>
      </div>

      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue
            label={
              run.complete ? "Complete" : `${run.arrived} of ${run.legs.length} transfers arrived`
            }
            badge={run.complete ? "awaitingClaim" : run.settled ? "failed" : "pending"}
          />
        </DepositFact>
      </div>

      <div className="ww-sheet__facts" data-testid="upgrade-legs">
        {run.legs.map((leg, i) => (
          <Fragment key={leg.batch.id}>
            {i > 0 && <hr className="ww-divider" />}
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-sheet__fact"
              onClick={() => onViewLeg(leg)}
            >
              <span className="ww-deposit__connect-text">
                <b>Transfer {i + 1}</b>
              </span>
              <b className="ww-fresh__to">
                {figure(upgradeBatchFigure(leg.batch, leg.arrival))}
                <DepositStatusValue {...legStatus(leg)} />
              </b>
              <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
            </button>
          </Fragment>
        ))}
      </div>
    </Modal>
  )
}
