/** What the deposit screen shows, from its flow's state. */
import {
  holdArrival,
  type SipaDeposit,
  type UnresolvedSend,
  type UnresolvedSendState,
} from "@obsidion/front-core"
import { permittedAccount } from "../../session/l1Wallet"
import type {
  AccountWait,
  DepositEntry,
  DepositScreenState,
  DepositSheet,
  WalletView,
} from "./DepositScreen/depositScreenTransition"

/** The sheet the deposit modal shows over its own steps. */
export type EntrySheet = DepositSheet | { kind: "switch"; wait: AccountWait }

/** The account step the wallet has not granted yet, over the sheet it was asked from. */
export function selectSwitch(
  s: DepositScreenState,
  wallet: Pick<WalletView, "account" | "accounts">,
): AccountWait | undefined {
  const wait = s.waits.account
  // Granted, the held step carries on; showing it for that render remounts the sheet under it.
  return wait && wallet.account && !permittedAccount(wallet.accounts, wait.saved.address)
    ? wait
    : undefined
}

/** The sheet on top of the deposit modal: a sent deposit, then the account switch, then the rest. */
export function selectEntrySheet(
  s: DepositScreenState,
  wallet: Pick<WalletView, "account" | "accounts">,
): EntrySheet | undefined {
  if (s.sheet?.kind === "sent") return s.sheet
  const wait = selectSwitch(s, wallet)
  return wait ? { kind: "switch", wait } : s.sheet
}

/**
 * Whether a send that may still land holds new funding: the saved hold, else the one reported on
 * this page. Funds reaching its address end it, and its deposit shows until the user closes it.
 */
export function selectDepositHold(
  s: Pick<DepositScreenState, "held" | "closedArrival">,
  saved: UnresolvedSendState,
  records: readonly SipaDeposit[],
): { hold: UnresolvedSendState; unresolved?: UnresolvedSend; arrived?: SipaDeposit } {
  const unresolved = saved.status === "held" ? saved.send : s.held
  const arrived = holdArrival(unresolved, records)
  const hold: UnresolvedSendState = arrived
    ? { status: "none" }
    : unresolved
    ? { status: "held", send: unresolved }
    : saved
  return {
    hold,
    unresolved,
    arrived: arrived && arrived.sipaAddress !== s.closedArrival ? arrived : undefined,
  }
}

/** The deposit modal: the one opened, else the router's start not acted on yet. */
export const selectEntry = (
  s: Pick<DepositScreenState, "entry" | "startHandled">,
  startKey: string | undefined,
): DepositEntry | undefined =>
  s.entry ?? (startKey !== undefined && startKey !== s.startHandled ? {} : undefined)
