/**
 * Deposit detail — the SIPA-deposit counterpart of the activity TxDetail modal: source wallet over
 * a facts card (amounts, deposit address, and every on-chain leg). The exit it offers is the row's
 * own, handed back so the exit sheet keeps one owner. A registration deposit additionally names the
 * identity it claimed (`registrationTag`).
 */
import { depositAmounts, type SIPADepositPhase, type SIPADepositRecord } from "@obsidion/front-core"
import {
  GradientText,
  PrimaryGradientButton,
  type StatusBadgeStyle,
} from "@obsidion/web-ds"
import walletLineIcon from "../../assets/deposit/wallet-line.svg"
import ethIcon from "../../assets/deposit/ethereum.webp"
import { depositTokensFor } from "../../features/deposit/loadDepositFacts"
import { getConfig } from "../../config/env"
import { Modal } from "../Modal"
import { unsweepableCopy } from "../../features/deposit/unsweepableCopy"
import { l2TxUrl } from "../../lib/explorer"
import { l1AddressUrl, l1TxUrl, whenLabel } from "../detailRows"
import { shortAddr, usdFigure } from "../format"
import { depositAttribution, depositHeadline, neverCreditsL2 } from "./activityView"
import { DepositFact } from "./DepositFact"
import { DepositHashFact } from "./DepositHashFact"
import { DepositStatusValue } from "./DepositStatusValue"

/**
 * Per-phase sheet status: a pending label while in flight, then Completed / Cancelled / Recovered.
 * The phases where money is inbound but uncredited share the design's one word for that, Receiving;
 * an address nobody has sent to yet has not received anything, and the legs past L1 name their step.
 */
const PHASE_STATUS: Record<SIPADepositPhase, { label: string; badge: StatusBadgeStyle }> = {
  resolved: { label: "Awaiting funds", badge: "pending" },
  funding: { label: "Receiving", badge: "pending" },
  funded: { label: "Receiving", badge: "pending" },
  broadcast: { label: "Receiving", badge: "pending" },
  sweeping: { label: "Sweeping into Aztec", badge: "pending" },
  pendingClaim: { label: "Claiming on Aztec", badge: "pending" },
  claimed: { label: "Completed", badge: "awaitingClaim" },
  recovered: { label: "Recovered", badge: "cancelled" },
  recoverable: { label: "Needs recovery", badge: "failed" },
  failed: { label: "Cancelled", badge: "failed" },
}

export function depositStatus(record: Pick<SIPADepositRecord, "phase" | "sweepTxHash">): {
  label: string
  badge: StatusBadgeStyle
} {
  const status = PHASE_STATUS[record.phase]
  return record.phase === "sweeping" && !record.sweepTxHash
    ? { ...status, label: "Waiting to be swept" }
    : status
}

export function DepositDetailModal({
  record,
  registrationTag,
  exit,
  notice,
  onClose,
}: {
  /** Full text of the notification that opened this detail. */
  notice?: string
  record: SIPADepositRecord
  /** Set when this SIPA registered a name: the detail names the registration identity. */
  registrationTag?: string
  /** The exit the row offers, if any. */
  exit?: { title: string; onStart: () => void }
  onClose: () => void
}) {
  const config = getConfig()
  const amounts = depositAmounts(record)
  // A deposit that never credits L2 was charged no fee and receives nothing.
  const showBreakdown = !neverCreditsL2(record.phase) && amounts.feeKnown && amounts.netAtomic > 0n
  const status = depositStatus(record)
  const { fundingTxHash } = depositAttribution(record)
  const { title, address } = depositHeadline(record)
  const sentFigure = amounts.grossAtomic > 0n ? usdFigure(amounts.grossDisplay) : "--"
  // The sheet leads with what lands on L2; the gross the wallet was charged is the Sent row. A
  // deposit that never credits L2 has no net anyone is owed, so it leads with that gross instead.
  const headline =
    !neverCreditsL2(record.phase) && amounts.netAtomic > 0n
      ? usdFigure(amounts.netDisplay)
      : sentFigure
  const funderUrl = address ? l1AddressUrl(address) : undefined
  const sipaUrl = l1AddressUrl(record.sipaAddress)
  const depositTokens = depositTokensFor(config.network)
  const tokenIcon = depositTokens.find((t) => t.symbol === record.tokenSymbol)?.icon

  return (
    <Modal
      variant="create"
      label={registrationTag ? "Registration deposit details" : "Deposit details"}
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <img src={walletLineIcon} alt="" width={32} height={29} />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          {headline}
        </GradientText>
        <small>{whenLabel(record.endTime ?? record.startTime)}</small>
      </div>

      {notice && <p className="ww-txd__notice">{notice}</p>}

      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue {...status} />
        </DepositFact>
        {registrationTag && (
          <DepositFact label="Name">
            <b>{registrationTag}.zk.money</b>
          </DepositFact>
        )}
        <DepositFact label="From">
          <b>
            {title}
            {address && " · "}
            {address &&
              (funderUrl ? (
                <a href={funderUrl} target="_blank" rel="noreferrer">
                  {shortAddr(address)}
                </a>
              ) : (
                shortAddr(address)
              ))}
          </b>
        </DepositFact>
        {fundingTxHash ? (
          <DepositHashFact label="Tx hash" hash={fundingTxHash} url={l1TxUrl(fundingTxHash)} />
        ) : (
          <DepositFact label="Tx hash">
            <b>--</b>
          </DepositFact>
        )}
        <DepositFact label="Token">
          <b>
            {tokenIcon && <img src={tokenIcon} alt="" width={16} height={16} />}
            {record.tokenSymbol}
          </b>
        </DepositFact>
        <DepositFact label="Network">
          <b>
            <img src={ethIcon} alt="" width={16} height={16} />
            Ethereum (ERC20)
          </b>
        </DepositFact>
        <DepositFact label="Sent">
          <b>{sentFigure}</b>
        </DepositFact>
        {showBreakdown && (
          <DepositFact label="Fee">
            <b>{usdFigure(amounts.feeDisplay)}</b>
          </DepositFact>
        )}
        <DepositHashFact label="Deposit address" hash={record.sipaAddress} url={sipaUrl} />
        {record.sweepTxHash && (
          <DepositHashFact
            label="Sweep tx"
            hash={record.sweepTxHash}
            url={l1TxUrl(record.sweepTxHash)}
          />
        )}
        {record.recoveryTxHash && (
          <DepositHashFact
            label="Recovery tx"
            hash={record.recoveryTxHash}
            url={l1TxUrl(record.recoveryTxHash)}
          />
        )}
        {record.claimTxHash && (
          <DepositHashFact
            label="Claim tx"
            hash={record.claimTxHash}
            url={l2TxUrl(config.network, config.nodeUrl, record.claimTxHash)}
          />
        )}
        {showBreakdown && (
          <>
            <hr className="ww-divider" />
            <DepositFact label="Received">
              <b>{usdFigure(amounts.netDisplay)}</b>
            </DepositFact>
          </>
        )}
      </div>

      {record.phase === "recoverable" && (
        <p className="ww-sheet__note">{unsweepableCopy(record, depositTokens[0]?.symbol)}</p>
      )}
      {exit && <PrimaryGradientButton title={exit.title} onClick={exit.onStart} />}
    </Modal>
  )
}
