/** The external-wallet pay sheet's flow: its sheets, and a pay click that waits on a wallet. */
import { memoryStore, type ReadonlyStore } from "@obsidion/front-core"
import type { L1Wallet } from "../../session/l1Wallet"
import type { ScreenFlow } from "../../ui/useScreenFlow"
import type { PayStart } from "./payStart"
import { payStart, payTransition, type PayEvent, type PayState } from "./payTransition"

export interface PayInputs {
  /** No payment fits the limits or capacity: nothing opens a send. */
  over: boolean
  /** A send can open: a wallet is connected, or the desktop launcher approves it elsewhere. */
  canFund: boolean
  connected: boolean
  /** The connect picker's opener and whether it is up, from the latest render. */
  openPicker: () => Promise<void>
  pickerShown: () => boolean
}

export interface PayFlow extends ScreenFlow {
  state: ReadonlyStore<PayState>
  dispatch(event: PayEvent): void
  /** Opens `sheet`'s send, connecting a wallet first when there is none. */
  pay(sheet: "fund" | "bridge"): Promise<void>
  /** Closes a sheet left on the wrong origin: "closed" when it did. */
  origin(onL1: boolean): "kept" | "closed"
}

export function openPayFlow(
  deps: { l1Wallet: Pick<L1Wallet, "connectAnother">; start?: PayStart },
  latest: () => PayInputs,
): PayFlow {
  const state = memoryStore<PayState>(payStart(deps.start))
  const dispatch = (event: PayEvent) => state.set(payTransition(state.get(), event))
  let ended: AbortSignal | undefined
  let attempts = 0
  return {
    start(signal) {
      ended = signal
    },
    state: state.readonly,
    dispatch,
    async pay(sheet) {
      const { over, canFund, connected, openPicker, pickerShown } = latest()
      if (over) return
      if (sheet === "fund" ? canFund : connected) return dispatch({ type: "open", sheet })
      const id = ++attempts
      dispatch({ type: "connecting", sheet })
      const wallet = await deps.l1Wallet.connectAnother(openPicker, pickerShown, ended)
      // A later click replaced this wait.
      if (ended?.aborted || id !== attempts) return
      dispatch({ type: "connected", wallet: !!wallet, over: latest().over })
    },
    origin(onL1) {
      const before = state.get().sheet
      dispatch({ type: "origin", onL1 })
      return state.get().sheet === before ? "kept" : "closed"
    },
  }
}
