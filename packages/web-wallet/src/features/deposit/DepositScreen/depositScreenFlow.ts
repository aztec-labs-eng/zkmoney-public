/** The deposit screen's flow: its sheets, the wallet steps it holds, and the router's start. */
import { memoryStore, type ReadonlyStore, type UnresolvedSend } from "@obsidion/front-core"
import type { L1Wallet } from "../../../session/l1Wallet"
import type { SavedL1Wallet } from "../../../session/savedL1Wallets"
import type { ScreenFlow } from "../../../ui/useScreenFlow"
import type { WalletKind } from "../DepositFlow/DepositFlow"
import {
  depositScreenTransition,
  walletWaitOutcome,
  type AccountWait,
  type CarriedAmount,
  type ConnectWait,
  type DepositEntry,
  type DepositScreenEvent,
  type DepositScreenState,
  type DepositSheet,
} from "./depositScreenTransition"

/** How long the sheet says "Address copied!" before it waits for the funds. */
export const COPIED_MS = 2_000

export interface DepositScreenInputs {
  /** The location that carried `startDeposit` in its router state: it opens the deposit modal. */
  startKey?: string
  /** Clears the router state that opened the deposit modal. */
  clearStart: () => void
  /** The desktop launcher sends with no connected wallet. */
  bridgeMode: boolean
  /** The latest render's connect picker, or the connect it started. */
  pickerShown: () => boolean
  /** Carries a held step on with the wallet as it is now. */
  resume: (kind: WalletKind | "pick", saved?: SavedL1Wallet) => void
}

export interface DepositScreenFlow extends ScreenFlow {
  state: ReadonlyStore<DepositScreenState>
  entry(entry?: DepositEntry): void
  pick(step: DepositScreenState["picking"]): void
  open(sheet: DepositSheet): void
  shut(kind: DepositSheet["kind"]): void
  /** Closes the deposit modal and every sheet over it. */
  close(): void
  /** The address was copied: after the copied note, the sheet waits for the funds. */
  copied(): void
  /** Back to the address: a copy's pending hand-off goes with it. */
  showAddress(): void
  coin(symbol: string): void
  /** The held address was spent or may be: the next sheet derives a fresh one. */
  dropAddress(): void
  read(balance: bigint, at: number): void
  readFailed(): void
  /** True when this is the first funding seen. */
  funded(amount: bigint): boolean
  carry(amount: CarriedAmount): void
  /** Holds `wait` until the wallet the picker asks for connects. */
  awaitConnect(wait: ConnectWait): void
  /** Holds `wait` until the wallet grants its saved account. */
  awaitAccount(wait: AccountWait): void
  dropAccount(): void
  held(send?: UnresolvedSend): void
  holdError(on: boolean): void
  arrivalClosed(address: string): void
}

/**
 * The screen's state over the page's L1 wallet: while the screen shows, each change of the wallet
 * settles the steps held for it.
 */
export function openDepositScreenFlow(
  { l1Wallet, initial }: { l1Wallet: Pick<L1Wallet, "view">; initial: DepositScreenState },
  latest: () => DepositScreenInputs,
): DepositScreenFlow {
  const state = memoryStore<DepositScreenState>(initial)
  const dispatch = (event: DepositScreenEvent) =>
    state.set(depositScreenTransition(state.get(), event))
  let screen: AbortSignal | undefined
  let handOff: ReturnType<typeof setTimeout> | undefined
  const dropHandOff = () => clearTimeout(handOff)

  const settle = () => {
    const view = l1Wallet.view.get()
    const { bridgeMode, pickerShown, resume } = latest()
    const { waits } = state.get()
    const outcome = walletWaitOutcome(waits, {
      canFund: bridgeMode || !!view.account,
      account: view.account,
      accounts: view.accounts,
      pickerOpen: view.reopening || pickerShown(),
    })
    dispatch({
      type: "settled",
      connect: outcome.connect !== "wait",
      account: outcome.account !== "wait",
    })
    if (outcome.connect === "land") resume(waits.connect!.kind, waits.connect!.saved)
    if (outcome.account === "land") resume(waits.account!.kind, waits.account!.saved)
  }

  return {
    state: state.readonly,
    start(signal) {
      screen = signal
      settle()
      const off = l1Wallet.view.subscribe(settle)
      signal.addEventListener("abort", () => {
        off()
        dropHandOff()
      })
    },
    entry: (entry) => dispatch({ type: "entry", entry, startKey: latest().startKey }),
    pick: (step) => dispatch({ type: "picking", step }),
    open: (sheet) => dispatch({ type: "open", sheet }),
    shut: (kind) => {
      if (kind === "address") dropHandOff()
      dispatch({ type: "shut", kind })
    },
    close() {
      dropHandOff()
      const { startKey, clearStart } = latest()
      dispatch({ type: "close", startKey })
      if (startKey !== undefined) clearStart()
    },
    copied() {
      if (state.get().awaiting) return
      dropHandOff()
      handOff = setTimeout(() => {
        if (!screen?.aborted) dispatch({ type: "awaiting", on: true })
      }, COPIED_MS)
    },
    showAddress() {
      dropHandOff()
      dispatch({ type: "awaiting", on: false })
    },
    coin(symbol) {
      const { sheetCoin, funded } = state.get()
      if (funded === undefined && sheetCoin !== undefined && sheetCoin !== symbol) dropHandOff()
      dispatch({ type: "coin", symbol })
    },
    dropAddress() {
      dropHandOff()
      dispatch({ type: "dropped" })
    },
    read: (balance, at) => dispatch({ type: "read", balance, at }),
    readFailed: () => dispatch({ type: "readFailed" }),
    funded(amount) {
      const first = state.get().funded === undefined
      dispatch({ type: "funded", amount })
      return first
    },
    carry: (amount) => dispatch({ type: "carry", amount }),
    awaitConnect: (wait) => dispatch({ type: "awaitConnect", wait }),
    awaitAccount: (wait) => dispatch({ type: "awaitAccount", wait }),
    dropAccount: () => dispatch({ type: "dropAccount" }),
    held: (send) => dispatch({ type: "held", send }),
    holdError: (on) => dispatch({ type: "holdError", on }),
    arrivalClosed: (address) => dispatch({ type: "arrivalClosed", address }),
  }
}
