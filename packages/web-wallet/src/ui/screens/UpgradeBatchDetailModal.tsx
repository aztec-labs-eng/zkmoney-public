/**
 * One refund batch of an upgrade: what left the old version and where it went. It refunds funds
 * the old version froze, so nothing here comes off the balance, and its arrival is the deposit
 * the activity pairs with it.
 */
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { UpgradeBatchItem } from "@obsidion/front-core"
import { GradientText, Icon, type StatusBadgeStyle } from "@obsidion/web-ds"
import { formatUnits } from "viem"
import { getConfig } from "../../config/env"
import { l2TxUrl } from "../../lib/explorer"
import { Modal } from "../Modal"
import { l1AddressUrl, whenLabel } from "../detailRows"
import { usdFigure } from "../format"
import { DepositFact } from "./DepositFact"
import { DepositHashFact } from "./DepositHashFact"
import { DepositStatusValue } from "./DepositStatusValue"

const STATUS: Record<UpgradeBatchItem["state"], { label: string; badge: StatusBadgeStyle }> = {
  planned: { label: "Approved", badge: "pending" },
  sent: { label: "On its way", badge: "pending" },
  refunded: { label: "Released by the old version", badge: "pending" },
  received: { label: "Arrived", badge: "awaitingClaim" },
}

export function UpgradeBatchDetailModal({
  batch,
  onClose,
}: {
  batch: UpgradeBatchItem
  onClose: () => void
}) {
  const config = getConfig()
  const figure = (amount: string) => usdFigure(formatUnits(BigInt(amount), DEFAULT_DECIMALS))
  return (
    <Modal
      variant="create"
      label="Upgrade transfer details"
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <Icon name="wallet" size={32} color="#fff" />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          {figure(batch.amount)}
        </GradientText>
        <small>{whenLabel(batch.startTime)}</small>
      </div>
      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue {...STATUS[batch.state]} />
        </DepositFact>
        <DepositFact label="Relayer tip">
          <b>{figure(batch.exitFee)}</b>
        </DepositFact>
        <DepositHashFact
          label="Paid to"
          hash={batch.recipient}
          url={l1AddressUrl(batch.recipient)}
        />
        {batch.tx && (
          <DepositHashFact
            label="Sent in"
            hash={batch.tx}
            url={l2TxUrl(config.network, config.nodeUrl, batch.tx)}
          />
        )}
      </div>
    </Modal>
  )
}
