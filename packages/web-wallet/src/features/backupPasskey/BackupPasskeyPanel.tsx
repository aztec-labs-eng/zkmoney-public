import { useEffect, useRef, useState } from "react"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  cancelRotation,
  cancellable,
  fundingLanding,
  fundRotation,
  resumeRotation,
  retryMove,
  RotationFlowError,
  signRotation,
  type BackupRotationRecord,
  type FlowRefusal,
  type FlowResult,
  type FlowWait,
} from "@obsidion/front-core"
import { isPasskeyCancelled, passkeyWritten } from "@obsidion/passkey-web"
import { BackupCredentialIdLengthError, RotationRouteNotLiveError } from "@obsidion/sdk"
import { formatUnits } from "viem"
import { shortAddr, tokenFigure } from "../../ui/format"
import { DepositFact } from "../../ui/screens/DepositFact"
import { BroadcastStatusRow } from "../broadcasts/BroadcastStatusRow"
import { BackupStepError, LeftoverPasskeyError } from "./backupPasskeyAdd"
import {
  approveCopy,
  attentionCopy,
  entryCopy,
  fundCopy,
  panelCopy,
  rotationSteps,
  stepDetail,
  stepIndex,
  type NamedLine,
} from "./backupPasskeyCopy"
import type { BackupFlowDeps } from "./backupPasskeyRuntime"
import "./backupPasskey.css"

/** How long the panel waits before asking the chain again while a step is pending on it. */
export const RESUME_POLL_MS = 15_000

export const formatDai = (atomic: bigint) =>
  tokenFigure(formatUnits(atomic, DEFAULT_DECIMALS), "DAI")

/**
 * Logs a failure by its name and, for a step the record refused, its code. No message, cause or
 * field reaches the console: the driver's and the flow's errors are not a secrecy boundary.
 */
export function warnFailure(what: string, error: unknown): void {
  if (error instanceof LeftoverPasskeyError)
    return warnFailure(`${what} after creation`, error.cause)
  const name = error instanceof Error ? error.name : typeof error
  const code =
    error instanceof BackupStepError || error instanceof RotationFlowError ? ` ${error.code}` : ""
  console.warn(`[backup-passkey] ${what}: ${name}${code}`)
}

/**
 * What an action's failure says, in the user's terms, with the leftover line once when a passkey
 * was written before the failure: by the driver's own marker, or by a step after it returned.
 */
export function errorLine(error: unknown): string {
  if (error instanceof LeftoverPasskeyError)
    return `${failureLine(error.cause)} ${panelCopy.leftoverPasskey}`
  const line = failureLine(error)
  return written(error) ? `${line} ${panelCopy.leftoverPasskey}` : line
}

function written(error: unknown): boolean {
  try {
    return passkeyWritten(error)
  } catch {
    return false
  }
}

/** What a refusal of the flow's says; `phase` and `gone` are shown by the record itself. */
const refusalLine: Partial<Record<FlowRefusal, string>> = {
  "funding-open": panelCopy.fundingOnItsWay,
  "not-cancellable": panelCopy.notCancellable,
}

function failureLine(error: unknown): string {
  if (error instanceof RotationRouteNotLiveError) return panelCopy.routeNotLive
  if (error instanceof BackupCredentialIdLengthError) return panelCopy.credentialIdTooLong
  if (error instanceof RotationFlowError && refusalLine[error.code]) return refusalLine[error.code]!
  return declined(error) ? panelCopy.declined : panelCopy.unverifiable
}

function declined(error: unknown): boolean {
  try {
    return isPasskeyCancelled(error)
  } catch {
    // An error whose fields throw when read is still a failure.
    return false
  }
}

function Named({ line: [before, name, after] }: { line: NamedLine }) {
  return (
    <>
      {before}
      {name && <b>{name}</b>}
      {after}
    </>
  )
}

/** A refusal the record already shows: the step ran elsewhere, or the attempt is gone. */
const alreadyShown = (error: unknown) =>
  error instanceof RotationFlowError && (error.code === "phase" || error.code === "gone")

/** What a resume reads off the record: a record whose key changed is resumed again. */
const resumeKey = (record: BackupRotationRecord) =>
  [
    record.attemptId,
    record.phase,
    record.attention,
    record.suspended,
    record.publish?.count,
    ...record.fundings.map((funding) => `${funding.localId}:${funding.outcome}`),
  ].join("|")

function Steps({ record, approver }: { record: BackupRotationRecord; approver?: string }) {
  const current =
    record.phase === "attention" || record.phase === "conflict" ? -1 : stepIndex(record)
  const detail =
    record.phase === "created" ? <Named line={approveCopy.detail(approver)} /> : stepDetail(record)
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
  record,
  busy,
  onFund,
  onCancel,
}: {
  record: BackupRotationRecord
  busy: boolean
  onFund: () => void
  onCancel: () => void
}) {
  const plan = record.plan!
  const amount = BigInt(plan.fundingAmount)
  const credited = BigInt(plan.credited)
  return (
    <div className="ww-backup__fund" data-testid="backup-fund">
      <div className="ww-sheet__facts">
        <DepositFact label={fundCopy.destination}>
          <b>{shortAddr(plan.address)}</b>
        </DepositFact>
        <DepositFact label={fundCopy.fees}>
          <b>{formatDai(amount - credited)}</b>
        </DepositFact>
        <DepositFact label={fundCopy.approvals}>
          <b>{fundCopy.approvalsValue(plan.approvals, plan.moves)}</b>
        </DepositFact>
        <DepositFact label={fundCopy.takes}>
          <b>{fundCopy.takesValue}</b>
        </DepositFact>
        <hr className="ww-divider" />
        <DepositFact label={fundCopy.receive}>
          <b>{formatDai(credited)}</b>
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

/**
 * A pending rotation from its saved record: the step it is on, what the user can do there, and
 * the side states. The flow is resumed over the record whenever it changes and polled while a step
 * waits on the chain or a resume failed; the approval and the funding wait for the user.
 */
export function BackupPasskeyPanel({
  record,
  deps,
  approver,
  onCancelled,
  onFinished,
  pollMs = RESUME_POLL_MS,
}: {
  record: BackupRotationRecord
  deps: BackupFlowDeps
  /** The approving passkey's custom or manager name; unnamed where it has neither. */
  approver?: string
  /** The attempt was dropped; the caller shows the leftover-passkey line. */
  onCancelled: () => void
  onFinished: () => void
  pollMs?: number
}) {
  const [busy, setBusy] = useState(false)
  const [stepError, setStepError] = useState<{ error: unknown; approving: boolean }>()
  const [resume, setResume] = useState<{ wait?: FlowWait; error?: string; again: boolean }>()
  const [resumeRun, setResumeRun] = useState(0)
  const latest = useRef(record)
  latest.current = record
  const resuming = useRef<{ key: string; promise: Promise<FlowResult> }>(undefined)

  const run = async (step: () => Promise<unknown>, approving = false) => {
    setBusy(true)
    setStepError(undefined)
    try {
      await step()
    } catch (err) {
      if (alreadyShown(err)) return
      warnFailure("step failed", err)
      setStepError({ error: err, approving })
    } finally {
      setBusy(false)
    }
  }

  // One resume at a time, over the record as it stands. The record a resume writes re-runs this
  // effect while that resume is still settling: its result is for the record it read, so the new
  // record is resumed once it ends.
  const resumable = record.phase !== "created"
  const key = resumeKey(record)
  useEffect(() => {
    if (!resumable) return
    let stale = false
    setResume(undefined)
    const inFlight = resuming.current
    if (inFlight && inFlight.key !== key) {
      const again = () => {
        if (!stale) setResumeRun((n) => n + 1)
      }
      inFlight.promise.then(again, again)
      return () => {
        stale = true
      }
    }
    const flight = inFlight ?? {
      key,
      promise: resumeRotation(deps, latest.current).finally(() => {
        resuming.current = undefined
      }),
    }
    resuming.current = flight
    flight.promise.then(
      (result) => {
        if (!stale) setResume({ wait: result.wait, again: false })
      },
      (err) => {
        if (stale || alreadyShown(err)) return
        warnFailure("resume failed", err)
        setResume({ error: errorLine(err), again: true })
      },
    )
    return () => {
      stale = true
    }
  }, [deps, resumable, key, resumeRun])

  // A step waiting on the chain, a resume that failed, and a park the chain alone can lift are asked
  // again after a while; the funding waits for the user.
  const wait = resume?.wait
  const parked = record.attention === "route" || record.attention === "stranded"
  const again =
    resume !== undefined && (resume.again || (wait !== undefined && wait !== "funding") || parked)
  useEffect(() => {
    if (!again) return
    const timer = setTimeout(() => setResumeRun((n) => n + 1), pollMs)
    return () => clearTimeout(timer)
  }, [again, pollMs, resumeRun])

  const checking = resumable && resume === undefined
  // Worded here so a declined approval names the approver as it stands. A wrong passkey ends the
  // prompt the way a closed one does.
  const stepLine =
    stepError &&
    (stepError.approving && declined(stepError.error) ? (
      <Named line={approveCopy.declined(approver)} />
    ) : (
      errorLine(stepError.error)
    ))
  const error = stepLine ?? resume?.error
  const checkAgain = () => {
    setStepError(undefined)
    setResumeRun((n) => n + 1)
  }
  const cancel = () =>
    run(async () => {
      await cancelRotation(deps, record)
      onCancelled()
    })
  const retry = () => run(() => retryMove(deps, record))
  const finish = () =>
    run(async () => {
      await deps.store.remove(record.owner)
      onFinished()
    })

  const landing = record.fundings.some(fundingLanding)
  // The error is part of the line where the step itself is the check.
  let errorInline = false
  let body: React.ReactNode
  if (record.phase === "created") {
    body = (
      <div className="ww-backup__actions">
        <PrimaryGradientButton
          title={busy ? panelCopy.approving : approveCopy.button(approver)}
          isLoading={busy}
          onClick={() =>
            run(async () => signRotation(deps, record, await deps.prepare(record)), true)
          }
          testId="backup-approve"
        />
        <SecondaryButton label={panelCopy.cancel} onClick={cancel} disabled={busy} />
      </div>
    )
  } else if (record.phase === "signed" && record.rotation) {
    body = (
      <>
        <BroadcastStatusRow address={record.rotation.sipa.toLowerCase()} />
        <div className="ww-backup__actions">
          {error && (
            <PrimaryGradientButton
              title={panelCopy.tryAgain}
              isLoading={checking}
              onClick={checkAgain}
              testId="backup-watch-retry"
            />
          )}
          <SecondaryButton label={panelCopy.cancel} onClick={cancel} disabled={busy} />
        </div>
      </>
    )
  } else if (record.phase === "published" && !landing) {
    if (wait === "funding") {
      body = (
        <FundScreen
          record={record}
          busy={busy}
          onFund={() => run(() => fundRotation(deps, record))}
          onCancel={cancel}
        />
      )
    } else {
      errorInline = true
      body = (
        <>
          <p className="ww-sheet__note" aria-live="polite">
            {error ? (
              <>
                {error}{" "}
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit__link"
                  onClick={checkAgain}
                >
                  {panelCopy.tryAgain}
                </button>
              </>
            ) : (
              entryCopy.checking
            )}
          </p>
          <SecondaryButton label={panelCopy.cancel} onClick={cancel} disabled={busy} />
        </>
      )
    }
  } else if (record.phase === "done" || record.phase === "recovered") {
    body = (
      <>
        <p className="ww-sheet__note">
          {record.phase === "done" ? panelCopy.doneLine : panelCopy.recoveredLine}
        </p>
        <PrimaryGradientButton title={panelCopy.done} onClick={finish} testId="backup-done" />
      </>
    )
  } else if (record.phase === "conflict") {
    body = (
      <>
        <p className="ww-sheet__note">{panelCopy.conflict}</p>
        {cancellable(record) && (
          <SecondaryButton label={panelCopy.startOver} onClick={cancel} disabled={busy} />
        )}
      </>
    )
  } else if (record.phase === "attention" && record.attention) {
    const copy = attentionCopy(record.attention, record)
    // A recheck that could not complete says so; the parked verdict is not repeated as current.
    errorInline = record.attention === "route"
    const line = errorInline && error ? panelCopy.unverifiable : copy.line
    body = (
      <>
        <p className="ww-sheet__note">{line}</p>
        <div className="ww-backup__actions">
          {copy.actions.map((action) =>
            action === "checkAgain" ? (
              <PrimaryGradientButton
                key={action}
                title={panelCopy.checkAgain}
                isLoading={busy || checking}
                onClick={checkAgain}
              />
            ) : action === "retry" ? (
              <PrimaryGradientButton
                key={action}
                title={panelCopy.tryAgain}
                isLoading={busy || checking}
                onClick={retry}
                testId="backup-move-retry"
              />
            ) : (
              <SecondaryButton
                key={action}
                label={action === "cancel" ? panelCopy.cancel : panelCopy.startOver}
                onClick={cancel}
                disabled={busy}
              />
            ),
          )}
        </div>
      </>
    )
  } else if (error) {
    body = (
      <div className="ww-backup__actions">
        <PrimaryGradientButton
          title={panelCopy.tryAgain}
          isLoading={checking}
          onClick={checkAgain}
          testId="backup-watch-retry"
        />
        {cancellable(record) && (
          <SecondaryButton label={panelCopy.cancel} onClick={cancel} disabled={busy} />
        )}
      </div>
    )
  } else if (cancellable(record)) {
    body = <SecondaryButton label={panelCopy.cancel} onClick={cancel} disabled={busy} />
  }

  return (
    <section className="ww-contacts__section ww-backup" data-testid="backup-panel">
      <span className="ww-contacts__label">Backup passkey</span>
      <Steps record={record} approver={approver} />
      <p
        className="ww-search__error ww-backup__error"
        aria-live="assertive"
        data-testid="backup-error"
      >
        {errorInline ? undefined : error}
      </p>
      {body}
      {record.phase !== "created" && cancellable(record) && (
        <p className="ww-sheet__note ww-backup__fine">{panelCopy.approvalStays}</p>
      )}
    </section>
  )
}
