/** The page's connected L1 wallet as a memory Store a test writes, in place of wagmi's. */
import type { Hex } from "viem"
import { WalletError } from "@obsidion/core/errors"
import { memoryStore } from "@obsidion/front-core"
import type { L1Wallet, L1WalletView } from "../../src/session/l1Wallet"
import type { Session } from "../../src/session/session"

export const DISCONNECTED: L1WalletView = {
  account: null,
  accounts: [],
  chainId: null,
  walletName: null,
  connecting: false,
  reopening: false,
}

/** A wallet whose view the test sets; its commands change the view as the wallet would. */
export function fakeL1Wallet(init: Partial<L1WalletView> = {}) {
  const view = memoryStore<L1WalletView>({ ...DISCONNECTED, ...init })
  const set = (change: Partial<L1WalletView>) => view.update((s) => ({ ...s, ...change }))
  const wallet: L1Wallet = {
    view: view.readonly,
    async connectAnother() {
      view.set({ ...DISCONNECTED, reopening: true })
      return undefined
    },
    disconnect: () => view.set(DISCONNECTED),
    async switchNetwork(chainId) {
      set({ chainId })
      return true
    },
    selectAccount: (account) => set({ account }),
    switchAccount: async () => true,
    clients: async () => {
      throw new WalletError("unknown", "The fake wallet signs nothing")
    },
  }
  return {
    wallet,
    view,
    set,
    /** `account` connects on `chainId`, the only account the wallet permits. */
    connect: (account: Hex, chainId = 1) =>
      view.set({ ...DISCONNECTED, account, accounts: [account], chainId, walletName: "Rabby" }),
    disconnect: () => view.set(DISCONNECTED),
  }
}

/** Puts `wallet` on `session`'s page. */
export function withL1Wallet(session: Session, wallet: L1Wallet): void {
  Object.defineProperty(session, "page", {
    configurable: true,
    value: { ...session.page, l1Wallet: wallet },
  })
}
