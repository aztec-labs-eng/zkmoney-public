/**
 * Legacy fresh-address withdrawal detail: the two burns of one group as one sheet. The total over
 * the recipient, then a row per leg with its figure and status. A row opens the leg's own detail,
 * where its exit and its error live.
 */
import { Fragment } from "react"
import {
  isFundsLegUnsent,
  WITHDRAWAL_FUNDS_UNSENT,
  swapWithdrawalAmounts,
  WITHDRAWAL_PHASE_COPY,
  withdrawalGroupAmount,
  withdrawalGroupTime,
  worstWithdrawalPhase,
  type WithdrawalGroup,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { GradientText, Icon } from "@obsidion/web-ds"
import ethIcon from "../../assets/deposit/ethereum.webp"
import { l1AddressUrl, whenLabel } from "../detailRows"
import { shortAddr, tokenAmount, usdFigure } from "../format"
import { Modal } from "../Modal"
import { DepositFact } from "./DepositFact"
import { DepositStatusValue } from "./DepositStatusValue"
import { withdrawalHeroAmount, withdrawalStatus } from "./WithdrawalDetailModal"
import { waitingNote } from "../../features/withdraw/waitingNote"

export const FUNDS_UNSENT_NOTE =
  "Only the gas reached this address. The funds stayed in your balance, so you can withdraw them again."

export function FreshWithdrawalDetailModal({
  group,
  notice,
  onViewLeg,
  onClose,
}: {
  group: WithdrawalGroup
  /** Full text of the notification that opened this detail. */
  notice?: string
  /** Opens the leg's own detail sheet in place of this one. */
  onViewLeg: (record: WithdrawalRecord) => void
  onClose: () => void
}) {
  const head = group.legs.gas ?? group.records[0]
  const recipientUrl = l1AddressUrl(head.recipient)
  const legs = [group.legs.gas, group.legs.funds].flatMap((record) => record ?? [])
  // The wait the group is in is the leg that sets its status.
  const worst = worstWithdrawalPhase(group)
  const note = waitingNote(legs.find((record) => record.phase === worst) ?? legs[0]!)
  // Only the gas reached the address: the funds never left the balance.
  const unsent = isFundsLegUnsent(group)
  const status = unsent
    ? { label: WITHDRAWAL_FUNDS_UNSENT, badge: "failed" as const }
    : withdrawalStatus({ phase: worst })

  return (
    <Modal
      variant="create"
      label="Withdrawal details"
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <Icon name="tray-withdraw" size={32} color="#fff" />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          -{usdFigure(withdrawalGroupAmount(group))}
        </GradientText>
        <small>Withdrawal · {whenLabel(withdrawalGroupTime(group))}</small>
      </div>

      {notice && <p className="ww-txd__notice">{notice}</p>}

      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue {...status} />
        </DepositFact>
        <DepositFact label="To">
          <b>
            {head.recipientAlias && `${head.recipientAlias} · `}
            {recipientUrl ? (
              <a href={recipientUrl} target="_blank" rel="noreferrer">
                {shortAddr(head.recipient)}
              </a>
            ) : (
              shortAddr(head.recipient)
            )}
          </b>
        </DepositFact>
        <DepositFact label="Network">
          <b>
            <img src={ethIcon} alt="" width={16} height={16} />
            Ethereum
          </b>
        </DepositFact>
      </div>

      {legs.length > 0 && (
        <div className="ww-sheet__facts">
          {legs.map((record, i) => {
            // A failed exit and a recovered one swapped nothing, so neither has an estimate.
            const unpaid = record.phase === "failed" || record.phase === "recovered"
            const estimate = unpaid ? undefined : swapWithdrawalAmounts(record)?.estimate
            const status = withdrawalStatus(record)
            return (
              <Fragment key={record.localId}>
                {i > 0 && <hr className="ww-divider" />}
                <button
                  type="button"
                  className="zkm-btn-reset zkm-pressable ww-sheet__fact"
                  data-leg={record.groupLeg}
                  onClick={() => onViewLeg(record)}
                >
                  <span className="ww-deposit__connect-text">
                    <b>{record.groupLeg === "gas" ? "Gas" : "Funds"}</b>
                    {/* The no-break space keeps the unit with its figure in a narrow column. */}
                    {estimate && record.swapOutput && (
                      <span>
                        ~{tokenAmount(estimate.outDisplay)}&nbsp;{record.swapOutput}
                      </span>
                    )}
                  </span>
                  <b className="ww-fresh__to">
                    {withdrawalHeroAmount(record)}
                    {/* The feed's short wording fits one line of a phone's column. */}
                    <DepositStatusValue
                      badge={status.badge}
                      label={WITHDRAWAL_PHASE_COPY[record.phase].pill ?? status.label}
                    />
                  </b>
                  <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
                </button>
              </Fragment>
            )
          })}
        </div>
      )}

      {unsent ? (
        <p className="ww-sheet__note">{FUNDS_UNSENT_NOTE}</p>
      ) : (
        note && <p className="ww-sheet__note">{note}</p>
      )}
    </Modal>
  )
}
