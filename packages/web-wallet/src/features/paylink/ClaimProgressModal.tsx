import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  swapWithdrawalAmounts,
  withdrawalAmounts,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { GradientText, Icon, TopNavIconButton } from "@obsidion/web-ds"
import ethIcon from "../../assets/deposit/ethereum.webp"
import { l1TxUrl, whenLabel } from "../../ui/detailRows"
import { shortAddr, tokenAmount, usdFigure } from "../../ui/format"
import { Modal } from "../../ui/Modal"
import { DepositStatusValue } from "../../ui/screens/DepositStatusValue"
import { withdrawalStatus } from "../../ui/screens/WithdrawalDetailModal"
import { withdrawalReceiveAsset } from "../withdraw/withdrawAssets"

const SETTLED_TITLE: Partial<Record<WithdrawalRecord["phase"], string>> = {
  done: "Payment claimed",
  recovered: "Claim recovered",
  recoverable: "Claim needs recovery",
  failed: "Claim failed",
}

/** The cash-out has ended, so there is a receipt to open. */
export function hasClaimReceipt(record: Pick<WithdrawalRecord, "phase">): boolean {
  return SETTLED_TITLE[record.phase] !== undefined
}

/**
 * A visitor's ended cash-out: the receipt the page and the bell open, as a wallet withdrawal's detail
 * opens from its row. Nothing while it runs; the page carries it until then.
 */
export function ClaimProgressModal({
  record,
  memo,
  onClose,
}: {
  record: WithdrawalRecord
  /** The creator's note, off the link — the record does not carry it. */
  memo?: string
  onClose: () => void
}) {
  const title = SETTLED_TITLE[record.phase]
  if (!title) return null
  const status = withdrawalStatus(record)
  const swap = swapWithdrawalAmounts(record)
  const delivered = record.phase === "done"
  const recovered = record.phase === "recovered"
  // Only a finished swap delivered the output asset; every other settled phase holds or moved the
  // DAI the portal released, so that is the asset and amount those sheets name.
  const asset = withdrawalReceiveAsset(delivered && record.swapOutput ? record.swapOutput : "DAI")
  // A swap escrow holds the burn net of every pre-swap deduction (withdrawal relayer tip, FPC cut,
  // swap relayer tip); until those are all on the record there is no honest figure to show.
  const heldInEscrow =
    swap && !delivered
      ? swap.feeKnown
        ? usdFigure(formatUnits(swap.swapInputAtomic, DEFAULT_DECIMALS))
        : "—"
      : undefined
  const received =
    delivered && swap?.estimate
      ? `${tokenAmount(swap.estimate.outDisplay)} ${asset.symbol}`
      : heldInEscrow ?? usdFigure(withdrawalAmounts(record).netDisplay)
  const destination = recovered && record.recoveryTarget ? record.recoveryTarget : record.recipient
  const l1Hash = delivered
    ? record.swapExecuteTxHash ?? record.finalizeTxHash
    : recovered
    ? record.recoveryTxHash ?? record.finalizeTxHash
    : record.finalizeTxHash
  const l1Url = l1Hash ? l1TxUrl(l1Hash) : undefined

  return (
    <Modal
      variant="bare"
      label="Claim receipt"
      className="ww-deposit-warning ww-fund"
      onClose={onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <div className="ww-claim-progress__head">
        <Icon
          name={record.phase === "done" ? "check" : "alert-circle"}
          size={48}
          color={record.phase === "done" ? "#56e79d" : "#fe708b"}
        />
        <GradientText size={22} weight={700}>
          {title}
        </GradientText>
      </div>
      <div className="ww-fund__fields">
        <div className="ww-deposit__facts">
          <div className="ww-deposit__fact">
            <span>{delivered ? "You received" : recovered ? "Recovered" : "Amount"}</span>
            <b>{received}</b>
          </div>
          {memo && (
            <div className="ww-deposit__fact">
              <span>Note</span>
              <b>{memo}</b>
            </div>
          )}
          <div className="ww-deposit__fact">
            <span>{recovered ? "Recovered to" : "To"}</span>
            <b>{shortAddr(destination)}</b>
          </div>
          <div className="ww-deposit__fact">
            <span>Token</span>
            <b>
              <img src={asset.icon} alt="" width={16} height={16} />
              {asset.symbol}
            </b>
          </div>
          <div className="ww-deposit__fact">
            <span>Network</span>
            <b>
              <img src={ethIcon} alt="" width={16} height={16} />
              Ethereum
            </b>
          </div>
          <div className="ww-deposit__fact">
            <span>Date</span>
            <b>{whenLabel(record.endTime ?? record.startTime)}</b>
          </div>
          <div className="ww-deposit__fact">
            <span>Tx hash</span>
            {l1Hash && l1Url ? (
              <b>
                <a href={l1Url} target="_blank" rel="noreferrer">
                  View on Etherscan <Icon name="share-box" size={16} />
                </a>
              </b>
            ) : (
              <b>{l1Hash ? shortAddr(l1Hash) : "--"}</b>
            )}
          </div>
          <hr className="ww-divider" />
          <div className="ww-deposit__fact">
            <span>Status</span>
            <DepositStatusValue {...status} />
          </div>
        </div>
      </div>
    </Modal>
  )
}
