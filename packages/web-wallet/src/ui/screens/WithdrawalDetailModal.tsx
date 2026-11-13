/**
 * Withdrawal detail — the L2→L1 counterpart of the deposit detail sheet: hero amount over a facts
 * card whose Status row names the leg the tracker is on and flips to Paid when the L1 release
 * lands, or, for a backup passkey funding whose attempt stopped, names its recovery instead. A
 * backup passkey fee leads with the fee and its hold, and folds the chain facts away. The sheet
 * stays open on the live store row, so the status updates as phases advance.
 *
 * The re-check and the exit it offers are the row's own, handed back so one owner drives the chain
 * watcher and the exit handoff.
 */
import {
  swapWithdrawalAmounts,
  WITHDRAWAL_PHASE_COPY,
  withdrawalAmounts,
  type BackupFee,
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
import { backupFeeStatus, backupFundingTitle, backupNote } from "./backupFee"

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
 * add's fee, which the burn overstates by the hold sent on top.
 */
export function withdrawalHeroAmount(
  record: Pick<WithdrawalRecord, "amount" | "tokenDecimals">,
  fee?: BackupFee,
): string {
  return `-${usdFigure(fee ? formatUnits(fee.amount, record.tokenDecimals) : record.amount)}`
}

export function WithdrawalDetailModal({
  record,
  intent = record.intent,
  amount,
  fee,
  added,
  running,
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
  fee?: BackupFee
  /** A backup passkey funding whose add finished. */
  added?: true
  /** A backup passkey funding whose add still runs. */
  running?: true
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
  // A registration's or a backup passkey's burn pays this wallet's own deposit address, not a recipient.
  const registration = intent === "registration"
  const backup = intent === "backup"
  const dollars = (atomic: bigint) => usdFigure(formatUnits(atomic, record.tokenDecimals))
  const note = recovery
    ? recoveryCopy.activity.line[recovery.state]
    : backup
    ? backupNote({ record, fee, added, running, exit: !!exit })
    : waitingNote(record)
  const backupLabel = backup ? backupFeeStatus({ record, added, running, recovery }) : undefined
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
  // A failed exit released nothing, and a recovered one swapped nothing, so neither names a fee or
  // an output figure.
  const unpaid = record.phase === "failed" || record.phase === "recovered"
  // A migration's recipient is the new balance, which also pays the arrival's fee.
  const migration = intent === "migration" ? migrationAmounts(record) : undefined
  // A registration's burn has no recipient to receive a net: the address it pays is swept for the
  // name, so the sheet states what was sent and leaves the withdrawal arithmetic out.
  const showBreakdown =
    !swap &&
    intent !== "migration" &&
    intent !== "registration" &&
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
  const recipientAlias = registration
    ? "Registration address"
    : backup
    ? "Backup passkey deposit address"
    : record.recipientAlias

  // Where the burn went and what it moved.
  const chainFacts = (
    <>
      <DepositFact label={copy.facts.to}>
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
          label={copy.facts.txHash}
          hash={record.l2TxHash}
          url={l2TxUrl(config.network, config.nodeUrl, record.l2TxHash)}
        />
      ) : (
        <DepositFact label={copy.facts.txHash}>
          <b>--</b>
        </DepositFact>
      )}
      {record.source === "paylink" && (
        <DepositFact label={copy.facts.from}>
          <b>{copy.facts.paymentLink}</b>
        </DepositFact>
      )}
      <DepositFact label={copy.facts.token}>
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
      <DepositFact label={copy.facts.network}>
        <b>
          {bridgeOut ? (
            <>
              <ChainIcon chainId={bridgeOut.chainId} name={bridgeOut.chainName} size={16} />
              {bridgeOut.chainName}
            </>
          ) : (
            <>
              <img src={ethIcon} alt="" width={16} height={16} />
              {chainsCopy.ethereum}
            </>
          )}
        </b>
      </DepositFact>
    </>
  )
  const hashFacts = (
    <>
      {record.l1TxHash && (
        <DepositHashFact
          label={copy.facts.l1Tx}
          hash={record.l1TxHash}
          url={l1TxUrl(record.l1TxHash)}
        />
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
          label={copy.facts.finalizationTx}
          hash={record.finalizeTxHash}
          url={l1TxUrl(record.finalizeTxHash)}
        />
      )}
      {record.swapExecuteTxHash && (
        <DepositHashFact
          label={copy.facts.swapTx}
          hash={record.swapExecuteTxHash}
          url={l1TxUrl(record.swapExecuteTxHash)}
        />
      )}
      {record.recoveryTarget && (
        <DepositFact label={copy.facts.recoveredTo}>
          <b>
            <L1AddressLabel address={record.recoveryTarget} />
          </b>
        </DepositFact>
      )}
      {record.recoveryTxHash && (
        <DepositHashFact
          label={copy.facts.recoveryTx}
          hash={record.recoveryTxHash}
          url={l1TxUrl(record.recoveryTxHash)}
        />
      )}
    </>
  )

  return (
    <Modal
      variant="create"
      label={
        registration
          ? "Registration details"
          : backup
          ? backupFundingTitle({ recovery, added }, rowCopy.counterparty.backupPasskeyFee)
          : record.source === "paylink"
          ? "Paylink withdrawal details"
          : "Withdrawal details"
      }
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <Icon name={backup ? "key" : "tray-withdraw"} size={32} color="#fff" />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          {amount}
        </GradientText>
        <small>{whenLabel(record.endTime ?? record.startTime)}</small>
      </div>

      {notice && <p className="ww-txd__notice">{notice}</p>}

      <div className="ww-sheet__facts">
        <DepositFact label={copy.facts.status}>
          <DepositStatusValue
            {...(backupLabel
              ? { label: backupLabel, badge: STATUS_STYLE[backupLabel] }
              : withdrawalStatus(record))}
          />
        </DepositFact>
        {backup ? (
          <>
            {fee ? (
              <>
                <DepositFact label={copy.facts.fee}>
                  <b>-{dollars(fee.amount)}</b>
                </DepositFact>
                <DepositFact label={fee.returned ? costCopy.returned : copy.backup.hold}>
                  <b>{dollars(fee.hold)}</b>
                </DepositFact>
              </>
            ) : (
              <DepositFact label={copy.sent}>
                <b>{usdFigure(amounts.grossDisplay)}</b>
              </DepositFact>
            )}
            {deposited && (
              <DepositFact label={recoveryCopy.activity.sentBack}>
                <b>{dollars(BigInt(deposited))}</b>
              </DepositFact>
            )}
            <details className="ww-sheet__more">
              <summary>
                {copy.details}
                <Icon name="chevron-down" size={16} className="ww-sheet__more-chevron" />
              </summary>
              <div className="ww-sheet__more-facts">
                {chainFacts}
                {hashFacts}
              </div>
            </details>
          </>
        ) : (
          <>
            {chainFacts}
            <DepositFact label={copy.sent}>
              <b>
                {tokenAmount(amounts.grossDisplay)} {record.tokenSymbol}
              </b>
            </DepositFact>
            {estimate && (
              <DepositFact label={copy.facts.exchangeRate}>
                <b>$1 = {tokenAmount(String(estimate.rate))}</b>
              </DepositFact>
            )}
            {swap?.gas && !unpaid && (
              <DepositFact label={copy.facts.arrivesAsGas}>
                <b>
                  {usdFigure(swap.gas.daiDisplay)}
                  {swap.gas.ethOutDisplay && ` ≈ ${tokenAmount(swap.gas.ethOutDisplay)} ETH`}
                </b>
              </DepositFact>
            )}
            {showBreakdown && (
              <DepositFact label={copy.facts.fee}>
                <b>-{usdFigure(amounts.feeDisplay)}</b>
              </DepositFact>
            )}
            {showMigration && (
              <>
                <DepositFact label={copy.facts.oldVersionFee}>
                  <b>-{usdFigure(migration.exitFeeDisplay)}</b>
                </DepositFact>
                <DepositFact label={copy.facts.newVersionFee}>
                  <b>-{usdFigure(migration.arrivalFeeDisplay)}</b>
                </DepositFact>
              </>
            )}
            {showSwapFee && (
              <DepositFact label={copy.facts.fee}>
                <b>-{usdFigure(swap.feeDisplay)}</b>
              </DepositFact>
            )}
            {hashFacts}
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
            {showMigration && (
              <>
                <hr className="ww-divider" />
                <DepositFact label={copy.facts.youllReceive}>
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
          </>
        )}
      </div>

      {note && <p className="ww-sheet__note">{note}</p>}
      <TabLine operationId={record.operationId} />
      {onCheckAgain && (
        <PrimaryGradientButton
          title="Check again"
          buttonStyle={exit ? "secondary" : undefined}
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
