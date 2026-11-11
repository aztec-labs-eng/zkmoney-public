import {
  Icon,
  IconCircle,
  PrimaryGradientButton,
  Spinner,
  StatusBadge,
} from "@obsidion/web-ds"
import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { useL1Links, whenLabel } from "../../ui/detailRows"
import { shortAddr, usdFigure } from "../../ui/format"
import { DepositFact } from "../../ui/screens/DepositFact"
import { BroadcastStatusRow } from "../broadcasts/BroadcastStatusRow/BroadcastStatusRow"
import { failureLine, type BackupFailure } from "./backupFailure"
import {
  approveCopy,
  attentionLine,
  costCopy,
  entryCopy,
  formatDai,
  fundCopy,
  moveCopy,
  panelCopy,
  recoveryCopy,
  rotationSteps,
  stepDetail,
  stepIndex,
  type NamedLine,
} from "./backupPasskeyCopy"
import type {
  BackupActions,
  BackupPayFacts,
  BackupScreen,
  RotationScreen,
} from "./backupScreen"
import { IntroScreen } from "./screens/IntroScreen/IntroScreen"
import { KeysScreen } from "./screens/KeysScreen/KeysScreen"
import { PlaceScreen } from "./screens/PlaceScreen/PlaceScreen"
import "./backupPasskey.css"

/*
 * Today's Passkeys panel, drawn from a screen's props. Each screen renders it until the
 * redesign's sheet for that screen replaces it; a failure raised over A1–A3 shows here under them.
 */

function Named({ line: [before, name, after] }: { line: NamedLine }) {
  return (
    <>
      {before}
      {name && <b>{name}</b>}
      {after}
    </>
  )
}

/** A failure on the step it stopped; a declined approval names the passkey to use. */
function stepLine(failure: BackupFailure, approver?: string): React.ReactNode {
  // A wrong passkey ends the prompt the way a closed one does.
  if (failure.step === "approve" && failure.kind === "declined")
    return <Named line={approveCopy.declined(approver)} />
  return failureLine(failure)
}

function Steps({ current, detail }: { current: number; detail?: React.ReactNode }) {
  return (
    <ol className="ww-backup__steps" aria-label="Backup passkey steps">
      {rotationSteps.map((label, i) => {
        const state = current > i ? "done" : current === i ? "current" : "todo"
        return (
          <li
            key={label}
            className={`zkm-step-row ww-backup__step ww-backup__step--${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="zkm-step-row__bullet">
              {state === "done" ? (
                <Icon name="check" size={14} color="var(--accent-green)" />
              ) : (
                i + 1
              )}
            </span>
            <span className="zkm-step-row__text">
              <span className="ww-backup__step-label">{label}</span>
              {state === "current" && detail && <span className="ww-backup__detail">{detail}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function FundScreen({
  pay,
  busy,
  onFund,
  onCancel,
}: {
  pay: BackupPayFacts
  busy: boolean
  onFund: () => void
  onCancel: () => void
}) {
  const { sent, fees, credited } = pay
  // Dollars, as the funding's Activity row and the balance show them.
  const usd = (atomic: bigint) => usdFigure(formatUnits(atomic, DEFAULT_DECIMALS))
  return (
    <div className="ww-backup__fund" data-testid="backup-fund">
      <div className="ww-sheet__facts">
        <DepositFact label={fundCopy.destination}>
          <b>{shortAddr(pay.address)}</b>
        </DepositFact>
        <DepositFact label={costCopy.sent}>
          <b>{usd(sent)}</b>
        </DepositFact>
        {typeof fees === "bigint" ? (
          <DepositFact label={costCopy.fees}>
            <b>-{usd(fees)}</b>
          </DepositFact>
        ) : (
          <>
            <DepositFact label={costCopy.withdrawalFee}>
              <b>-{usd(fees.withdrawal)}</b>
            </DepositFact>
            <DepositFact label={costCopy.accountChangeFee}>
              <b>-{usd(fees.accountChange)}</b>
            </DepositFact>
          </>
        )}
        <DepositFact label={fundCopy.approvals}>
          <b>{fundCopy.approvalsValue(pay.approvals, pay.moves, pay.refunds)}</b>
        </DepositFact>
        <DepositFact label={fundCopy.takes}>
          <b>{fundCopy.takesValue}</b>
        </DepositFact>
        <hr className="ww-divider" />
        <DepositFact label={fundCopy.receive}>
          <b>{usd(credited)}</b>
        </DepositFact>
      </div>
      <div className="ww-backup__actions">
        <PrimaryGradientButton
          title={fundCopy.fund}
          isLoading={busy}
          onClick={onFund}
          testId="backup-fund-continue"
        />
        <SecondaryButton label={panelCopy.cancel} onClick={onCancel} disabled={busy} />
      </div>
      <p className="ww-sheet__note ww-backup__fine">{fundCopy.afterSend}</p>
    </div>
  )
}

/** An address or a hash, linked to its explorer where the L1 has one. */
function ExplorerValue({ value, url }: { value: string; url?: string }) {
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {shortAddr(value)}
      <Icon name="share-box" size={12} color="currentColor" />
    </a>
  ) : (
    <b>{shortAddr(value)}</b>
  )
}

/** The card's own action, sized like the Activity row's so the card reads as one object. */
function CardAction({
  label,
  busy,
  onClick,
  testId,
}: {
  label: string
  busy: boolean
  onClick: () => void
  testId: string
}) {
  // The action bar wrapper gives the button its height: alone in the card's column, its flex basis
  // of 0 would collapse it.
  return (
    <div className="zkm-activity-row__actions">
      <button
        type="button"
        className="zkm-btn-reset zkm-pressable zkm-activity-action zkm-activity-action--gradient"
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={busy ? label : undefined}
        onClick={onClick}
        data-testid={testId}
      >
        {busy ? <Spinner size={16} color="#fff" /> : label}
      </button>
    </div>
  )
}

const RECOVERY_BADGE = { held: "failed", sent: "pending", recovered: "cancelled" } as const

/**
 * An attempt whose funding has to go back, shown in place of the steps: none of the five steps is
 * true of an attempt that will not add its backup. Once sent there is no main button, so it does not
 * read as "press again"; a link still recovers funding that lands later.
 */
function RecoveryCard({
  screen,
  onRecover,
  onDone,
}: {
  screen: Extract<BackupScreen, { id: "recovery" }>
  onRecover: () => void
  onDone: () => void
}) {
  const { l1TxUrl, l1AddressUrl } = useL1Links()
  const { state, extra, busy, empty, recoveryTx, sipa } = screen
  const line =
    state !== "held"
      ? recoveryCopy.line[state]
      : extra
      ? recoveryCopy.line.extra
      : screen.damaged
      ? recoveryCopy.line.damaged
      : recoveryCopy.line.held
  return (
    <div className="zkm-activity-row ww-backup__recovery" data-testid="backup-recovery">
      <div className="zkm-activity-row__top">
        <IconCircle name="shield-exclamation" size={44} />
        <div className="zkm-activity-row__who">
          <span className="zkm-activity-row__name">
            {extra ? recoveryCopy.extraTitle : recoveryCopy.title}
          </span>
          <span className="zkm-activity-row__time">
            {extra ? recoveryCopy.extraSubtitle : recoveryCopy.started(whenLabel(screen.startedAt))}
          </span>
        </div>
        <StatusBadge label={recoveryCopy.badge[state]} badgeStyle={RECOVERY_BADGE[state]} />
      </div>
      <p className="ww-backup__recovery-line">{line}</p>
      <div className="ww-backup__recovery-facts">
        {screen.deposited !== undefined && (
          <DepositFact label={recoveryCopy.funding}>
            <b>{formatDai(screen.deposited)}</b>
          </DepositFact>
        )}
        {recoveryTx ? (
          <DepositFact label={recoveryCopy.recovery}>
            <ExplorerValue value={recoveryTx} url={l1TxUrl(recoveryTx)} />
          </DepositFact>
        ) : (
          sipa && (
            <DepositFact label={recoveryCopy.depositAddress}>
              <ExplorerValue value={sipa} url={l1AddressUrl(sipa)} />
            </DepositFact>
          )
        )}
      </div>
      {state === "held" && (
        <>
          <p className="ww-backup__recovery-note" aria-live="polite">
            {empty ? recoveryCopy.nothingYet : recoveryCopy.gas}
          </p>
          <CardAction
            label={recoveryCopy.recover}
            busy={busy}
            onClick={onRecover}
            testId="backup-recover"
          />
        </>
      )}
      {state === "sent" && (
        // The link stays after an empty check: funding that lands later keeps the same recovery, so
        // the empty note would never clear on its own.
        <p className="ww-backup__recovery-note" aria-live="polite">
          {empty ? (
            <span className="ww-backup__recovery-checked">
              <Icon name="check-circle" size={14} color="currentColor" />
              {recoveryCopy.nothingNew}
            </span>
          ) : (
            recoveryCopy.later
          )}{" "}
          <button
            type="button"
            className="zkm-btn-reset ww-deposit__link"
            onClick={onRecover}
            disabled={busy}
            data-testid="backup-recover-later"
          >
            {recoveryCopy.checkAddress}
          </button>
        </p>
      )}
      {state === "recovered" && (
        <CardAction label={recoveryCopy.done} busy={busy} onClick={onDone} testId="backup-done" />
      )}
    </div>
  )
}

/** A step's way out, under its primary action. */
function SecondaryButton({
  label,
  onClick,
  disabled,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <PrimaryGradientButton
      title={label}
      buttonStyle="dark"
      isDisabled={disabled}
      onClick={onClick}
    />
  )
}

/** An attempt the user dropped: its passkey stays on the device. */
function CancelledLine() {
  return (
    <p className="ww-sheet__note" data-testid="backup-cancelled">
      {panelCopy.cancelled} {panelCopy.leftoverPasskey}
    </p>
  )
}

/** A start screen with the failure raised over it, which has no sheet of its own yet. */
const withFailure = (screen: React.ReactNode, failure?: BackupFailure) => (
  <>
    {screen}
    {failure && (
      <p className="ww-search__error" aria-live="assertive">
        {failureLine(failure)}
      </p>
    )}
  </>
)

/** The step today's five a screen is on, and its line; -1 when a parked state is on none. */
function stepsOf(screen: RotationScreen): { current: number; detail?: React.ReactNode } {
  switch (screen.id) {
    case "approve":
      return {
        current: stepIndex(screen.progress),
        detail:
          screen.progress.stage === "sign" ? (
            <Named line={approveCopy.detail(screen.approver)} />
          ) : (
            stepDetail(screen.progress)
          ),
      }
    case "adding":
      return screen.delay === "route"
        ? { current: -1 }
        : { current: stepIndex(screen.progress), detail: stepDetail(screen.progress) }
    case "finish":
      if (screen.paused) return { current: -1 }
      return {
        current: stepIndex(screen.progress),
        detail:
          screen.ask === "approve" || screen.declined
            ? moveCopy.line(screen.progress)
            : screen.linkExpiring
            ? moveCopy.linkExpiring
            : stepDetail(screen.progress),
      }
    case "done":
      return { current: rotationSteps.length }
    default:
      return { current: -1 }
  }
}

/**
 * A pending rotation: the step it is on, what the user can do there, and the side states. The
 * session's driver resumes it; the host runs the steps the user taps.
 */
function RotationStandIn({
  screen,
  actions,
  failure: over,
}: {
  screen: Exclude<RotationScreen, { id: "failed" }>
  actions: BackupActions
  failure?: BackupFailure
}) {
  const failure = over ?? screen.failure
  const approver = "approver" in screen ? screen.approver : undefined
  const error = failure && stepLine(failure, approver)
  const stage = "progress" in screen ? screen.progress.stage : undefined
  const busy = "busy" in screen && screen.busy
  const checking = "checking" in screen && screen.checking
  const canCancel = "canCancel" in screen && screen.canCancel
  const cancel = <SecondaryButton label={panelCopy.cancel} onClick={actions.cancel} disabled={busy} />
  const tryAgain = (
    <PrimaryGradientButton
      title={panelCopy.tryAgain}
      isLoading={checking}
      onClick={actions.check}
      testId="backup-watch-retry"
    />
  )
  // The error is part of the line where the step itself is the check.
  let errorInline = false
  let body: React.ReactNode
  if (screen.id === "recovery") {
    body = <RecoveryCard screen={screen} onRecover={actions.recover} onDone={actions.finish} />
  } else if (screen.id === "approve" && screen.progress.stage === "sign") {
    body = (
      <div className="ww-backup__actions">
        <PrimaryGradientButton
          title={busy ? panelCopy.approving : approveCopy.button(approver)}
          isLoading={busy}
          onClick={actions.approve}
          testId="backup-approve"
        />
        {cancel}
      </div>
    )
  } else if (screen.id === "approve" && screen.sipa) {
    body = (
      <>
        <BroadcastStatusRow address={screen.sipa.toLowerCase()} />
        <div className="ww-backup__actions">
          {error && tryAgain}
          {cancel}
        </div>
      </>
    )
  } else if (screen.id === "approve" && screen.pay) {
    body = (
      <FundScreen pay={screen.pay} busy={busy} onFund={actions.fund} onCancel={actions.cancel} />
    )
  } else if (screen.id === "approve" && screen.progress.stage === "pay") {
    errorInline = true
    body = (
      <>
        <p className="ww-sheet__note" aria-live="polite">
          {error ? (
            <>
              {error}{" "}
              <button type="button" className="zkm-btn-reset ww-deposit__link" onClick={actions.check}>
                {panelCopy.tryAgain}
              </button>
            </>
          ) : (
            entryCopy.checking
          )}
        </p>
        {cancel}
      </>
    )
  } else if (screen.id === "done") {
    body = (
      <>
        <p className="ww-sheet__note">{panelCopy.doneLine}</p>
        <PrimaryGradientButton title={panelCopy.done} onClick={actions.finish} testId="backup-done" />
      </>
    )
  } else if (screen.id === "adding" && screen.delay === "route") {
    // A recheck that could not complete says so; the parked verdict is not repeated as current.
    errorInline = true
    body = <p className="ww-sheet__note">{error ? panelCopy.unverifiable : attentionLine.route}</p>
  } else if (screen.id === "finish" && screen.ask === "retry") {
    body = (
      <>
        {screen.paused && <p className="ww-sheet__note">{attentionLine.move}</p>}
        <div className="ww-backup__actions">
          <PrimaryGradientButton
            title={panelCopy.tryAgain}
            isLoading={busy || checking || screen.approving}
            onClick={actions.retryMove}
            testId="backup-move-retry"
          />
        </div>
      </>
    )
  } else if (screen.id === "finish" && (screen.ask === "approve" || screen.approving)) {
    body = (
      <div className="ww-backup__actions">
        <PrimaryGradientButton
          title={busy || screen.approving ? panelCopy.approving : approveCopy.button(approver)}
          isLoading={busy || screen.approving}
          onClick={actions.approveMove}
          testId="backup-move-approve"
        />
      </div>
    )
  } else if (error) {
    body = (
      <div className="ww-backup__actions">
        {tryAgain}
        {canCancel && cancel}
      </div>
    )
  } else if (canCancel) {
    body = cancel
  }
  const { current, detail } = stepsOf(screen)
  return (
    <section className="ww-contacts__section ww-backup" data-testid="backup-panel">
      {/* The recovery sheet's own title names the section. */}
      {screen.id !== "recovery" && (
        <>
          <span className="ww-contacts__label">{panelCopy.title}</span>
          <Steps current={current} detail={detail} />
        </>
      )}
      <p
        className="ww-search__error ww-backup__error"
        aria-live="assertive"
        data-testid="backup-error"
      >
        {errorInline ? undefined : error}
      </p>
      {body}
      {canCancel && stage !== "sign" && (
        <p className="ww-sheet__note ww-backup__fine">{panelCopy.approvalStays}</p>
      )}
    </section>
  )
}

/** Today's UI for `screen`, with `failure` shown on it when a sheet raised over it stands in. */
export function BackupStandIn({
  screen,
  actions,
  failure,
}: {
  screen: BackupScreen
  actions: BackupActions
  failure?: BackupFailure
}) {
  if ("under" in screen && screen.under)
    return <BackupStandIn screen={screen.under} actions={actions} failure={screen.failure} />
  switch (screen.id) {
    case "loading":
      return screen.rotation ? (
        <p className="ww-sheet__note" aria-live="polite">
          {entryCopy.checking}
        </p>
      ) : screen.cancelled ? (
        <CancelledLine />
      ) : null
    case "keys":
      return withFailure(<KeysScreen screen={screen} actions={actions} />, failure)
    case "intro":
      return withFailure(<IntroScreen screen={screen} actions={actions} />, failure)
    case "place":
      return withFailure(<PlaceScreen screen={screen} actions={actions} />, failure)
    case "unreadable":
      if (screen.read === "keys") return screen.cancelled ? <CancelledLine /> : null
      if (screen.read === "entry") return null
      return (
        <p className="ww-sheet__note" aria-live="polite">
          {entryCopy.unreadable}{" "}
          <button
            type="button"
            className="zkm-btn-reset ww-deposit__link"
            onClick={() => actions.retryRead(screen.read)}
            data-testid={screen.read === "records" ? "backup-store-retry" : "backup-deps-retry"}
          >
            {panelCopy.tryAgain}
          </button>
        </p>
      )
    case "approve":
    case "adding":
    case "finish":
    case "done":
    case "recovery":
      return <RotationStandIn screen={screen} actions={actions} failure={failure} />
    // Draws its own sheet.
    case "failed":
      return null
    // Entered from A1's button; empty until their own sheets replace these.
    case "unavailable":
    case "firstPasskey":
    case "blocked":
      return null
  }
}
