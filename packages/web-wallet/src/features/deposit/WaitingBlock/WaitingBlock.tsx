import type { ReactNode } from "react"
import { useStore } from "@obsidion/front-core"
import { fmt } from "../../../lib/fmt"
import { useSession } from "../../../session/session"
import { NO_CLOCK } from "../depositArrival"
import { CheckAgainPill } from "../../../ui/CheckAgainPill/CheckAgainPill"
import copy from "./WaitingBlock.copy"

/**
 * A watched address while its deposit is awaited: what it holds, when it was last read, and the
 * pill that reads it again. The caller owns the reads; this only shows them.
 */
export function WaitingBlock({
  title = copy.title,
  line,
  lastReadAt,
  readError = false,
  checking,
  onCheck,
  action,
  card = false,
}: {
  title?: string
  /** The balance at the address, or how short a partial deposit falls. */
  line: string
  lastReadAt?: number
  /** The last read failed. */
  readError?: boolean
  /** A read is out. */
  checking: boolean
  /** Reads again; without it there is no pill. */
  onCheck?: () => void
  /** Sits beside the pill. */
  action?: ReactNode
  /** A card with the dot beside the text, and "Last checked" on its own row beside the pill. */
  card?: boolean
}) {
  // "Last checked 8s ago" ticks once a second.
  const { seconds } = useSession().page
  const now = useStore(lastReadAt === undefined ? NO_CLOCK : seconds)
  const sinceRead =
    lastReadAt === undefined ? undefined : Math.max(0, Math.floor((now - lastReadAt) / 1000))
  const pill = onCheck && (
    <CheckAgainPill checking={checking} onClick={onCheck} testId="deposit-check-again" />
  )
  if (card)
    return (
      <div className="ww-deposit-sheet__status ww-deposit-sheet__status--waiting">
        <span className="ww-deposit-sheet__dot ww-deposit-sheet__dot--pulse" />
        <span className="ww-deposit-sheet__status-text">
          <span className="ww-deposit-sheet__status-lines">
            <b>{title}</b>
            {(readError || line) && (
              <span data-testid="deposit-balance">{readError ? copy.readError : line}</span>
            )}
          </span>
          {(sinceRead !== undefined || pill) && (
            <span className="ww-deposit-sheet__checked">
              {sinceRead !== undefined && fmt(copy.lastChecked, { seconds: sinceRead })}
              {pill}
            </span>
          )}
        </span>
      </div>
    )
  return (
    <div className="ww-deposit-sheet__live">
      <span className="ww-deposit-sheet__status-text">
        <b>
          <span className="ww-deposit-sheet__dot ww-deposit-sheet__dot--pulse" />
          {title}
        </b>
        <span data-testid="deposit-balance">
          {readError
            ? copy.readError
            : sinceRead !== undefined
            ? fmt(copy.lineChecked, {
                line,
                checked: fmt(copy.lastChecked, { seconds: sinceRead }),
              })
            : line}
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
