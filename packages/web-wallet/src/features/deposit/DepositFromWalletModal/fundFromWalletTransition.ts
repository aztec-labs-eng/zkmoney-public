/** The send-from-wallet sheet's state: the form, the review, the chain switch and the transfer. */
import type { Hex } from "viem"
import type { ErrorCode } from "@obsidion/core/errors"
import type { DepositStage } from "../sipaAddresses"
import type { L1TokenBalance } from "../l1DepositTokenBalance"
import type { FundStart } from "../depositStart"

/** `switching` waits on the wallet's chain switch; `switched` waits for the wallet to report it. */
export type FundPhase = "form" | "ready" | "switching" | "switched" | "depositing"

/** Why the last send stopped before any transfer. */
export type FundNote =
  | { code: ErrorCode }
  /** The wallet never reported the chain it was asked to switch to. */
  | { switchFailed: true }
  /** A refusal its own error words: the desktop helper, the wallet prompt, a capacity recheck. */
  | { error: Error }

export interface FundState {
  phase: FundPhase
  stage?: DepositStage
  /** The fee the review was entered with, and whether it has moved since. */
  review: { fee?: string; changed: boolean }
  /** Shown until the amount changes. */
  note?: FundNote
  /** The balance a rejected transfer reported, and the read it is fresher than. */
  shortfall?: { balance: L1TokenBalance; over?: L1TokenBalance }
  /** The account a transfer started from, shown until it ends whatever the wallet switches to. */
  sendingFrom?: Hex | null
  /** The desktop helper's page, while the browser approves the transfer. */
  submitUrl?: string
}

export type FundEvent =
  | { type: "review"; fee?: string }
  | { type: "back" }
  | { type: "typed" }
  | { type: "switching" }
  | { type: "switched" }
  /** The switch ended: back to the review, `stuck` when the wallet never reported the chain. */
  | { type: "switchEnded"; stuck: boolean }
  | { type: "depositing"; from: Hex | null }
  | { type: "stage"; stage: DepositStage }
  | { type: "browser"; url: string }
  /** The sheet stops waiting on the wallet's prompt. */
  | { type: "cancelled" }
  /** Stopped before any transfer: the form or the review says why. */
  | {
      type: "failed"
      at: "form" | "ready"
      note?: FundNote
      shortfall?: FundState["shortfall"]
      feeChanged?: boolean
    }

export function fundStart(start: FundStart | undefined, fee: string | undefined): FundState {
  return {
    phase: start?.phase ?? "form",
    stage: start?.stage,
    note: start?.note,
    review: {
      fee: start && start.phase !== "form" ? fee : undefined,
      changed: start?.feeChanged ?? false,
    },
  }
}

export function fundTransition(s: FundState, e: FundEvent): FundState {
  switch (e.type) {
    case "review":
      return { ...s, phase: "ready", review: { fee: e.fee, changed: false } }
    case "back":
      return s.phase === "ready" ? { ...s, phase: "form", review: { changed: false } } : s
    case "typed":
      return s.note ? { ...s, note: undefined } : s
    case "switching":
      return { ...s, phase: "switching", note: undefined }
    case "switched":
      return s.phase === "switching" ? { ...s, phase: "switched" } : s
    case "switchEnded":
      return { ...s, phase: "ready", ...(e.stuck && { note: { switchFailed: true } }) }
    case "depositing":
      return {
        ...s,
        phase: "depositing",
        stage: undefined,
        sendingFrom: e.from,
        submitUrl: undefined,
      }
    case "stage":
      return s.phase === "depositing" ? { ...s, stage: e.stage } : s
    case "browser":
      return { ...s, submitUrl: e.url }
    case "cancelled":
      return s.phase === "depositing" ? { ...s, phase: "ready", stage: undefined } : s
    case "failed":
      return {
        ...s,
        phase: e.at,
        ...(e.note && { note: e.note }),
        ...(e.shortfall && { shortfall: e.shortfall }),
        ...(e.feeChanged && { review: { ...s.review, changed: true } }),
      }
  }
}
