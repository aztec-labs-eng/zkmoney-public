import { useEffect, useState } from "react"
import { Icon, Spinner } from "@obsidion/web-ds"
import loopRightIcon from "../../assets/deposit/loop-right-line.svg"
import copy from "./CheckAgainPill.copy"

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
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    if (pressedAt === undefined) return
    // eslint-disable-next-line local/timer-in-view -- ZKM-1806
    const timer = setTimeout(() => setSpun(true), CHECK_SPIN_MS)
    return () => clearTimeout(timer)
  }, [pressedAt])
  const busy = checking || (pressedAt !== undefined && !spun)
  if (pressedAt !== undefined && !busy) {
    setChecked(true)
    setPressedAt(undefined)
  }
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    if (!checked) return
    // eslint-disable-next-line local/timer-in-view -- ZKM-1806
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
        setSpun(false)
        setPressedAt(Date.now())
        onClick()
      }}
      data-testid={testId}
    >
      {checked ? copy.checked : copy.checkAgain}
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
