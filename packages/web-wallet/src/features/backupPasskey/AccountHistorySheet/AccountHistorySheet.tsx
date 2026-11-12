import { useEffect, useRef } from "react"
import {
  ConfirmationSheetDetailRow,
  GradientSpinner,
  GradientText,
  Icon,
  IconCircle,
  PrimaryGradientButton,
} from "@obsidion/web-ds"
import { WalletError, useStore, serviceStatus, bestEffort } from "@obsidion/front-core"
import { fmt } from "../../../lib/fmt"
import { useSession } from "../../../session/session"
import { HIDDEN_BALANCE, shortAddr, usdAtomicFloor } from "../../../ui/format"
import { Modal } from "../../../ui/Modal"
import { approvalsLeft, MoveSteps, type MoveStepRow } from "../../../ui/MoveSteps/MoveSteps"
import stepsCopy from "../../../ui/MoveSteps/MoveSteps.copy"
import { selectHeldTotal, type CheckStatus, type MoveRowView } from "../accountHistory"
import { getPreviousAccountWatcher, type MoveForecast } from "../previousAccountWatcher"
import copy from "./AccountHistorySheet.copy"
import styles from "./AccountHistorySheet.module.css"

/**
 * Settings → Account history: each change that moved the account to a new address, with an
 * on-demand check for funds that reached the earlier one. Closing it stops a move before its next
 * prompt.
 */
export function AccountHistorySheet({ onClose }: { onClose: () => void }) {
  const session = useSession()
  const history = useStore(session.accountHistory)
  const watcher = getPreviousAccountWatcher()
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const hideBal = useStore(session.device, (s) => s.hideBalances)
  const leave = useRef<AbortController | undefined>(undefined)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    const controller = new AbortController()
    leave.current = controller
    return () => controller.abort()
  }, [])
  // A check's failure is its outcome, published in the watcher's state.
  const check = walletBuilt
    ? () =>
        void bestEffort(
          "unknown",
          session.wallet.ready().then((wallet) => watcher.check(wallet)),
        )
    : undefined
  const move = () => void watcher.move({ signal: leave.current?.signal })
  const amount = (atomic: bigint) => (hideBal ? HIDDEN_BALANCE : usdAtomicFloor(atomic))
  const rotation = history.kind === "rotation"
  return (
    <Modal variant="create" label={copy.title} onClose={onClose} className="ww-feedback">
      <div className="ww-passkeys__head">
        <span className="ww-deposit__connect-icon">
          <Icon name={rotation ? "key" : "history-clock"} size={24} color="#fff" />
        </span>
        <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
          {rotation ? copy.rotation : copy.title}
        </GradientText>
      </div>
      <div className={`ww-addresses ${styles.body}`} aria-live="polite">
        {rotation ? (
          <>
            <div className={`ww-contacts__group ${styles.rows}`}>
              <ConfirmationSheetDetailRow
                label={copy.earlier}
                value={<span className={styles.address}>{shortAddr(history.earlier)}</span>}
              />
            </div>
            <Status status={history.status} check={check} move={move} amount={amount} />
          </>
        ) : (
          <p className={`ww-sheet__note ${styles.note}`}>{copy.empty}</p>
        )}
      </div>
    </Modal>
  )
}

function Busy({ title }: { title: string }) {
  return (
    <div className={styles.status}>
      <GradientSpinner size={48} />
      <span className={styles.statusTitle}>{title}</span>
    </div>
  )
}

/** A balance's row: it turns while the move works on it, and says how far a paused move got. */
function stepRow({ kind, state }: MoveRowView, paused: boolean): MoveStepRow {
  const label = kind === "main" ? copy.main : copy.savings
  switch (state) {
    case "moved":
      return { label, state: "done" }
    case "preparing":
      return { label, state: "current", detail: stepsCopy.preparing }
    case "confirming":
      return { label, state: "current", detail: stepsCopy.confirming }
    case "working":
      return { label, state: "current" }
    case "partial":
      return { label, state: "todo", detail: copy.steps.partly }
    case "none":
      return { label, state: "todo", ...(paused && { detail: copy.steps.notMoved }) }
  }
}

/** How many approvals the move takes, or the plain line where none could be planned. */
function approvalsLine(forecast: MoveForecast | undefined): string {
  if (!forecast) return copy.approve
  if (forecast.upper) return fmt(copy.approveUpTo, { count: forecast.approvals })
  return forecast.approvals === 1
    ? copy.approveOnce
    : fmt(copy.approveCount, { count: forecast.approvals })
}

function Status({
  status,
  check,
  move,
  amount,
}: {
  status: CheckStatus
  check?: () => void
  move: () => void
  amount: (atomic: bigint) => string
}) {
  switch (status.kind) {
    case "settingUp":
      return <p className={`ww-sheet__note ${styles.note}`}>{copy.settingUp}</p>
    case "setupUnread":
      return <p className={`ww-sheet__note ${styles.note}`}>{copy.setupUnread}</p>
    case "unchecked":
      return (
        <>
          <p className={`ww-sheet__note ${styles.note}`}>{copy.hint}</p>
          <PrimaryGradientButton title={copy.check} isDisabled={!check} onClick={check} />
        </>
      )
    case "checking":
      return <Busy title={copy.checking} />
    case "incomplete":
      return (
        <>
          <div className={styles.status}>
            <Icon name="alert-circle" size={40} color="var(--accent-pink)" />
            <span className={styles.statusTitle}>{copy.incomplete}</span>
          </div>
          <PrimaryGradientButton
            buttonStyle="secondary"
            title={copy.tryAgain}
            isDisabled={!check}
            onClick={check}
          />
        </>
      )
    case "unclaimed":
      return (
        <>
          <div className={styles.status}>
            <Icon name="alert-circle" size={40} color="var(--accent-pink)" />
            <span className={styles.statusTitle}>{copy.unclaimed}</span>
          </div>
          <p className={`ww-sheet__note ${styles.note}`}>{copy.unclaimedNote}</p>
          <PrimaryGradientButton
            buttonStyle="secondary"
            title={copy.checkAgain}
            isDisabled={!check}
            onClick={check}
          />
        </>
      )
    case "empty":
    case "moved":
      return (
        <>
          <div className={styles.status}>
            <IconCircle name="check-circle" size={56} glyphSize={26} />
            <GradientText gradient="title" size={20} weight={700}>
              {status.kind === "moved" ? copy.moved : copy.nothing}
            </GradientText>
          </div>
          <PrimaryGradientButton
            buttonStyle="secondary"
            title={copy.checkAgain}
            isDisabled={!check}
            onClick={check}
          />
        </>
      )
    case "moving":
      if (status.rows.length === 0) return <Busy title={copy.moving} />
      return (
        <>
          {status.earlier && (
            <p className={`ww-sheet__note ${styles.note}`}>{copy.steps.earlier}</p>
          )}
          <MoveSteps
            caption={copy.steps.moving}
            header={approvalsLeft(status.left?.count, status.left?.upper)}
            rows={status.rows.map((row) => stepRow(row, false))}
            note={copy.steps.keepOpen}
          />
        </>
      )
    case "found": {
      const total = selectHeldTotal(status.held)
      return (
        <>
          {status.rows && (
            <MoveSteps
              caption={copy.steps.paused}
              rows={status.rows.map((row) => stepRow(row, true))}
            />
          )}
          {total !== undefined && (
            <div className={styles.status}>
              <GradientText gradient="title" size={40} weight={700}>
                {amount(total)}
              </GradientText>
              <span className="ww-sheet__note">{copy.foundCaption}</span>
            </div>
          )}
          <div className={`ww-contacts__group ${styles.rows}`}>
            {status.held.map((holding) => (
              <ConfirmationSheetDetailRow
                key={holding.kind}
                label={holding.kind === "main" ? copy.main : copy.savings}
                value={
                  holding.kind === "main"
                    ? amount(holding.amount)
                    : holding.value === undefined
                    ? copy.unpriced
                    : amount(holding.value)
                }
              />
            ))}
          </div>
          {status.note && (
            <p className={`ww-sheet__note ${styles.note}`}>{copy.note[status.note]}</p>
          )}
          {(status.action === "move" || status.action === "continue") && (
            <>
              <PrimaryGradientButton
                title={status.action === "move" ? copy.move : copy.continue}
                onClick={move}
              />
              <p className={`ww-sheet__note ${styles.note}`}>{approvalsLine(status.forecast)}</p>
            </>
          )}
          {status.action === "retry" && (
            <PrimaryGradientButton title={copy.tryAgain} onClick={move} />
          )}
          <PrimaryGradientButton
            buttonStyle="secondary"
            title={copy.checkAgain}
            isDisabled={!check}
            onClick={check}
          />
        </>
      )
    }
    default: {
      const unhandled: never = status
      throw new WalletError(
        "invariant",
        `AccountHistorySheet: unhandled status ${(unhandled as { kind: string }).kind}`,
      )
    }
  }
}
