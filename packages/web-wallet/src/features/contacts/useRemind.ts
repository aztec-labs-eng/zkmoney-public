import { remindedRecently } from "@obsidion/front-core"
import { useCallback, useRef, useState } from "react"
import { remindRequestById } from "./requestActions"

export type RemindState = "idle" | "sending" | "sent" | "failed"

export const REMIND_TITLE: Record<RemindState, string> = {
  idle: "Remind",
  sending: "Remind",
  sent: "Reminder sent",
  failed: "Try again",
}

/** Remind on outgoing requests: one send at a time per request, then none for 12 hours. */
export function useRemind(tokenAddress?: string) {
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  // Covers the moment before the stored row's `remindedAt` reaches the caller.
  const [sentAt, setSentAt] = useState<ReadonlyMap<string, number>>(new Map())
  const inFlight = useRef(new Set<string>())

  const remind = useCallback(
    (id: string) => {
      if (inFlight.current.has(id)) return
      inFlight.current.add(id)
      setSending((s) => new Set(s).add(id))
      setFailed((s) => without(s, id))
      void remindRequestById(id, tokenAddress)
        .catch((err) => {
          console.warn("[remind] failed:", err)
          return false
        })
        .then((ok) => {
          inFlight.current.delete(id)
          setSending((s) => without(s, id))
          if (ok) setSentAt((m) => new Map(m).set(id, Date.now()))
          else setFailed((s) => new Set(s).add(id))
        })
    },
    [tokenAddress],
  )

  const stateOf = useCallback(
    (id: string, remindedAt?: number): RemindState => {
      if (sending.has(id)) return "sending"
      const last = Math.max(remindedAt ?? 0, sentAt.get(id) ?? 0) || undefined
      if (remindedRecently(last, Date.now())) return "sent"
      return failed.has(id) ? "failed" : "idle"
    },
    [sending, sentAt, failed],
  )

  return { remind, stateOf }
}

function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set
  const next = new Set(set)
  next.delete(id)
  return next
}
