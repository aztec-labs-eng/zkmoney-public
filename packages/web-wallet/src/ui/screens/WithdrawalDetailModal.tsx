/**
 * Withdrawal detail — the L2→L1 counterpart of the deposit detail sheet: hero amount over a facts
 * card whose Status row names the leg the tracker is on and flips to Paid when the L1 release
 * lands, or, for a backup passkey funding whose attempt stopped, names its recovery instead. The
 * sheet stays open on the live store row, so the status updates as phases advance.
 *
 * The re-check and the exit it offers are the row's own, handed back so one owner drives the chain
 * watcher and the exit handoff.
 */
import {
  swapWithdrawalAmounts,
  WITHDRAWAL_PHASE_COPY,
  withdrawalAmounts,
  type BackupAddCost,
  type FundingRecovery,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { formatUnits } from "viem"
import {
  GradientText,
  Icon,
  PrimaryGradientButton,
  STATUS_STYLE,
  type StatusBadgeStyle,
} from "@obsidion/web-ds"
import ethIcon from "../../assets/deposit/ethereum.webp"
import { useSession } from "../../session/session"
import { ChainIcon } from "../ChainIcon/ChainIcon"
import { costCopy, recoveryCopy } from "../../features/backupPasskey/backupPasskeyCopy"
import { migrationAmounts } from "@obsidion/front-core"
import { TabLine } from "../../features/operations/TabLine"
import { waitingNote } from "../../features/withdraw/waitingNote"
import {
  WITHDRAWAL_RECEIVE_ASSETS,
  withdrawalReceiveAsset,
} from "../../features/withdraw/withdrawAssets"
import { l2TxUrl, originAddressUrl } from "../../lib/explorer"
import rowCopy from "../activity/ActivityRow.copy"
import { l1Links, whenLabel } from "../detailRows"
import copy from "./WithdrawalDetailModal.copy"
import chainsCopy from "../chains.copy"
import { fmt } from "../../lib/fmt"
import { tokenAmount, usdFigure } from "../format"
import { L1AddressLabel } from "../L1AddressLabel"
import { Modal } from "../Modal"
import { DepositFact } from "./DepositFact"
import { Hops } from "../MoveReview/MoveReview"
import { DepositHashFact } from "./DepositHashFact"
import { DepositStatusValue } from "./DepositStatusValue"

const PHASE_BADGE: Record<WithdrawalRecord["phase"], StatusBadgeStyle> = {
  submitting: "pending",
  l2_mined: "pending",
  awaiting_proven: "pending",
  finalizing_l1: "pending",
  swapping: "pending",
  bridging: "pending",
  recoverable: "failed",
  recovered: "cancelled",
  done: "awaitingClaim",
  failed: "failed",
}

/** The phases a withdrawal spends releasing its burn on Ethereum. */
const RELEASING_PHASES: ReadonlySet<WithdrawalRecord["phase"]> = new Set([
  "l2_mined",
  "awaiting_proven",
  "finalizing_l1",
])

export function withdrawalStatus(
  record: Pick<
    WithdrawalRecord,
    "phase" | "l2TxHash" | "finalizeTxHash" | "swapExecuteTxHash" | "recoveryTxHash" | "bridgeOut"
  >,
): {
  label: string
  badge: StatusBadgeStyle
} {
  const status = {
    label: WITHDRAWAL_PHASE_COPY[record.phase].status,
    badge: PHASE_BADGE[record.phase],
  }
  if (record.phase === "submitting" && !record.l2TxHash) {
    return { ...status, label: WITHDRAWAL_PHASE_COPY.submitting.proving ?? status.label }
  }
  if (record.phase === "finalizing_l1" && record.finalizeTxHash) {
    return { ...status, label: "Waiting for your finalization" }
  }
  // The shared table names Ethereum; a bridge-out is released toward its destination.
  if (record.bridgeOut && RELEASING_PHASES.has(record.phase)) {
    return { ...status, label: fmt(copy.releasingTo, { chain: record.bridgeOut.chainName }) }
  }
  if (record.phase === "swapping" && record.swapExecuteTxHash) {
    return { ...status, label: "Waiting for your swap" }
  }
  if (record.phase === "recoverable" && record.recoveryTxHash) {
    return { ...status, label: "Waiting for your recovery", badge: "pending" }
  }
  return status
}

/**
 * The row's and the sheet's figure, in dollars like the balance: the burn, or a backup passkey
 * add's cost once its leftover is back in the balance, which the burn alone overstates.
 */
export function withdrawalHeroAmount(
  record: Pick<WithdrawalRecord, "amount">,
  cost?: BackupAddCost,
): string {
  return `-${usdFigure(cost?.costDisplay ?? record.amount)}`
}

/**
 * A backup passkey add's title, for its funding's or its deposit's row and sheet: added only once
 * the add ran, not added once it stopped.
 */
export function backupFundingTitle(item: {
  recovery?: FundingRecovery
  stopped?: true
  added?: true
}): string {
  if (item.stopped || (item.recovery && item.recovery.state !== "unread"))
    return recoveryCopy.activity.notAdded
  return item.added
    ? rowCopy.counterparty.backupPasskeyAdded
    : rowCopy.counterparty.backupPasskeyFunding
}

export function WithdrawalDetailModal({
  record,
  intent = record.intent,
  amount,
  cost,
  added,
  onCheckAgain,
  exit,
  recovery,
  onOpenPasskeys,
  notice,
  onClose,
}: {
  /** Full text of the notification that opened this detail. */
  notice?: string
  record: WithdrawalRecord
  /** What the burn paid for, as the feed row reads it: a rebuilt record names none. */
  intent?: WithdrawalRecord["intent"]
  /** Headline figure, as the feed row shows it. */
  amount: string
  cost?: BackupAddCost
  /** A backup passkey funding whose add ran. */
  added?: true
  /** The re-check the row offers, if any. */
  onCheckAgain?: () => void
  /** The exit the row offers, if any: finalize manually, run the swap yourself, or recover. */
  exit?: { title: string; onStart: () => void }
  /** A backup passkey funding whose attempt stopped: the Passkeys panel recovers it, not this sheet. */
  recovery?: FundingRecovery
  onOpenPasskeys?: () => void
  onClose: () => void
}) {
  const { config } = useSession().page
  const { l1TxUrl, l1AddressUrl } = l1Links(config)
  const note = recovery ? recoveryCopy.activity.line[recovery.state] : waitingNote(record)
  const recoveryLabel = recovery && recoveryCopy.badge[recovery.state]
  const deposited = recovery?.deposited
  const recoveryTx = recovery?.recoveryTxHash
  const amounts = withdrawalAmounts(record)
  const swap = swapWithdrawalAmounts(record)
  const swapOption = record.swapOutput ? withdrawalReceiveAsset(record.swapOutput) : undefined
  const tokenOption =
    swapOption ?? WITHDRAWAL_RECEIVE_ASSETS.find((o) => o.symbol === record.tokenSymbol)
  // The Token row: the burned coin, then what the recipient receives where that differs.
  const receivedSymbol = tokenOption?.symbol ?? record.tokenSymbol
  const burnedIcon = WITHDRAWAL_RECEIVE_ASSETS.find((o) => o.symbol === record.tokenSymbol)?.icon
  const burnedHop = {
    label: record.tokenSymbol,
    icon: burnedIcon && <img src={burnedIcon} alt="" width={16} height={16} />,
  }
  const ethereumHop = {
    label: chainsCopy.ethereum,
    icon: <img src={ethIcon} alt="" width={16} height={16} />,
  }
  // A failed exit released nothing, and a recovered one swapped nothing, so neither names a fee or
  // an output figure.
  const unpaid = record.phase === "failed" || record.phase === "recovered"
  // A migration's recipient is the new balance, which also pays the arrival's fee.
  const migration = intent === "migration" ? migrationAmounts(record) : undefined
  // A registration's or a backup passkey's burn has no recipient to receive a net: the address it
  // pays is swept for the name or the key, so the sheet states what was sent and leaves the
  // withdrawal arithmetic out.
  const showBreakdown =
    !swap &&
    intent !== "migration" &&
    intent !== "registration" &&
    intent !== "backup" &&
    amounts.feeKnown &&
    amounts.netAtomic > 0n &&
    !unpaid
  const showMigration = migration && migration.netAtomic > 0n && !unpaid
  const showSwapFee = swap && swap.feeKnown && swap.swapInputAtomic > 0n && !unpaid
  const estimate = !unpaid ? swap?.estimate : undefined
  const { bridgeOut } = record
  const recipientLabel = record.phase === "done" ? copy.recipientReceived : copy.recipientReceives
  // A bridge-out's recipient is on the destination chain, so its own explorer shows it.
  const recipientUrl = bridgeOut
    ? originAddressUrl(bridgeOut.chainId, record.recipient)
    : l1AddressUrl(record.recipient)
  // A registration's or a backup passkey's burn pays this wallet's own deposit address, not a recipient.
  const registration = intent === "registration"
  const backup = intent === "backup"
  const recipientAlias = registration
    ? "Registration address"
    : backup
    ? "Backup passkey deposit address"
    : record.recipientAlias

  return (
    <Modal
      variant="create"
      label={
        registration
          ? "Registration details"
          : backup
          ? backupFundingTitle({ recovery, added })
          : record.source === "paylink"
          ? "Paylink withdrawal details"
          : "Withdrawal details"
      }
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <Icon name="tray-withdraw" size={32} color="#fff" />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          {amount}
        </GradientText>
        <small>{whenLabel(record.endTime ?? record.startTime)}</small>
      </div>

      {notice && <p className="ww-txd__notice">{notice}</p>}

      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue
            {...(recoveryLabel
              ? { label: recoveryLabel, badge: STATUS_STYLE[recoveryLabel] }
              : withdrawalStatus(record))}
          />
        </DepositFact>
        <DepositFact label="To">
          {/* A migration pays this wallet's own arrival address, which means nothing to a user. */}
          {intent === "migration" ? (
            <b>{record.recipientAlias}</b>
          ) : (
            <b>
              <L1AddressLabel
                address={record.recipient}
                name={recipientAlias || undefined}
                href={recipientUrl}
              />
            </b>
          )}
        </DepositFact>
        {record.l2TxHash ? (
          <DepositHashFact
            label="Tx hash"
            hash={record.l2TxHash}
            url={l2TxUrl(config.network, config.nodeUrl, record.l2TxHash)}
          />
        ) : (
          <DepositFact label="Tx hash">
            <b>--</b>
          </DepositFact>
        )}
        {record.source === "paylink" && (
          <DepositFact label="From">
            <b>Payment link</b>
          </DepositFact>
        )}
        <DepositFact label="Token">
          <b>
            <Hops
              hops={
                receivedSymbol === record.tokenSymbol
                  ? [burnedHop]
                  : [
                      burnedHop,
                      {
                        label: receivedSymbol,
                        icon: tokenOption && (
                          <img src={tokenOption.icon} alt="" width={16} height={16} />
                        ),
                      },
                    ]
              }
            />
          </b>
        </DepositFact>
        <DepositFact label="Network">
          <b>
            <Hops
              hops={
                bridgeOut
                  ? [
                      {
                        label: bridgeOut.chainName,
                        icon: (
                          <ChainIcon
                            chainId={bridgeOut.chainId}
                            name={bridgeOut.chainName}
                            size={16}
                          />
                        ),
                      },
                    ]
                  : [ethereumHop]
              }
            />
          </b>
        </DepositFact>
        <DepositFact label={cost ? costCopy.sent : copy.sent}>
          {/* A backup passkey add's cost rows are in dollars, so its Sent is too. */}
          <b>
            {cost
              ? usdFigure(amounts.grossDisplay)
              : `${tokenAmount(amounts.grossDisplay)} ${record.tokenSymbol}`}
          </b>
        </DepositFact>
        {cost && (
          <>
            <DepositFact label={costCopy.withdrawalFee}>
              <b>-{usdFigure(cost.withdrawalFeeDisplay)}</b>
            </DepositFact>
            <DepositFact label={costCopy.accountChangeFee}>
              <b>-{usdFigure(cost.accountChangeFeeDisplay)}</b>
            </DepositFact>
          </>
        )}
        {deposited && (
          <DepositFact label={recoveryCopy.activity.sentBack}>
            <b>{usdFigure(formatUnits(BigInt(deposited), record.tokenDecimals))}</b>
          </DepositFact>
        )}
        {estimate && (
          <DepositFact label="Exchange rate">
            <b>$1 = {tokenAmount(String(estimate.rate))}</b>
          </DepositFact>
        )}
        {swap?.gas && !unpaid && (
          <DepositFact label="Arrives as gas">
            <b>
              {usdFigure(swap.gas.daiDisplay)}
              {swap.gas.ethOutDisplay && ` ≈ ${tokenAmount(swap.gas.ethOutDisplay)} ETH`}
            </b>
          </DepositFact>
        )}
        {showBreakdown && (
          <DepositFact label="Fee">
            <b>-{usdFigure(amounts.feeDisplay)}</b>
          </DepositFact>
        )}
        {showMigration && (
          <>
            <DepositFact label="Old version fee">
              <b>-{usdFigure(migration.exitFeeDisplay)}</b>
            </DepositFact>
            <DepositFact label="New version fee">
              <b>-{usdFigure(migration.arrivalFeeDisplay)}</b>
            </DepositFact>
          </>
        )}
        {showSwapFee && (
          <DepositFact label="Fee">
            <b>-{usdFigure(swap.feeDisplay)}</b>
          </DepositFact>
        )}
        {record.l1TxHash && (
          <DepositHashFact label="L1 tx" hash={record.l1TxHash} url={l1TxUrl(record.l1TxHash)} />
        )}
        {recoveryTx && (
          <DepositHashFact
            label={recoveryCopy.activity.recoveryTx}
            hash={recoveryTx}
            url={l1TxUrl(recoveryTx)}
          />
        )}
        {record.finalizeTxHash && (
          <DepositHashFact
            label="Finalization tx"
            hash={record.finalizeTxHash}
            url={l1TxUrl(record.finalizeTxHash)}
          />
        )}
        {record.swapExecuteTxHash && (
          <DepositHashFact
            label="Swap tx"
            hash={record.swapExecuteTxHash}
            url={l1TxUrl(record.swapExecuteTxHash)}
          />
        )}
        {record.recoveryTarget && (
          <DepositFact label="Recovered to">
            <b>
              <L1AddressLabel address={record.recoveryTarget} />
            </b>
          </DepositFact>
        )}
        {record.recoveryTxHash && (
          <DepositHashFact
            label="Recovery tx"
            hash={record.recoveryTxHash}
            url={l1TxUrl(record.recoveryTxHash)}
          />
        )}
        {showBreakdown && (
          <>
            <hr className="ww-divider" />
            <DepositFact label={recipientLabel}>
              <b>
                {tokenAmount(amounts.netDisplay)} {record.tokenSymbol}
              </b>
            </DepositFact>
          </>
        )}
        {cost && (
          <>
            <hr className="ww-divider" />
            <DepositFact label={costCopy.returned}>
              <b>{usdFigure(cost.returnedDisplay)}</b>
            </DepositFact>
          </>
        )}
        {showMigration && (
          <>
            <hr className="ww-divider" />
            <DepositFact label="You'll receive">
              <b>~{usdFigure(migration.netDisplay)}</b>
            </DepositFact>
          </>
        )}
        {estimate && swapOption && (
          <>
            <hr className="ww-divider" />
            {/* What the fill paid, else the bridge's minimum or the swap's quoted output. */}
            <DepositFact
              label={
                !bridgeOut
                  ? recipientLabel
                  : bridgeOut.filledAmount
                  ? copy.recipientReceived
                  : copy.minimumReceived
              }
            >
              <b>
                {tokenAmount(estimate.outDisplay)} {swapOption.symbol}
              </b>
            </DepositFact>
          </>
        )}
      </div>

      {note && <p className="ww-sheet__note">{note}</p>}
      <TabLine operationId={record.operationId} />
      {onCheckAgain && (
        <PrimaryGradientButton
          title="Check again"
          buttonStyle={exit ? "dark" : undefined}
          onClick={onCheckAgain}
        />
      )}
      {exit && <PrimaryGradientButton title={exit.title} onClick={exit.onStart} />}
      {onOpenPasskeys && (
        <PrimaryGradientButton
          title={recoveryCopy.activity.openPasskeys}
          onClick={onOpenPasskeys}
        />
      )}
    </Modal>
  )
}
