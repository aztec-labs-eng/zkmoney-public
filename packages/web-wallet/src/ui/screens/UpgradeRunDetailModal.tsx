/**
 * One upgrade as one sheet: what reaches the balance, then a row per batch with its figure and
 * where it is. A row opens the batch's deposit, where its recovery lives, or the batch itself
 * before its deposit is funded.
 */
import { Fragment } from "react"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { GradientText, Icon, type StatusBadgeStyle } from "@obsidion/web-ds"
import { formatUnits } from "viem"
import {
  legDeposit,
  upgradeLegValue,
  upgradeRunValue,
  type UpgradePricing,
  type UpgradeLeg,
  type UpgradeRun,
  type SIPADepositRecord,
  type UpgradeBatchItem,
} from "@obsidion/front-core"
import { whenLabel } from "../detailRows"
import { usdFigure } from "../format"
import { Modal } from "../Modal"
import { depositStatus } from "./DepositDetailModal"
import { DepositFact } from "./DepositFact"
import { DepositStatusValue } from "./DepositStatusValue"
import { batchStatus } from "./UpgradeBatchDetailModal"

/** A leg's deposit speaks for it once seen and funded; until then, where its batch is. */
export function legStatus(leg: UpgradeLeg): { label: string; badge: StatusBadgeStyle } {
  const deposit = legDeposit(leg)
  return deposit ? depositStatus(deposit) : batchStatus(leg.batch)
}

export function UpgradeRunDetailModal({
  run,
  title,
  pricing,
  onViewDeposit,
  onViewBatch,
  onClose,
}: {
  run: UpgradeRun
  /** Names the account the run pays into, since Main and Savings each have their own run. */
  title: string
  pricing: UpgradePricing
  /** Open the leg's own detail sheet in place of this one: its deposit once that speaks for it. */
  onViewDeposit: (deposit: SIPADepositRecord) => void
  onViewBatch: (batch: UpgradeBatchItem) => void
  onClose: () => void
}) {
  const total = upgradeRunValue(run, pricing)
  const figure = (amount: bigint | undefined) =>
    amount === undefined ? "—" : usdFigure(formatUnits(amount, DEFAULT_DECIMALS))
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
          {total === undefined ? "—" : `+${figure(total)}`}
        </GradientText>
        <small>
          {title} · {whenLabel(run.time)}
        </small>
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
              onClick={() => {
                const deposit = legDeposit(leg)
                if (deposit) onViewDeposit(deposit)
                else onViewBatch(leg.batch)
              }}
            >
              <span className="ww-deposit__connect-text">
                <b>Transfer {i + 1}</b>
              </span>
              <b className="ww-fresh__to">
                {figure(upgradeLegValue(leg, pricing))}
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
