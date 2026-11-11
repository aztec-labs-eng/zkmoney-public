/** The external-wallet pay sheet's state: which sheet shows over the flow, and how the payment went. */
import type { RequestInlinePacket } from "@obsidion/front-core"
import type { AccountlessResolveResult } from "./accountlessRequest"
import type { PayStart } from "./payStart"

/** `fund` sends on Ethereum, `bridge` brings funds from another chain, `address` shows the payee's. */
export type PaySheet = "fund" | "bridge" | "address"

export interface PayState {
  sheet?: PaySheet
  /** A pay or bridge click made while disconnected, waiting on the wallet the picker connects. */
  waiting?: "fund" | "bridge"
  sent: boolean
  /** A payment from this browser that nothing here can show settled. */
  unresolved: boolean
  /** Where the sheets open on their first showing; a sheet that closes ends it. */
  opening?: PayStart
}

export type PayEvent =
  | { type: "open"; sheet: PaySheet }
  /** `ended`: the sheet closing also ends the start. */
  | { type: "closed"; ended?: boolean }
  | { type: "connecting"; sheet: "fund" | "bridge" }
  /** The wait's picker connected a wallet, or closed without one; `over` holds any payment. */
  | { type: "connected"; wallet: boolean; over: boolean }
  /** The flow's origin moved to Ethereum (`onL1`) or another chain. */
  | { type: "origin"; onL1: boolean }
  | { type: "sent" }
  /** A failed receipt read: it does not prove nothing was sent. The send stays open. */
  | { type: "sendFailed" }
  /** The send's outcome is unknown: it may have paid. Its sheet closes. */
  | { type: "sendUnresolved" }
  /** The payer chose to pay again. */
  | { type: "again" }
  /** A bridge that ended short: the flow starts over, the payment no longer held. */
  | { type: "retry" }
  | { type: "ended" }

export const payStart = (start: PayStart | undefined): PayState => ({
  sheet: start?.bridge ? "bridge" : undefined,
  sent: false,
  unresolved: false,
  opening: start,
})

/** Which origin each sheet belongs on: the address and the wallet send are Ethereum only. */
const keptOn = (sheet: PaySheet, onL1: boolean) => (sheet === "bridge" ? !onL1 : onL1)

export function payTransition(s: PayState, e: PayEvent): PayState {
  switch (e.type) {
    case "open":
      return { ...s, sheet: e.sheet, waiting: undefined }
    case "closed":
      return { ...s, sheet: undefined, opening: e.ended ? undefined : s.opening }
    case "connecting":
      return { ...s, waiting: e.sheet }
    case "connected":
      if (!s.waiting) return s
      return {
        ...s,
        waiting: undefined,
        sheet: e.wallet && !e.over ? s.waiting : s.sheet,
      }
    case "origin":
      return s.sheet && !keptOn(s.sheet, e.onL1) ? { ...s, sheet: undefined } : s
    case "sent":
      return { ...s, sent: true, sheet: s.sheet === "fund" ? undefined : s.sheet }
    case "sendFailed":
      return { ...s, sent: false, unresolved: true }
    case "sendUnresolved":
      return { ...s, unresolved: true, sheet: undefined }
    case "again":
      return { ...s, unresolved: false }
    case "retry":
      return { ...s, sheet: undefined, sent: false, unresolved: false, opening: undefined }
    case "ended":
      return { ...s, opening: undefined }
  }
}

/**
 * A fixed request's amounts in the token's units: the wallet send adds the deposit fee itself, a
 * bridge lands the gross. Undefined for an open request.
 */
export function payFixedAmounts(
  packet: Pick<RequestInlinePacket, "amountAtomic">,
  result: Pick<AccountlessResolveResult, "grossAtomic">,
): { send: bigint; bridge: bigint } | undefined {
  return packet.amountAtomic > 0n
    ? { send: packet.amountAtomic, bridge: result.grossAtomic }
    : undefined
}
