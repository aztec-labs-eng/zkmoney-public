import { useEffect, useState, type ReactNode } from "react"
import { Icon, Spinner } from "@obsidion/web-ds"
import loopRightIcon from "../../assets/deposit/loop-right-line.svg"

/** The least a press spins for, so a read that answers at once still shows it ran. */
const CHECK_SPIN_MS = 700
const CHECKED_MS = 1500

/** Reads a figure again: spins while the read is out, then says it checked. */
export function CheckAgainPill({
  checking,
  onClick,
  testId,
}: {
  checking: boolean
  onClick: () => void
  testId?: string
}) {
  const [pressedAt, setPressedAt] = useState<number>()
  const [spun, setSpun] = useState(false)
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (pressedAt === undefined) return
    setSpun(false)
    const timer = setTimeout(() => setSpun(true), CHECK_SPIN_MS)
    return () => clearTimeout(timer)
  }, [pressedAt])
  const busy = checking || (pressedAt !== undefined && !spun)
  useEffect(() => {
    if (pressedAt === undefined || busy) return
    setChecked(true)
    setPressedAt(undefined)
  }, [pressedAt, busy])
  useEffect(() => {
    if (!checked) return
    const timer = setTimeout(() => setChecked(false), CHECKED_MS)
    return () => clearTimeout(timer)
  }, [checked])
  return (
    <button
      type="button"
      className="zkm-btn-reset ww-deposit-sheet__check"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        setChecked(false)
        setPressedAt(Date.now())
        onClick()
      }}
      data-testid={testId}
    >
      {checked ? "Checked" : "Check again"}
      {busy ? (
        <Spinner size={11} color="var(--text-primary)" />
      ) : checked ? (
        <Icon name="check" size={11} />
      ) : (
        <img src={loopRightIcon} alt="" width={11} height={11} />
      )}
    </button>
  )
}

/**
 * A watched address while its deposit is awaited: what it holds, when it was last read, and the
 * pill that reads it again. The caller owns the reads; this only shows them.
 */
export function WaitingBlock({
  line,
  lastReadAt,
  readError = false,
  checking,
  onCheck,
  action,
}: {
  /** The balance at the address, or how short a partial deposit falls. */
  line: string
  lastReadAt?: number
  /** The last read failed. */
  readError?: boolean
  /** A read is out. */
  checking: boolean
  onCheck: () => void
  /** Sits beside the pill. */
  action?: ReactNode
}) {
  const [now, setNow] = useState(() => Date.now())
  // "Last checked 8s ago" ticks once a second.
  useEffect(() => {
    if (lastReadAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [lastReadAt])
  const sinceRead =
    lastReadAt === undefined ? undefined : Math.max(0, Math.floor((now - lastReadAt) / 1000))
  const pill = <CheckAgainPill checking={checking} onClick={onCheck} testId="deposit-check-again" />
  return (
    <div className="ww-deposit-sheet__live">
      <span className="ww-deposit-sheet__status-text">
        <b>
          <span className="ww-deposit-sheet__dot" />
          Waiting for deposit
        </b>
        <span data-testid="deposit-balance">
          {readError
            ? "Couldn't check this address. Check your connection and try again."
            : `${line}${sinceRead !== undefined ? ` · Last checked ${sinceRead}s ago` : ""}`}
        </span>
        {action ? (
          <span className="ww-send-to__note">
            {pill}
            {action}
          </span>
        ) : (
          pill
        )}
      </span>
    </div>
  )
}
