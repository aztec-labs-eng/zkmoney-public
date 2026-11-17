import { formatUnits } from "viem"
import {
  REORGED_ERROR,
  savingsMoveLabel,
  shortHex,
  type HoldingPrice,
  type MoveRecord,
  type MoveState,
  type SavingsMoveEta,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton, type StatusBadgeStyle } from "@obsidion/web-ds"
import { l2TxUrl } from "../../../lib/explorer"
import { fmt } from "../../../lib/fmt"
import { l1Links, whenLabel } from "../../../ui/detailRows"
import { shortL1Addr, tokenAmount, usdAtomic, usdAtomicFloor } from "../../../ui/format"
import { Modal } from "../../../ui/Modal"
import { DepositFact } from "../../../ui/screens/DepositFact"
import { DepositHashFact } from "../../../ui/screens/DepositHashFact"
import { DepositStatusValue } from "../../../ui/screens/DepositStatusValue"
import { TabLine } from "../../operations/TabLine"
import { useWithdrawableSources } from "../../migration/oldVersionWithdraw"
import shared from "../savingsMove.copy"
import {
  isStrandedMove,
  moveNet,
  moveValue,
  savingsMoveDestination,
  savingsMoveFigure,
  savingsMoveStatus,
  vaultSwapFigures,
} from "../savingsMove"
import { savingsEtaCopy } from "../savingsMoveTiming"
import { useSession } from "../../../session/session"
import { withdrawalFailureText } from "../../withdraw/withdrawalFailure"
import copy from "./SavingsMoveDetailModal.copy"
import styles from "./SavingsMoveDetailModal.module.css"

/**
 * The sheet's status: the row's one state, or the done state once the deposit is claimed. A delay
 * carries what the move waits on as its reason.
 */
function moveStatus(
  move: MoveRecord,
  state: MoveState,
): { label: string; badge: StatusBadgeStyle; reason?: string } {
  const status = savingsMoveStatus(move, state)
  switch (status?.kind) {
    case undefined:
      return { label: copy.status.credited, badge: "awaitingClaim" }
    case "failed":
      return { label: shared.failed, badge: "failed" }
    case "recovered":
      return { label: shared.recovered, badge: "cancelled" }
    case "stranded":
      return { label: copy.status.stranded, badge: "failed" }
    case "delayed":
      return { label: shared.delayed, badge: "pending", reason: copy.delay[status.reason] }
    case "moving":
      return {
        label:
          move.intoHoldingId === undefined ? savingsMoveLabel(move.direction) : shared.switching,
        badge: "pending",
      }
  }
}

/**
 * Why a failed burn failed, for the sheet's status: a reorg that took it back or a burn that never
 * got sent (no L2 hash), both leaving the funds in `keptIn`, else the error's first line, or a
 * plain drop by the network when it recorded none.
 */
function burnFailureReason(burn: WithdrawalRecord, keptIn: string): string | undefined {
  if (burn.phase !== "failed") return undefined
  const kept = fmt(copy.kept, { account: keptIn })
  if (burn.droppedBurn) return `${REORGED_ERROR} ${kept}`
  const code = burn.failure?.code
  const dropped =
    burn.burnDroppedAt !== undefined ||
    code === "withdrawal.dropped" ||
    code === "withdrawal.reorged"
  if (!dropped && !burn.l2TxHash) {
    // The burn's error names the active-tab takeover: another tab became the wallet before the send.
    const why = code === "withdrawal.inactiveTab" ? copy.inactiveTab : copy.notSent
    return `${why} ${kept}`
  }
  const failure = withdrawalFailureText(burn)
  if (failure) return shortHex(failure)
  return dropped ? copy.dropped : undefined
}

/**
 * A move between Main and Savings, or a swap between two vaults: its legs, figures and status,
 * with its burn and escrow as links.
 */
export function SavingsMoveDetailModal({
  move,
  state,
  burn,
  price,
  into: intoPrice,
  eta,
  onCheckAgain,
  exit,
  onWithdraw,
  onClose,
}: {
  move: MoveRecord
  state: MoveState
  /** The burn's withdrawal record, for its leg and its transactions. */
  burn?: WithdrawalRecord
  /** The move's holding, once priced. It values the move and names its vault. */
  price?: HoldingPrice
  /** A swap's destination, once priced. */
  into?: HoldingPrice
  /** How long the move still takes, while it is in flight. */
  eta?: SavingsMoveEta
  onCheckAgain?: () => void
  /** The withdrawal sheet's exit for a burn the relayer has not released: finalize it by hand. */
  exit?: { title: string; onStart: () => void }
  /** Opens Withdraw, for a move an old version closed before it finished. */
  onWithdraw?: () => void
  onClose: () => void
}) {
  const { config } = useSession().page
  const { l1TxUrl, l1AddressUrl } = l1Links(config)
  const vaultSwapped = move.intoHoldingId !== undefined
  const into = move.direction === "in"
  const vault = (held?: HoldingPrice) =>
    held ? fmt(shared.vaultName, { symbol: held.assetSymbol }) : copy.savings
  const held = vault(price)
  const from = vaultSwapped || !into ? held : copy.main
  const to = vaultSwapped ? vault(intoPrice) : into ? held : copy.main
  const { reason: delay, ...status } = moveStatus(move, state)
  const vaultSwapFigure = vaultSwapped ? vaultSwapFigures(move, price, intoPrice) : undefined
  const quoted = vaultSwapFigure ? vaultSwapFigure.left : move.quote && moveValue(move, price)
  const value = quoted === undefined ? undefined : usdAtomicFloor(quoted)
  const routed = vaultSwapFigure ? vaultSwapFigure.net : moveNet(move, price)
  const net = routed === undefined ? undefined : usdAtomicFloor(routed)
  const feeValue = vaultSwapFigure
    ? vaultSwapFigure.fee
    : quoted !== undefined && routed !== undefined
    ? quoted - routed
    : undefined
  const fee = feeValue === undefined ? undefined : usdAtomic(feeValue)
  // What the source gave up, in dollars: the quote's value, else the shares at the vault's price.
  const moved = vaultSwapFigure
    ? vaultSwapFigure.left
    : savingsMoveFigure(move, into ? "main" : "savings", price)
  // What the destination got, in dollars, once the deposit is found: what the row credits.
  const landed = vaultSwapFigure
    ? move.deposit && vaultSwapFigure.landed
    : move.deposit
    ? savingsMoveFigure(move, into ? "savings" : "main", price)
    : undefined
  const received = landed === undefined ? undefined : usdAtomicFloor(landed)
  // The shares the move landed, in the vault they landed in.
  const landedIn = vaultSwapped ? intoPrice : into ? price : undefined
  const shares =
    move.deposit && landedIn
      ? fmt(copy.shares, {
          amount: tokenAmount(formatUnits(move.deposit.amount, landedIn.shareDecimals)),
          symbol: landedIn.shareSymbol,
        })
      : undefined
  const escrow = move.rail === "skyEscrow" ? move.escrow.address : undefined
  const claimed = move.phase === "claimed"
  const recoveryTx = move.l1?.recoveryTx
  // Once the burn is out, what remains is the settle pass, and a way to run it now.
  const crediting = status.badge === "pending" && burn?.phase === "done"
  const stranded = isStrandedMove(move)
  // Withdraw refunds a deposit on an old portal this version reads, not an escrow that never ran.
  const destinationWithdrawable = useWithdrawableSources().some(
    (source) => source.savings === (savingsMoveDestination(move) === "savings"),
  )
  const withdrawable = !!onWithdraw && !!move.deposit && destinationWithdrawable
  return (
    <Modal
      variant="create"
      label={copy.label}
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <Icon name="earn" size={32} color="#fff" />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          {moved === undefined ? copy.noFigure : usdAtomicFloor(moved)}
        </GradientText>
        <small>{fmt(copy.subtitle, { from, to, when: whenLabel(move.startTime) })}</small>
      </div>

      <div className="ww-sheet__facts">
        <DepositFact label={copy.fact.status}>
          <DepositStatusValue
            {...status}
            reason={burn && status.badge === "failed" ? burnFailureReason(burn, from) : delay}
          />
        </DepositFact>
        {eta && status.badge === "pending" && !delay && (
          <DepositFact label={copy.fact.time}>
            <b>{savingsEtaCopy(eta)}</b>
          </DepositFact>
        )}
        {claimed && move.endTime !== undefined && (
          <DepositFact label={copy.fact.completed}>
            <b>{whenLabel(move.endTime)}</b>
          </DepositFact>
        )}
        <DepositFact label={copy.fact.from}>
          <b>{from}</b>
        </DepositFact>
        <DepositFact label={copy.fact.to}>
          <b>{to}</b>
        </DepositFact>
        {value && (
          <DepositFact label={copy.fact.moved}>
            <b>{value}</b>
          </DepositFact>
        )}
        {fee && (
          <DepositFact label={copy.fact.fee}>
            <b>{fmt(copy.fee, { amount: fee })}</b>
          </DepositFact>
        )}
        <hr className="ww-divider" />
        <DepositFact
          label={fmt(claimed ? copy.fact.received : copy.fact.receives, { account: to })}
        >
          <b>{received ?? (net ? fmt(copy.about, { amount: net }) : copy.noNet)}</b>
        </DepositFact>
        {shares && (
          <DepositFact label={copy.fact.shares}>
            <b>{shares}</b>
          </DepositFact>
        )}
        {burn?.l2TxHash && (
          <DepositHashFact
            label={copy.fact.aztecTx}
            hash={burn.l2TxHash}
            url={l2TxUrl(config.network, config.nodeUrl, burn.l2TxHash)}
          />
        )}
        {burn?.finalizeTxHash && (
          <DepositHashFact
            label={copy.fact.releaseTx}
            hash={burn.finalizeTxHash}
            url={l1TxUrl(burn.finalizeTxHash)}
          />
        )}
        {escrow && (
          <DepositHashFact label={copy.fact.escrow} hash={escrow} url={l1AddressUrl(escrow)} />
        )}
        {recoveryTx && (
          <DepositHashFact
            label={copy.fact.recoveryTx}
            hash={recoveryTx}
            url={l1TxUrl(recoveryTx)}
          />
        )}
      </div>
      {move.recoveredTo && (
        <p className="ww-sheet__note">
          {vaultSwapped
            ? fmt(copy.recoveredShares, {
                vault: from,
                address: shortL1Addr(move.recoveredTo),
              })
            : `${fmt(shared.recoveredTo, { address: shortL1Addr(move.recoveredTo) })}.`}
        </p>
      )}
      {stranded && (
        <p className={`ww-sheet__note ${styles.check}`}>
          {copy.stranded} {withdrawable ? copy.strandedWithdraw : copy.strandedHeld}
        </p>
      )}

      <TabLine operationId={burn?.operationId} />
      {crediting && onCheckAgain && (
        <PrimaryGradientButton title={copy.checkAgain} onClick={onCheckAgain} />
      )}
      {exit && <PrimaryGradientButton title={exit.title} onClick={exit.onStart} />}
      {stranded && withdrawable && (
        <PrimaryGradientButton title={copy.withdraw} onClick={onWithdraw} />
      )}
    </Modal>
  )
}
