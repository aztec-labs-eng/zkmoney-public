/**
 * Deposit detail — the SIPA-deposit counterpart of the activity TxDetail modal: source wallet over
 * a facts card (amounts, deposit address, and every on-chain leg). The exit it offers is the row's
 * own, handed back so the exit sheet keeps one owner. A registration deposit additionally names the
 * identity it claimed (`registrationTag`).
 */
import {
  depositAmounts,
  depositPhaseCopy,
  neverCreditsL2,
  type SIPADepositPhase,
  type BridgeInRecord,
  type SipaDeposit,
} from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton, type StatusBadgeStyle } from "@obsidion/web-ds"
import walletLineIcon from "../../../assets/deposit/wallet-line.svg"
import ethIcon from "../../../assets/deposit/ethereum.webp"
import {
  settlementDecimals,
  settlementSymbol as settledSymbol,
  settlementToken,
  useDepositTokens,
} from "../../../features/sipa/loadDepositFacts"
import { addDollars, bridgeFeeUsd } from "../../../features/deposit/bridgeChains"
import { OriginTokenIcon } from "../../CoinIcon/CoinIcon"
import { ChainIcon } from "../../ChainIcon/ChainIcon"
import { Modal } from "../../Modal"
import { unsweepableCopy } from "../../../features/deposit/unsweepableCopy"
import copy from "./DepositDetailModal.copy"
import { DepositProcessingNotice } from "../../../features/deposit/DepositProcessingNotice/DepositProcessingNotice"
import { useSipaProcessing } from "../../../features/deposit/sipaProcessing"
import { PendingLimitsLink } from "../../../features/limits/AboutLimitsSheet"
import { originAddressUrl, originTxUrl } from "../../../lib/explorer"
import { useL1Links, whenLabel } from "../../detailRows"
import { tokenFigure, usdFigure } from "../../format"
import { coinFigure } from "../../coinDecimals"
import { L1AddressLabel } from "../../L1AddressLabel"
import { Hops } from "../../MoveReview/MoveReview"
import { depositAttribution, depositGrossFigure, depositHeadline } from "../activityView"
import { DepositFact } from "../DepositFact"
import { DepositHashFact } from "../DepositHashFact"
import { DepositStatusValue } from "../DepositStatusValue"
import { useRowTxAmountCap } from "../../../features/token/useTxAmountCap"

/** The sheet's badge per phase; the word is front-core's `DEPOSIT_PHASE_COPY`. */
const PHASE_BADGE: Record<SIPADepositPhase, StatusBadgeStyle> = {
  resolved: "pending",
  funding: "pending",
  funded: "pending",
  broadcast: "pending",
  sweeping: "pending",
  pendingClaim: "pending",
  claimed: "awaitingClaim",
  recovered: "cancelled",
  recoverable: "failed",
  failed: "failed",
}

export function depositStatus(record: SipaDeposit): {
  label: string
  badge: StatusBadgeStyle
} {
  return { label: depositPhaseCopy(record).status, badge: PHASE_BADGE[record.phase] }
}

export function DepositDetailModal({
  record,
  registrationTag,
  bridgeIn,
  exit,
  notice,
  onBack,
  onClose,
}: {
  /** Full text of the notification that opened this detail. */
  notice?: string
  record: SipaDeposit
  /** Set when this SIPA registered a name: the detail names the registration identity. */
  registrationTag?: string
  /** The bridge-in that paid this deposit: the user sent on its origin chain, not on Ethereum. */
  bridgeIn?: { record: BridgeInRecord; walletName?: string; chainName?: string }
  /** The exit the row offers, if any. A sweep is an escape hatch, so it is not the gradient button. */
  exit?: { title: string; onStart: () => void; sweep?: boolean }
  /** Returns to the sheet that opened this one, such as an upgrade's. */
  onBack?: () => void
  onClose: () => void
}) {
  const { l1TxUrl, l1AddressUrl } = useL1Links()
  const depositTokens = useDepositTokens()
  const txAmountCap = useRowTxAmountCap(settlementToken(depositTokens, record.tokenAddress))
  const rowDecimals = settlementDecimals(depositTokens, record.tokenAddress)
  const amounts = depositAmounts(record, rowDecimals)
  // A deposit that never credits L2 was charged no fee and receives nothing.
  const showBreakdown = !neverCreditsL2(record.phase) && amounts.feeKnown && amounts.netAtomic > 0n
  const status = depositStatus(record)
  const { fundingTxHash } = depositAttribution(record)
  const { title, address } = depositHeadline(record)
  const sentFigure =
    amounts.grossAtomic > 0n ? depositGrossFigure(record, "full", rowDecimals) : "--"
  // The sheet leads with what lands on L2; the gross the wallet was charged is the Sent row. A
  // deposit that never credits L2 has no net anyone is owed, so it leads with that gross instead.
  const headline =
    !neverCreditsL2(record.phase) && amounts.netAtomic > 0n
      ? usdFigure(amounts.netDisplay)
      : sentFigure
  const funderUrl = address ? l1AddressUrl(address) : undefined
  const sipaUrl = l1AddressUrl(record.sipaAddress)
  // What the funder sent; a swept record's `tokenSymbol` is the credited token.
  const fundingSymbol = record.fundingTokenSymbol ?? record.tokenSymbol
  const { shown: processing, capacityKey } = useSipaProcessing(record.sipaAddress)
  const settlementSymbol = settledSymbol(depositTokens, record.tokenAddress, record.tokenSymbol)
  const bridged = bridgeIn?.record
  const bridgedFigure = (atomic: string) =>
    bridged && coinFigure(BigInt(atomic), bridged.inputDecimals, bridged.symbol)
  // Records saved before `feeUsd` came from dollar coins, whose quote rate prices them.
  const bridgedUsd =
    bridged &&
    bridgeFeeUsd(
      {
        fee: BigInt(bridged.fee),
        inputAmount: BigInt(bridged.inputAmount),
        outputAmount: BigInt(bridged.outputAmount),
        feeUsd: bridged.feeUsd,
      },
      bridged.outputDecimals,
    )
  // One fee in dollars: the bridge's and the deposit's, whichever are known. The settlement coin
  // is a dollar coin.
  const feeParts = [bridgedUsd, showBreakdown ? amounts.feeDisplay : undefined].filter(
    (part): part is string => part !== undefined,
  )
  const fee = feeParts.length > 0 ? feeParts.reduce(addDollars) : undefined
  const sentSymbol = bridged?.symbol ?? fundingSymbol
  // What it lands as: the bridge's output, else what the deposit settles in.
  const landedSymbol = bridged?.outputSymbol ?? settlementSymbol
  const coinIcon = (symbol: string) => {
    const icon = depositTokens?.options.find((t) => t.symbol === symbol)?.icon
    return icon && <img src={icon} alt="" width={16} height={16} />
  }
  const sentHop = {
    label: sentSymbol,
    icon: bridged ? (
      <OriginTokenIcon symbol={bridged.symbol} coins={depositTokens?.options ?? []} size={16} />
    ) : (
      coinIcon(sentSymbol)
    ),
  }
  const ethereumHop = {
    label: copy.ethereum,
    icon: <img src={ethIcon} alt="" width={16} height={16} />,
  }

  return (
    <Modal
      variant="create"
      label={registrationTag ? "Registration deposit details" : "Deposit details"}
      className="ww-sheet ww-sheet--detail"
      onBack={onBack}
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
      {processing && (
        <DepositProcessingNotice
          sipaAddress={record.sipaAddress}
          state={processing}
          symbol={settlementSymbol}
          help={(detail) => (
            <PendingLimitsLink
              sipaAddress={record.sipaAddress}
              capacityKey={capacityKey}
              settlementSymbol={settlementSymbol}
              detail={detail}
            />
          )}
        />
      )}

      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue {...status} />
        </DepositFact>
        {registrationTag && (
          <DepositFact label="Name">
            <b>{registrationTag}.zk.money</b>
          </DepositFact>
        )}
        {/* A direct migration deposit has no funder: the upgrade made it. */}
        {bridged ? (
          <DepositFact label={copy.from}>
            <b>
              <L1AddressLabel
                address={bridged.depositor}
                name={bridgeIn.walletName || undefined}
                href={originAddressUrl(bridged.originChainId, bridged.depositor)}
              />
            </b>
          </DepositFact>
        ) : (
          !record.direct && (
            <DepositFact label={copy.from}>
              <b>
                {address ? (
                  <L1AddressLabel address={address} name={title || undefined} href={funderUrl} />
                ) : (
                  title || "--"
                )}
              </b>
            </DepositFact>
          )
        )}
        {bridged?.originTxHash ? (
          <DepositHashFact
            label={copy.txHash}
            hash={bridged.originTxHash}
            url={originTxUrl(bridged.originChainId, bridged.originTxHash)}
          />
        ) : fundingTxHash ? (
          <DepositHashFact label={copy.txHash} hash={fundingTxHash} url={l1TxUrl(fundingTxHash)} />
        ) : (
          <DepositFact label={copy.txHash}>
            <b>--</b>
          </DepositFact>
        )}
        <DepositFact label="Token">
          <b>
            <Hops
              hops={
                landedSymbol === sentSymbol
                  ? [sentHop]
                  : [sentHop, { label: landedSymbol, icon: coinIcon(landedSymbol) }]
              }
            />
          </b>
        </DepositFact>
        <DepositFact label="Network">
          <b>
            <Hops
              hops={
                bridged
                  ? [
                      {
                        label: bridgeIn?.chainName ?? "--",
                        icon: (
                          <ChainIcon
                            chainId={bridged.originChainId}
                            name={bridgeIn?.chainName ?? ""}
                            size={16}
                          />
                        ),
                      },
                      ethereumHop,
                    ]
                  : [ethereumHop]
              }
            />
          </b>
        </DepositFact>
        <DepositFact label="Sent">
          <b>{bridged ? bridgedFigure(bridged.inputAmount) : sentFigure}</b>
        </DepositFact>
        {fee !== undefined && (
          <DepositFact label="Fee">
            <b data-testid="deposit-detail-fee">-{usdFigure(fee)}</b>
          </DepositFact>
        )}
        {/* A direct migration deposit has no deposit address: its key holds nothing on L1. */}
        {!record.direct && (
          <DepositHashFact label="Deposit address" hash={record.sipaAddress} url={sipaUrl} />
        )}
        {bridged?.fillTxHash && (
          <DepositHashFact
            label={copy.bridgeTx}
            hash={bridged.fillTxHash}
            url={l1TxUrl(bridged.fillTxHash)}
          />
        )}
        {record.sweepTxHash && !record.direct && (
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
        {showBreakdown && (
          <>
            <hr className="ww-divider" />
            <DepositFact label="Received">
              <b data-testid="deposit-detail-received">
                {tokenFigure(amounts.netDisplay, settlementSymbol)}
              </b>
            </DepositFact>
          </>
        )}
      </div>

      {record.phase === "recoverable" && (
        <p className="ww-sheet__note">{unsweepableCopy(record, txAmountCap, rowDecimals)}</p>
      )}
      {exit && (
        <PrimaryGradientButton
          title={exit.title}
          buttonStyle={exit.sweep ? "dark" : undefined}
          onClick={exit.onStart}
        />
      )}
    </Modal>
  )
}

/** The tag a registration deposit paid for, apart from the deposit that carried the payment. */
export function TagPurchaseModal({
  record,
  tag,
  price,
  onClose,
}: {
  record: SipaDeposit
  tag: string
  /** Display units. */
  price: string
  onClose: () => void
}) {
  const { l1AddressUrl } = useL1Links()
  return (
    <Modal
      variant="create"
      label="Tag purchase details"
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <Icon name="at" size={32} color="#fff" />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          -{usdFigure(price)}
        </GradientText>
        <small>{whenLabel(record.endTime ?? record.startTime)}</small>
      </div>
      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue {...depositStatus(record)} />
        </DepositFact>
        <DepositFact label="Name">
          <b>{tag}.zk.money</b>
        </DepositFact>
        <DepositHashFact
          label="Paid from deposit"
          hash={record.sipaAddress}
          url={l1AddressUrl(record.sipaAddress)}
        />
      </div>
    </Modal>
  )
}
