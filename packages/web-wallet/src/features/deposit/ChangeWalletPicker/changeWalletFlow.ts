import { memoryStore, type ReadonlyStore } from "@obsidion/front-core"
import type { L1Wallet } from "../../../session/l1Wallet"
import type { useL1Wallet } from "../../../session/useL1Wallet"
import type { ScreenFlow } from "../../../ui/useScreenFlow"

export interface ChangeWalletState {
  /** The wallet's account dialog is up. */
  waiting: boolean
}

export type ChangeWalletEvent = { type: "asked" } | { type: "answered" }

export function changeWalletTransition(
  s: ChangeWalletState,
  e: ChangeWalletEvent,
): ChangeWalletState {
  switch (e.type) {
    case "asked":
      return s.waiting ? s : { waiting: true }
    case "answered":
      return s.waiting ? { waiting: false } : s
  }
}

export interface ChangeWalletInputs {
  l1: Pick<ReturnType<typeof useL1Wallet>, "switchAccount" | "openPicker" | "pickerShown">
  /** `changed` when the wallet was asked for another account or another wallet. */
  onPicked: (changed?: boolean) => void
}

export interface ChangeWalletFlow extends ScreenFlow {
  state: ReadonlyStore<ChangeWalletState>
  switchAccount(): Promise<void>
  /** Drops the connected wallet and opens the connect picker for another. */
  connectAnother(): void
}

/** Asks the wallet for another account. A picker closed while the dialog is up ignores its answer. */
export function openChangeWalletFlow(
  { l1Wallet }: { l1Wallet: Pick<L1Wallet, "connectAnother"> },
  latest: () => ChangeWalletInputs,
): ChangeWalletFlow {
  const state = memoryStore<ChangeWalletState>({ waiting: false })
  const dispatch = (event: ChangeWalletEvent) =>
    state.set(changeWalletTransition(state.get(), event))
  let shown: AbortSignal | undefined
  return {
    state: state.readonly,
    start(signal) {
      shown = signal
    },
    async switchAccount() {
      dispatch({ type: "asked" })
      const switched = await latest().l1.switchAccount()
      if (shown?.aborted) return
      dispatch({ type: "answered" })
      if (switched !== false) latest().onPicked(true)
    },
    connectAnother() {
      const { l1, onPicked } = latest()
      // The wait outlives this picker, which closes at once: the screen under it follows the wallet.
      void l1Wallet.connectAnother(l1.openPicker, l1.pickerShown)
      onPicked(true)
    },
  }
}
