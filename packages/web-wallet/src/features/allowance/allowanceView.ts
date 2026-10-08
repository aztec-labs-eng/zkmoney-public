import {
  allowanceBlocksSponsoredAction,
  type AllowanceSnapshot,
  type SponsoredAllowanceState,
} from "@obsidion/front-core"

export const ALLOWANCE_SCOPE =
  "zk.money pays the network fee for sends, payment links, withdrawals and deposit addresses. It " +
  "counts transactions, not their value."

export type AllowanceViewState =
  | SponsoredAllowanceState["kind"]
  | "signed-out"
  | "loading"
  | "unavailable"

export interface AllowanceView {
  state: AllowanceViewState
  /** The concise line, such as "12 sponsored transactions left". */
  headline: string
  /** A short explanation for the details view; empty while checking. */
  detail: string
  tone: "normal" | "warning"
  /** The read failed; offer a retry. */
  retry: boolean
}

/** A refill period as a plain duration: "24 hours", "7 days". */
export function formatPeriod(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  if (seconds % 86_400 === 0 && seconds > 86_400) return unit(seconds / 86_400, "day")
  if (seconds % 3_600 === 0) return unit(seconds / 3_600, "hour")
  if (seconds % 60 === 0) return unit(seconds / 60, "minute")
  return unit(seconds, "second")
}

export function allowanceView(snapshot: AllowanceSnapshot): AllowanceView {
  switch (snapshot.status) {
    case "signed-out":
    case "loading":
      return view(snapshot.status, "Checking sponsored transactions…", "")
    case "unavailable":
      return {
        ...view("unavailable", "Couldn't check sponsored transactions", "Try again in a moment."),
        retry: true,
      }
  }
  const { state, read } = snapshot
  const renewal = `An allowance renews ${formatPeriod(
    read.allowance.refillPeriod,
  )} after it started, once used up.`
  switch (state.kind) {
    case "not-subscribed":
      return view(
        state.kind,
        "Not started",
        `Your first sponsored transaction starts an allowance of ${state.maxTx}. ` +
          (state.renews ? renewal : "It does not renew."),
      )
    case "available":
      return view(
        state.kind,
        `${state.available} sponsored transaction${state.available === 1 ? "" : "s"} left`,
        state.renews ? renewal : "This allowance does not renew.",
      )
    case "renewal-unknown":
      return view(
        state.kind,
        "Renewal status unknown",
        `None are stored. Your next sponsored transaction may start a new allowance of ${state.maxTx}. ` +
          renewal,
      )
    case "does-not-renew":
      return {
        ...view(state.kind, "No sponsored transactions left", "This allowance does not renew."),
        tone: "warning",
      }
  }
}

/**
 * Why a sponsored action cannot be sent, when the allowance proves it; undefined otherwise. Only a
 * stored zero on a rail that never renews proves it. A zero that may renew, a failed read, or a read
 * being replaced blocks nothing: the chain decides.
 */
export function sponsoredActionBlock(snapshot: AllowanceSnapshot): string | undefined {
  if (
    snapshot.status !== "ready" ||
    snapshot.refreshing ||
    !allowanceBlocksSponsoredAction(snapshot.state)
  )
    return undefined
  return "No sponsored transactions left. This allowance does not renew."
}

/** The Settings row's value: "42 left", or what stands in for a count. */
export function allowanceRowValue(snapshot: AllowanceSnapshot): string {
  if (snapshot.status === "unavailable") return "Unavailable"
  if (snapshot.status !== "ready") return "Checking…"
  const { state } = snapshot
  switch (state.kind) {
    case "not-subscribed":
      return "Not started"
    case "available":
      return `${state.available} left`
    case "renewal-unknown":
      return "Unknown"
    case "does-not-renew":
      return "0 left"
  }
}

function view(state: AllowanceViewState, headline: string, detail: string): AllowanceView {
  return { state, headline, detail, tone: "normal", retry: false }
}
