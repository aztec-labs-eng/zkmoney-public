/** The demo's connected L1 wallet: the page's `L1Wallet` over a memory Store that it writes. */
import { createWalletClient, custom, type EIP1193Provider, type Hex } from "viem"
import type { Config } from "wagmi"
import type { Pace } from "@obsidion/core/cadence"
import { WalletError } from "@obsidion/core/errors"
import { memoryStore } from "@obsidion/front-core"
import type { L1Wallet, L1WalletView } from "../session/l1Wallet"
import { walletChainFor } from "../session/walletChains"
import { DEMO_L1_ACCOUNT } from "./fakeL1Rpc"

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

/** How long the fake wallet takes to connect or switch chain. */
const ANSWER_MS = 600

export interface FakeL1WalletOptions {
  chainId: number
  account?: Hex
  walletName?: string
  connected?: boolean
  /** The demo's injected provider, once installed: `clients()` signs over it. */
  provider?: () => EIP1193Provider | undefined
}

export function fakeL1Wallet(
  { pace, wagmi }: { pace: Pace; wagmi: Config },
  {
    chainId,
    account = DEMO_L1_ACCOUNT,
    walletName = "MetaMask",
    connected = false,
    provider,
  }: FakeL1WalletOptions,
): L1Wallet {
  const disconnected: L1WalletView = {
    account: null,
    accounts: [],
    chainId: null,
    walletName: null,
    connecting: false,
    reopening: false,
  }
  const on = (chain: number): L1WalletView => ({
    account,
    accounts: [account],
    chainId: chain,
    walletName,
    connecting: false,
    reopening: false,
  })
  const state = memoryStore<L1WalletView>(connected ? on(chainId) : disconnected)
  const set = (change: Partial<L1WalletView>) => state.update((s) => ({ ...s, ...change }))
  const answered = () => pace.wait(ANSWER_MS)
  let attempts = 0

  return {
    view: state.readonly,
    async connectAnother(_open, _pickerOpen, signal) {
      const id = ++attempts
      state.set({ ...disconnected, reopening: true })
      await answered()
      if (signal?.aborted || id !== attempts || !state.get().reopening) return undefined
      state.set(on(chainId))
      return { account, chainId, walletName }
    },
    disconnect: () => state.set(disconnected),
    async switchNetwork(next) {
      set({ connecting: true })
      await answered()
      set({ connecting: false, chainId: next })
      return true
    },
    selectAccount: () => {},
    switchAccount: async () => true,
    async clients(next, from) {
      const injected = provider?.() as Eip1193 | undefined
      if (!injected) throw new WalletError("unknown", "No wallet connected")
      if (from && from.toLowerCase() !== account.toLowerCase()) {
        throw new WalletError("unknown", "That account is no longer connected")
      }
      set({ chainId: next })
      const wallet: Eip1193 = {
        request: (args) =>
          args.method === "eth_chainId"
            ? Promise.resolve(`0x${next.toString(16)}`)
            : args.method === "eth_accounts" || args.method === "eth_requestAccounts"
            ? Promise.resolve([account])
            : injected.request(args),
      }
      const chain = walletChainFor(next, wagmi.chains)
      return {
        walletClient: createWalletClient({ chain, transport: custom(wallet) }),
        account,
        chain,
      }
    },
  }
}
