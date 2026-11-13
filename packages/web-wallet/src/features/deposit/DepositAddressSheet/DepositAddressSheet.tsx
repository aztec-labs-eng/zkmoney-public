import { useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ChainIcon } from "../../../ui/ChainIcon/ChainIcon"
import { useSession } from "../../../session/session"
import { CoinIcon } from "../../../ui/CoinIcon/CoinIcon"
import { GradientText, Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { CornerButton } from "../../../ui/flow/CornerButton/CornerButton"
import { Modal } from "../../../ui/Modal"
import { StyledQr } from "../../../ui/StyledQr"
import { usePhoneLayout } from "../../../ui/usePhoneLayout"
import { useTabBoundOperation } from "../../operations/operations"
import { BroadcastStatusRow } from "../../broadcasts/BroadcastStatusRow/BroadcastStatusRow"
import { DepositFact } from "../../../ui/screens/DepositFact"
import { tokenAmountLabel } from "../AddressLimits"
import type { DepositTokenOption } from "../../sipa/loadDepositFacts"
import { WaitingBlock } from "../WaitingBlock/WaitingBlock"
import { L1AddressText } from "../../../ui/L1AddressText"
import { fmt, fmtNodes } from "../../../lib/fmt"
import {
  RING_TOKEN_SIZE,
  RingStage,
  ringStageSheet,
  type RingPhase,
  type RingStageBlock,
} from "../../../ui/flow/RingStage/RingStage"
import sendCopy from "../sendFromWallet.copy"
import copy from "./DepositAddressSheet.copy"
import styles from "./DepositAddressSheet.module.css"

/** Creating: no address to show yet. Waiting: copied, watching the address. Spotted: funds seen. */
export type DepositSheetPhase = "creating" | "ready" | "waiting" | "spotted"

/** Why a spotted amount is not simply credited: over the per-transaction limit, or over what capacity takes now. */
export type DepositSpottedProblem = "limit" | "capacity"

/** One label and value line of the limits drawer. */
export function LimitsRow({
  label,
  value,
  info,
  action,
  testId,
}: {
  label: string
  value: ReactNode
  info?: ReactNode
  action?: ReactNode
  testId?: string
}) {
  return (
    <div className={styles.row}>
      <span>
        {label}
        {info}
      </span>
      <b>
        <span data-testid={testId}>{value}</span>
        {action}
      </b>
    </div>
  )
}

/** What the spotted blocks read. */
export interface SpottedView {
  /** The amount seen at the address. */
  amount: string
  /** What it credits after the fee; absent for a swapped coin or an unknown fee. */
  arriving?: string
  swapInto?: string
  problem?: DepositSpottedProblem
  minutes?: number
  /** The per-transaction limit, named when the amount is over it. */
  limit?: string
  /** What the private funds received, once the deposit is in them. */
  arrived?: string
}

/** The ring phase and block spotted funds show, and every block the stage stacks. */
export function spottedStage(
  view: SpottedView,
  { onClose, onOpenActivity }: { onClose: () => void; onOpenActivity?: () => void },
): { ring: RingPhase; active: string; blocks: RingStageBlock[] } {
  const { problem, minutes } = view
  const title = fmt(copy.spotted.title, { amount: view.amount })
  const close = { label: copy.close, onClick: onClose }
  if (problem === "limit")
    return {
      ring: "failed",
      active: "limit",
      blocks: [
        {
          key: "limit",
          title,
          line: fmt(copy.spotted.limit, { limit: view.limit ?? copy.spotted.limitFallback }),
          note: copy.spotted.limitNote,
          button: onOpenActivity ? { label: copy.openActivity, onClick: onOpenActivity } : close,
        },
      ],
    }
  const arrival = minutes === undefined ? copy.arrivalFew : fmt(copy.arrivalMinutes, { minutes })
  const arrived = view.arrived !== undefined
  // Linked only while shown; a hidden block only reserves space.
  const activity = fmtNodes(sendCopy.arrived.note, {
    activity: arrived ? (
      <Link to="/activity" onClick={onClose}>
        {sendCopy.arrived.activity}
      </Link>
    ) : (
      sendCopy.arrived.activity
    ),
  })
  return {
    ring: arrived ? "arrived" : "arriving",
    active: arrived ? "arrived" : problem ?? "arriving",
    blocks: [
      {
        key: "arriving",
        chip: {
          text:
            minutes === undefined
              ? sendCopy.arriving.chip
              : fmt(sendCopy.chipAbout, { chip: sendCopy.arriving.chip, minutes }),
          tone: "live",
        },
        title,
        line: view.arriving
          ? fmt(copy.spotted.arriving, { amount: view.arriving })
          : view.swapInto
          ? fmt(copy.spotted.swapping, { token: view.swapInto })
          : fmt(copy.spotted.sent, { amount: view.amount }),
        note: sendCopy.arriving.note,
        button: close,
      },
      {
        key: "capacity",
        chip: { text: copy.spotted.capacityChip, tone: "live" },
        title,
        line: fmt(copy.spotted.capacity, { arrival }),
        note: sendCopy.arriving.note,
        button: close,
      },
      {
        key: "arrived",
        chip: { text: sendCopy.arrived.chip, tone: "done" },
        title: fmt(sendCopy.arrived.landedLine, {
          amount: view.arrived ?? view.arriving ?? view.amount,
        }),
        line: sendCopy.arrived.line,
        note: activity,
        button: { label: sendCopy.arrived.done, onClick: onClose },
      },
    ],
  }
}

/**
 * The address for one coin, from its creation until the funds are in the private funds. The screen
 * owns the address, the balance reads and the phase; the sheet only shows them and asks for copies
 * and reads.
 */
export function DepositAddressSheet({
  token,
  chainId,
  chainName,
  phase,
  publishing = false,
  creatingNote,
  address,
  paymentUri,
  canCopy,
  copied,
  onCopy,
  balance,
  lastReadAt,
  checking,
  onCheck,
  funded,
  arriving,
  swapInto,
  limitNow,
  limits,
  capacityNote,
  arrivalMinutes,
  onPayWithWallet,
  walletLabel = copy.walletLabel,
  readError = false,
  problem,
  limitLabel,
  arrived,
  onOpenActivity,
  ask,
  onBack,
  onClose,
}: {
  token: DepositTokenOption
  chainId: number
  chainName: string
  phase: DepositSheetPhase
  /** The address's broadcast has not landed. Shown only once funds wait on it. */
  publishing?: boolean
  /** Why the address is not here yet, when it is not just slow. */
  creatingNote?: string
  address?: string
  /** The EIP-681 transfer URI the QR encodes; absent while nothing may be scanned. */
  paymentUri?: string
  canCopy: boolean
  copied: boolean
  onCopy: () => void
  /** The last balance read at the address. */
  balance: bigint
  lastReadAt?: number
  /** A balance read is out. */
  checking: boolean
  onCheck: () => void
  funded?: bigint
  /** What the spotted amount credits after the fee, as a `$` figure; absent for a swapped coin. */
  arriving?: string
  /** The settlement token a spotted amount is swapped into, when the coin is not it. */
  swapInto?: Pick<DepositTokenOption, "symbol" | "icon">
  /** The `$` figure that fits right now, on the limits row. */
  limitNow: string
  /** The limits drawer's rows; no drawer without them. */
  limits?: ReactNode
  /** Why capacity holds a deposit sent now: zero, short, or unreadable. */
  capacityNote?: string
  /** Minutes from spotted to credited; unknown until the chain's timing is read. */
  arrivalMinutes?: number
  /** The connected-wallet path: the sheet closes and the funding flow takes over. */
  onPayWithWallet?: () => void
  walletLabel?: string
  /** The last balance read failed. */
  readError?: boolean
  problem?: DepositSpottedProblem
  /** The per-transaction limit as a `$` figure, named when the spotted amount is over it. */
  limitLabel?: string
  /** What the private funds received, once the spotted deposit is in them. */
  arrived?: string
  onOpenActivity?: () => void
  /** How much to send, when the address asks for a set amount. */
  ask?: ReactNode
  /** The step before the address; offered while the address is ready or waiting. */
  onBack?: () => void
  onClose: () => void
}) {
  const { l1Chain } = useSession().page.config
  const phone = usePhoneLayout()
  // The bell's colors: gold while this page runs work that closing would lose, green when closing is safe.
  const tabBound = !!useTabBoundOperation()
  const [limitsOpen, setLimitsOpen] = useState(false)
  const { symbol, decimals } = token
  const copiedNow = copied && phase === "ready"

  const title =
    phase === "creating"
      ? copy.title.creating
      : phase === "ready"
      ? fmt(copy.title.ready, { symbol })
      : fmt(copy.title.waiting, { symbol })
  const subtitle =
    phase === "creating"
      ? creatingNote ?? copy.subtitle.creating
      : phase === "ready"
      ? fmt(copy.subtitle.ready, { symbol, chain: chainName })
      : fmt(copy.subtitle.waiting, { symbol, chain: chainName })

  const showQr = !phone && !!paymentUri
  const copyButton = (className: string, children: ReactNode) =>
    address ? (
      <button
        type="button"
        className={className}
        data-testid="deposit-address"
        title={address}
        aria-label={copied ? copy.copied : copy.copy}
        disabled={!canCopy}
        onClick={onCopy}
      >
        {children}
      </button>
    ) : (
      <span className={styles.hint}>{copy.waitingForAddress}</span>
    )
  /**
   * The address card; while waiting it also carries the live status, one card for one address. A
   * phone has no code, so its card is the sheets' fact card: Chain, the address on one row
   * shortened in the middle, and the broadcast as a Status row. Desktop keeps the compact card with
   * the code and the full address under it.
   */
  // Funding from a wallet stays open while the copied address waits.
  const payWithWallet = onPayWithWallet && (
    <button
      type="button"
      className={`zkm-btn-reset ${styles.wallet}`}
      disabled={!canCopy}
      onClick={onPayWithWallet}
      data-testid="deposit-pay-with-wallet"
    >
      {walletLabel}
    </button>
  )
  const card = (live?: ReactNode) =>
    phone ? (
      <div className={`ww-sheet__facts ${styles.rows}`}>
        <DepositFact label={copy.address}>
          {copyButton(
            "zkm-btn-reset ww-deposit-sheet__addr ww-deposit-sheet__addr--row",
            address && <L1AddressText address={address} cut />,
          )}
        </DepositFact>
        {address && (
          <DepositFact label={copy.status}>
            <span data-testid="deposit-status">{copy.awaiting}</span>
          </DepositFact>
        )}
        {live}
      </div>
    ) : (
      <div className={`${styles.card}${live ? ` ${styles.cardLive}` : ""}`}>
        {phase === "creating" ? (
          <div className={`${styles.qr} ww-deposit-sheet__qr--pulse`} aria-hidden="true" />
        ) : (
          showQr && (
            <div className={styles.qrWrap}>
              <div className={styles.qr} aria-label={copy.qr}>
                <StyledQr value={paymentUri} icon={token.icon} />
              </div>
              {copiedNow && (
                <span className={styles.chip} data-testid="deposit-copied-chip">
                  <span className={styles.chipCheck}>
                    <Icon name="check" size={10} color="#fff" strokeWidth={3} />
                  </span>
                  {copy.chip}
                </span>
              )}
            </div>
          )
        )}
        {copyButton(
          "zkm-btn-reset ww-deposit-sheet__addr",
          address && <L1AddressText address={address} />,
        )}
        {live}
      </div>
    )

  const spotted = phase === "spotted"
  const stage =
    spotted &&
    spottedStage(
      {
        amount: tokenAmountLabel(funded ?? 0n, decimals, symbol),
        arriving,
        swapInto: swapInto?.symbol,
        problem,
        minutes: arrivalMinutes,
        limit: limitLabel,
        arrived,
      },
      { onClose, onOpenActivity },
    )

  return (
    <Modal
      variant="bare"
      label={copy.label}
      className={`ww-deposit-warning ww-deposit-sheet${spotted ? ` ${ringStageSheet}` : ""}`}
      onClose={onClose}
    >
      {onBack && (phase === "ready" || phase === "waiting") && (
        <div className="ww-deposit-warning__back">
          <CornerButton kind="back" onClick={onBack} />
        </div>
      )}
      <div className="ww-deposit-warning__close">
        <CornerButton kind="close" onClick={onClose} />
      </div>
      {!stage && (
        <div className="ww-deposit-sheet__head">
          {phase === "waiting" || phase === "creating" ? (
            <span className={styles.coinSpin} aria-busy="true" data-testid="deposit-coin-spin">
              <span
                className={`${styles.coinRing} ${tabBound ? "is-tab-bound" : "is-safe"}`}
                data-testid="deposit-coin-ring"
              />
              <CoinIcon token={token} badge={l1Chain} />
            </span>
          ) : (
            <CoinIcon token={token} badge={l1Chain} />
          )}
          <GradientText size={24} weight={700}>
            {title}
          </GradientText>
          <p className={phase === "creating" || phase === "ready" ? "" : styles.subSm}>
            {subtitle}
          </p>
          {ask}
        </div>
      )}

      {stage ? (
        <div className={styles.spotted} data-testid="deposit-spotted">
          <RingStage
            active={stage.active}
            ring={stage.ring}
            front={<CoinIcon token={token} size={RING_TOKEN_SIZE} />}
            back={<ChainIcon chainId={chainId} name={chainName} size={RING_TOKEN_SIZE} />}
            landing={<CoinIcon token={swapInto ?? token} size={RING_TOKEN_SIZE} />}
            blocks={stage.blocks}
          />
          {/* Funds wait at the address until its broadcast lands. */}
          {publishing && !problem && address && <BroadcastStatusRow address={address} />}
        </div>
      ) : (
        <>
          {phase === "waiting"
            ? card(
                <WaitingBlock
                  line={fmt(copy.balance, {
                    amount: tokenAmountLabel(balance, decimals, symbol),
                  })}
                  lastReadAt={lastReadAt}
                  readError={readError}
                  checking={checking}
                  onCheck={onCheck}
                />,
              )
            : card()}
          {capacityNote && phase !== "creating" && (
            <p className="ww-deposit-sheet__fine" role="alert" data-testid="deposit-capacity-note">
              {capacityNote}
            </p>
          )}
          {phase === "creating" ? (
            <PrimaryGradientButton
              title={copy.waiting}
              isDisabled
              className="ww-deposit-sheet__cta"
              onClick={() => {}}
            />
          ) : phase === "ready" ? (
            <>
              <PrimaryGradientButton
                title={copiedNow ? copy.copiedCta : copy.copy}
                leadingIcon={copiedNow ? "check" : "file-copy"}
                isDisabled={!canCopy}
                onClick={onCopy}
                className="ww-deposit-sheet__cta"
                testId="deposit-copy"
              />
              {payWithWallet}
            </>
          ) : (
            <>
              <button
                type="button"
                className={`zkm-btn-reset zkm-pressable ww-deposit__btn ww-deposit-sheet__ghost ${styles.ghostWide}`}
                onClick={onCopy}
              >
                {copied ? copy.copiedCta : copy.copyAgain}
              </button>
              {payWithWallet}
            </>
          )}
          {phase !== "waiting" && limits && (
            <div className={styles.limits} data-testid="address-limits">
              <button
                type="button"
                className={`zkm-btn-reset ${styles.limitsHead}`}
                aria-expanded={limitsOpen}
                onClick={() => setLimitsOpen((o) => !o)}
              >
                <span>{copy.limits}</span>
                <b>
                  {fmt(copy.limitNow, { limit: limitNow })}
                  <Icon name={limitsOpen ? "chevron-up" : "chevron-down"} size={12} />
                </b>
              </button>
              {limitsOpen && <div className={styles.limitsBody}>{limits}</div>}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
