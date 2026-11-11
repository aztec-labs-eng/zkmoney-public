/** The deposit screen's state: which sheet shows, the wallet steps held, and the address's reads. */
import type { Hex } from "viem"
import type { UnresolvedSend } from "@obsidion/front-core"
import { permittedAccount } from "../../../session/l1Wallet"
import type { SavedL1Wallet } from "../../../session/savedL1Wallets"
import type { DepositIntent, WalletKind } from "../DepositFlow/DepositFlow"
import type { SentDeposit } from "../DepositFromWalletModal/DepositFromWalletModal"
import type { DepositStart } from "../depositStart"

/** An amount typed on one sheet, for the next one to start from. */
export interface CarriedAmount {
  amount: string
  side: "from" | "to"
}

/** A step asked while disconnected; "pick" opens the deposit modal on the wallet that connects. */
export interface ConnectWait {
  kind: WalletKind | "pick"
  saved?: SavedL1Wallet
}

/** A step for a saved account the wallet has not granted yet. */
export interface AccountWait {
  kind: WalletKind
  saved: SavedL1Wallet
}

export interface DepositWaits {
  connect?: ConnectWait
  account?: AccountWait
}

/** The deposit modal, what it was opened for, and the saved wallet it was opened from. */
export interface DepositEntry {
  intent?: DepositIntent
  saved?: SavedL1Wallet
}

/** The sheet over the screen. */
export type DepositSheet =
  | { kind: "address" }
  | { kind: "fund" }
  | { kind: "bridge" }
  /** A sent deposit's status, tracked from the wallet's broadcast. */
  | { kind: "sent"; deposit: SentDeposit }

export interface DepositScreenState {
  /** Where the screen opened: its first showing only, so closing the modal drops it. */
  start?: DepositStart
  entry?: DepositEntry
  /** The router start the user has acted on: a later one opens the deposit modal again. */
  startHandled?: string
  /** Over Home, the steps before the address sheet. */
  picking: "closed" | "privacy" | "coin"
  sheet?: DepositSheet
  /** Copying handed the address over: the address sheet waits for the funds. */
  awaiting: boolean
  /** The coin the address sheet last showed. */
  sheetCoin?: string
  waits: DepositWaits
  /** The amount that follows the user between the Ethereum and bridge-in sheets. */
  carried?: CarriedAmount
  /** The balance seen at the shown address; set once, no new address appears after it. */
  funded?: bigint
  balance: bigint
  lastReadAt?: number
  readError: boolean
  /** A send reported unresolved: it holds this page even when its saved hold is gone. */
  held?: UnresolvedSend
  /** Clearing the hold failed. */
  holdError: boolean
  /** The arrival whose detail the user closed. */
  closedArrival?: string
}

export type DepositScreenEvent =
  /** Opens or closes the deposit modal; the router's start showing now counts as handled. */
  | { type: "entry"; entry?: DepositEntry; startKey?: string }
  | { type: "picking"; step: DepositScreenState["picking"] }
  | { type: "open"; sheet: DepositSheet }
  /** Closes `kind` when it is the sheet showing. */
  | { type: "shut"; kind: DepositSheet["kind"] }
  /** Closes the deposit modal and every sheet over it. */
  | { type: "close"; startKey?: string }
  | { type: "awaiting"; on: boolean }
  /** The address sheet opens for `symbol`; another coin than the last starts at its address. */
  | { type: "coin"; symbol: string }
  /** The held address was spent or may be: the address sheet closes and its reads reset. */
  | { type: "dropped" }
  | { type: "read"; balance: bigint; at: number }
  | { type: "readFailed" }
  | { type: "funded"; amount: bigint }
  | { type: "carry"; amount: CarriedAmount }
  | { type: "awaitConnect"; wait: ConnectWait }
  | { type: "awaitAccount"; wait: AccountWait }
  | { type: "dropAccount" }
  /** The wallet steps that landed or dropped leave. */
  | { type: "settled"; connect: boolean; account: boolean }
  | { type: "held"; send?: UnresolvedSend }
  | { type: "holdError"; on: boolean }
  | { type: "arrivalClosed"; address: string }

/** The screen's state on its first showing. */
export function depositScreenStart(
  start: DepositStart | undefined,
  { picking, symbol, now }: { picking: DepositScreenState["picking"]; symbol: string; now: number },
): DepositScreenState {
  const sheet: DepositSheet | undefined = start?.sent
    ? { kind: "sent", deposit: start.sent }
    : start?.fund
    ? { kind: "fund" }
    : start?.address
    ? { kind: "address" }
    : start?.bridge
    ? { kind: "bridge" }
    : undefined
  const saved = start?.switching ? start.entry?.saved : undefined
  return {
    start,
    entry: start?.entry,
    picking,
    sheet,
    awaiting: start?.address === "waiting" || start?.address === "read-error",
    sheetCoin: start?.address ? symbol : undefined,
    waits: { account: saved && { kind: "bridge", saved } },
    carried: start?.amount,
    funded: start?.funded,
    balance: 0n,
    lastReadAt: start?.address === "waiting" ? now - 8_000 : undefined,
    readError: start?.address === "read-error",
    holdError: false,
  }
}

const unread = { balance: 0n, lastReadAt: undefined }

export function depositScreenTransition(
  s: DepositScreenState,
  e: DepositScreenEvent,
): DepositScreenState {
  switch (e.type) {
    case "entry":
      return { ...s, entry: e.entry, startHandled: e.startKey ?? s.startHandled }
    case "picking":
      return { ...s, picking: e.step }
    case "open":
      return { ...s, sheet: e.sheet }
    case "shut":
      return s.sheet?.kind === e.kind ? { ...s, sheet: undefined } : s
    case "close":
      return {
        ...s,
        startHandled: e.startKey ?? s.startHandled,
        start: undefined,
        sheet: undefined,
        entry: undefined,
        carried: undefined,
        waits: { ...s.waits, account: undefined },
      }
    case "awaiting":
      return s.awaiting === e.on ? s : { ...s, awaiting: e.on }
    case "coin": {
      const opened = { ...s, sheet: { kind: "address" } as const }
      // Spotted funds belong to the coin they were read in.
      if (s.funded !== undefined) return opened
      // The coin the sheet last showed reopens where it was, waiting included.
      const other = s.sheetCoin !== undefined && s.sheetCoin !== e.symbol
      return { ...opened, sheetCoin: e.symbol, ...(other && { awaiting: false, ...unread }) }
    }
    case "dropped":
      return {
        ...s,
        sheet: s.sheet?.kind === "address" ? undefined : s.sheet,
        awaiting: false,
        ...unread,
      }
    case "read":
      return { ...s, readError: false, balance: e.balance, lastReadAt: e.at }
    case "readFailed":
      return { ...s, readError: true }
    case "funded":
      // Terminal: overlapping slow reads can both settle funded in the same tick.
      return s.funded === undefined ? { ...s, funded: e.amount } : s
    case "carry": {
      const held = s.carried
      return held?.amount === e.amount.amount && held.side === e.amount.side
        ? s
        : { ...s, carried: e.amount }
    }
    case "awaitConnect":
      return { ...s, waits: { ...s.waits, connect: e.wait } }
    case "awaitAccount":
      return { ...s, waits: { ...s.waits, account: e.wait } }
    case "dropAccount":
      return s.waits.account ? { ...s, waits: { ...s.waits, account: undefined } } : s
    case "settled":
      if (!e.connect && !e.account) return s
      return {
        ...s,
        waits: {
          connect: e.connect ? undefined : s.waits.connect,
          account: e.account ? undefined : s.waits.account,
        },
      }
    case "held":
      return { ...s, held: e.send }
    case "holdError":
      return s.holdError === e.on ? s : { ...s, holdError: e.on }
    case "arrivalClosed":
      return { ...s, closedArrival: e.address }
  }
}

/** What the wallet steps wait on. */
export interface WalletView {
  /** A fund step can go on: connected, or sending through the desktop launcher. */
  canFund: boolean
  account: string | null
  accounts: readonly Hex[]
  /** The connect picker is up, or a connect it started is out. */
  pickerOpen: boolean
}

/**
 * What a held step does: `land` once the wallet has what it waits for, `drop` once it cannot, else
 * `wait`. A wallet that connects with the picker closed takes a connect step with it, so a wallet
 * connecting on its own finds nothing waiting.
 */
export function walletWaitOutcome(
  waits: DepositWaits,
  wallet: WalletView,
): { connect: "land" | "drop" | "wait"; account: "land" | "drop" | "wait" } {
  const { connect, account } = waits
  const connected = connect && (connect.kind === "fund" ? wallet.canFund : !!wallet.account)
  return {
    connect: !connected ? "wait" : wallet.pickerOpen ? "land" : "drop",
    account: !account
      ? "wait"
      : permittedAccount(wallet.accounts, account.saved.address)
      ? "land"
      : !wallet.account && !wallet.pickerOpen
      ? "drop"
      : "wait",
  }
}
