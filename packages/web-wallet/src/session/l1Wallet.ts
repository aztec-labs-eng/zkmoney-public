/**
 * The page's connected L1 wallet over wagmi: a live Store of its accounts and chain, the commands
 * that change it, and a viem walletClient for the transfers it signs.
 */
import {
  BaseError,
  ChainMismatchError,
  ProviderDisconnectedError,
  UserRejectedRequestError,
  createWalletClient,
  custom,
  type Chain,
  type Hex,
  type WalletClient,
} from "viem"
import type { Config } from "wagmi"
import { L1_PLACEHOLDER_NAME, batch, derived, liveStore, memoryStore } from "@obsidion/front-core"
import type { Contact, ReadonlyStore } from "@obsidion/front-core"
import {
  disconnect as wagmiDisconnect,
  getAccount,
  switchChain as wagmiSwitchChain,
  watchAccount,
} from "wagmi/actions"
import { WalletError, bestEffort } from "@obsidion/core/errors"
import { showReportableError } from "../errors/errorModal"
import { walletChainFor } from "./walletChains"

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

// Some wallets behind WalletConnect reject with a generic code and only say so in the message.
const REJECTION_MESSAGE =
  /^(the )?user (has )?(rejected|denied|cancell?ed)\b|\b(rejected|denied|cancell?ed) by (the )?user\b/i

/** True when the user dismissed the wallet's prompt, however deeply viem wrapped it. */
export function isWalletRejection(err: unknown): boolean {
  if (err instanceof BaseError) {
    return (
      err.walk(
        (e) =>
          e instanceof UserRejectedRequestError ||
          (e instanceof BaseError && REJECTION_MESSAGE.test(e.details)),
      ) !== null
    )
  }
  const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown }
  return (
    code === UserRejectedRequestError.code ||
    (typeof message === "string" && REJECTION_MESSAGE.test(message))
  )
}

const WALLETCONNECT_USER_DISCONNECTED = 6000
const DISCONNECT_MESSAGE = /^user disconnected\.?$/i

export function isWalletDisconnect(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const { code, details, message, cause } = err as Record<string, unknown>
  const text = details ?? message
  return (
    code === ProviderDisconnectedError.code ||
    code === WALLETCONNECT_USER_DISCONNECTED ||
    (typeof text === "string" && DISCONNECT_MESSAGE.test(text)) ||
    isWalletDisconnect(cause)
  )
}

export function isWrongNetwork(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof ChainMismatchError) !== null
}

/**
 * viem retries a failed eth_sendTransaction as wallet_sendTransaction. WalletConnect forwards that to
 * its public RPC, whose error then replaces the wallet's own, a rejection included. Refusing it here
 * makes viem rethrow the original.
 */
function withoutWalletNamespace(provider: Eip1193): Eip1193 {
  return {
    request: (args) =>
      args.method === "wallet_sendTransaction"
        ? Promise.reject({ code: -32601, message: "Method not found" })
        : provider.request(args),
  }
}

/**
 * The connected wallet, but only if it can actually be called: wagmi will hand back a
 * method-less stub rehydrated from storage, which reads as connected and answers nothing.
 */
function liveConnector(wagmi: Config) {
  const { connector } = getAccount(wagmi)
  return typeof connector?.getProvider === "function" ? connector : undefined
}

/** The wagmi-connected wallet's provider, else the injected one (demo mode installs a fake). */
async function connectorProvider(wagmi: Config): Promise<Eip1193> {
  const connector = liveConnector(wagmi)
  if (connector) return (await connector.getProvider()) as Eip1193
  if (window.ethereum) return window.ethereum as Eip1193
  throw new WalletError("unknown", "No wallet connected")
}

async function ensureChain(wagmi: Config, provider: Eip1193, chainId: number): Promise<void> {
  const { chainId: current } = getAccount(wagmi)
  if (liveConnector(wagmi)) {
    if (current !== chainId) await wagmiSwitchChain(wagmi, { chainId })
    return
  }
  const hex = `0x${chainId.toString(16)}`
  if ((await provider.request({ method: "eth_chainId" })) !== hex) {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] })
  }
}

/** Re-open the wallet's account permission picker (EIP-2255) and return the permitted set. */
async function requestAccountPermissions(wagmi: Config): Promise<Hex[]> {
  const provider = await connectorProvider(wagmi)
  await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] })
  const accounts = (await provider.request({ method: "eth_accounts" })) as Hex[]
  if (!accounts[0]) throw new WalletError("unknown", "No account selected")
  return accounts
}

export interface L1Clients {
  walletClient: WalletClient
  account: Hex
  chain: Chain
}

/**
 * A signing client over the connected wallet, switching to `chainId` first. Reads belong on the
 * app's own RPC (`l1PublicClient`): connected over a scanned QR the wallet is a phone behind a
 * WalletConnect relay, and plenty of mobile wallets answer no reads at all.
 * `from` pins the sending account to the app's selection — a `from` the wallet no longer permits
 * is refused rather than substituted: on the recovery and sweep exits that address is who gets paid.
 */
export async function getL1Clients(wagmi: Config, chainId: number, from?: Hex): Promise<L1Clients> {
  const provider = await connectorProvider(wagmi)
  await ensureChain(wagmi, provider, chainId)
  const chain = walletChainFor(chainId, wagmi.chains)
  const walletClient = createWalletClient({
    chain,
    transport: custom(withoutWalletNamespace(provider)),
  })
  // A wagmi connector already holds permission; the bare injected fallback must still prompt.
  const addresses = liveConnector(wagmi)
    ? await walletClient.getAddresses()
    : await walletClient.requestAddresses()
  const account = from
    ? addresses.find((a) => a.toLowerCase() === from.toLowerCase())
    : addresses[0]
  if (!account) {
    throw new WalletError(
      "unknown",
      from
        ? "That account is no longer connected. Reconnect it in your wallet and try again."
        : "No account connected",
    )
  }
  return { walletClient, account, chain }
}

/** What the page knows of the connected L1 wallet. */
export interface L1WalletView {
  /** The account deposits send from: the app's pick, not the wallet's. */
  account: Hex | null
  /** Every account the wallet has permitted for this origin. */
  accounts: Hex[]
  chainId: number | null
  /** Connector name for display ("Deposit from Rainbow"). */
  walletName: string | null
  connecting: boolean
  /** A `connectAnother` dropped the wallet and is opening the connect picker. */
  reopening: boolean
}

/** The wallet a `connectAnother` connected. */
export interface ConnectedWallet {
  account: Hex
  chainId: number | null
  walletName: string | null
}

/** The page's connected L1 wallet: a live Store and the commands that change it. */
export interface L1Wallet {
  view: ReadonlyStore<L1WalletView>
  /**
   * Drops the connected wallet and awaits `open`, the connect picker's opener. Resolves with the
   * next wallet that connects while `pickerOpen()` (the latest render's picker, or the connect it
   * started); undefined when one connects with the picker closed, a later `connectAnother`
   * replaced this one, or `signal` aborted.
   */
  connectAnother(
    open: () => void | Promise<void>,
    pickerOpen: () => boolean,
    signal?: AbortSignal,
  ): Promise<ConnectedWallet | undefined>
  /** Drops the wagmi session. The wallet itself stays permitted until the user revokes it. */
  disconnect(): void
  /** Switches the wallet to `chainId` (the connector adds it when missing); true once switched. */
  switchNetwork(chainId: number): Promise<boolean>
  /** Sends from `account`, held until the wallet switches its active account. */
  selectAccount(account: Hex): void
  /**
   * Re-opens the wallet's permission picker to grant more accounts, then sends from `prefer` when
   * granted, else from the first permitted account. False when the wallet refused.
   */
  switchAccount(prefer?: Hex): Promise<boolean>
  /** A signing client over the connected wallet: see {@link getL1Clients}. */
  clients(chainId: number, from?: Hex): Promise<L1Clients>
}

/** True when the wallet is connected on another chain than `expectedChainId`. */
export const wrongChain = (view: L1WalletView, expectedChainId: number | undefined): boolean =>
  expectedChainId != null && view.chainId != null && view.chainId !== expectedChainId

/** The app's pick, and the wallet's first account when it was made. */
interface Pin {
  account: Hex
  /** Unset for a grant wagmi has not listed yet. */
  first?: string
}

/**
 * A wallet switch drops the pick. A grant learns the wallet's first account once wagmi lists it,
 * maybe after other changes.
 */
function pinTransition(pin: Pin | null, accounts: readonly Hex[]): Pin | null {
  if (!pin) return null
  const first = accounts[0]?.toLowerCase()
  if (pin.first === undefined) {
    return permittedAccount(accounts, pin.account) ? { ...pin, first } : pin
  }
  return pin.first === first ? pin : null
}

function pickedAccount(pin: Pin | null, accounts: readonly Hex[]): Hex | null {
  const kept = pinTransition(pin, accounts)
  const listed = kept ? permittedAccount(accounts, kept.account) : undefined
  // A grant shows before wagmi lists it.
  const granting = kept && !kept.first && accounts.length > 0 ? kept.account : undefined
  return listed ?? granting ?? accounts[0] ?? null
}

interface WagmiWallet {
  accounts: Hex[]
  chainId: number | null
  walletName: string | null
  connecting: boolean
}

function wagmiWallet(wagmi: Config): WagmiWallet {
  const { addresses, chainId, connector, status } = getAccount(wagmi)
  return {
    accounts: [...(addresses ?? [])],
    chainId: chainId ?? null,
    walletName: connector?.name ?? null,
    connecting: status === "connecting" || status === "reconnecting",
  }
}

const sameWallet = (a: WagmiWallet, b: WagmiWallet) =>
  a.chainId === b.chainId &&
  a.walletName === b.walletName &&
  a.connecting === b.connecting &&
  a.accounts.length === b.accounts.length &&
  a.accounts.every((x, i) => x === b.accounts[i])

const sameView = (a: L1WalletView, b: L1WalletView) =>
  a.account === b.account &&
  a.chainId === b.chainId &&
  a.walletName === b.walletName &&
  a.connecting === b.connecting &&
  a.reopening === b.reopening &&
  a.accounts.length === b.accounts.length &&
  a.accounts.every((x, i) => x === b.accounts[i])

interface Own {
  pin: Pin | null
  /** The outstanding `connectAnother`. */
  wait?: number
  /** It has not opened the picker yet. */
  opening: boolean
  /** A network or account switch is out. */
  switching: number
}

/**
 * The page's connected L1 wallet over its wagmi config. `view` follows wagmi's account while
 * something subscribes.
 */
export function openL1Wallet({ wagmi }: { wagmi: Config }): L1Wallet {
  const own = memoryStore<Own>({ pin: null, opening: false, switching: 0 })
  const pinFollows = (accounts: readonly Hex[]) =>
    own.update((s) => {
      const pin = pinTransition(s.pin, accounts)
      return pin === s.pin ? s : { ...s, pin }
    })
  const wallet = liveStore<WagmiWallet>(wagmiWallet(wagmi), {
    whileSubscribed(set) {
      let last: WagmiWallet | undefined
      const follow = () => {
        const next = wagmiWallet(wagmi)
        if (last && sameWallet(last, next)) return
        last = next
        batch(() => {
          pinFollows(next.accounts)
          set(next)
        })
      }
      follow()
      return watchAccount(wagmi, { onChange: follow })
    },
  })
  const state = derived([wallet, own.readonly], (w, s) => ({ ...w, ...s }))
  const view = derived(
    [state],
    (s): L1WalletView => ({
      account: pickedAccount(s.pin, s.accounts),
      accounts: s.accounts,
      chainId: s.chainId,
      walletName: s.walletName,
      connecting: s.connecting || s.switching > 0,
      reopening: s.opening,
    }),
    sameView,
  )
  let attempts = 0

  const switching = async <T>(work: () => Promise<T>): Promise<T> => {
    own.update((s) => ({ ...s, switching: s.switching + 1 }))
    try {
      return await work()
    } finally {
      own.update((s) => ({ ...s, switching: s.switching - 1 }))
    }
  }
  const endWait = (id: number) =>
    own.update((s) => (s.wait === id ? { ...s, wait: undefined, opening: false } : s))

  const disconnect = () => {
    own.update((s) => ({ ...s, pin: null }))
    // Tear the wallet's session down best-effort, then drop ours regardless. wagmi clears its
    // state only after the wallet answers, and a phone that dropped the session answers a
    // disconnect no sooner than it answers anything else: the button has to work anyway.
    const connector = liveConnector(wagmi)
    if (connector) void bestEffort("unknown", wagmiDisconnect(wagmi, { connector }))
    wagmi.setState({
      ...wagmi.state,
      connections: new Map(),
      current: null,
      status: "disconnected",
    })
  }

  return {
    view,
    async connectAnother(open, pickerOpen, signal) {
      const id = ++attempts
      disconnect()
      own.update((s) => ({ ...s, wait: id, opening: true }))
      try {
        await open()
      } finally {
        own.update((s) => (s.wait === id ? { ...s, opening: false } : s))
      }
      const connected = await until(
        state,
        (s): ConnectedWallet | null | undefined => {
          if (s.wait !== id) return null
          const account = s.accounts[0]
          if (!account) return undefined
          // A picker dismissed earlier left nothing to continue.
          return pickerOpen() ? { account, chainId: s.chainId, walletName: s.walletName } : null
        },
        signal,
      )
      endWait(id)
      return connected ?? undefined
    },
    disconnect,
    switchNetwork: (chainId) =>
      switching(async () => {
        try {
          await wagmiSwitchChain(wagmi, { chainId })
          return true
        } catch (e) {
          if (!isWalletRejection(e)) showReportableError(e, "l1-wallet:network-switch")
          return false
        }
      }),
    selectAccount(account) {
      const first = getAccount(wagmi).addresses?.[0]?.toLowerCase()
      own.update((s) => ({ ...s, pin: { account, first } }))
    },
    switchAccount: (prefer) =>
      switching(async () => {
        try {
          const permitted = await requestAccountPermissions(wagmi)
          // Without `prefer`, the active account, which the wallet lists first.
          const account = (prefer && permittedAccount(permitted, prefer)) || permitted[0]
          own.update((s) => ({ ...s, pin: { account } }))
          return true
        } catch (e) {
          if (!isWalletRejection(e)) showReportableError(e, "l1-wallet:account-switch")
          return false
        }
      }),
    clients: (chainId, from) => getL1Clients(wagmi, chainId, from),
  }
}

/** The first defined `pick` of `store`'s values; undefined once `signal` aborts. */
function until<T, R>(
  store: ReadonlyStore<T>,
  pick: (value: T) => R | undefined,
  signal?: AbortSignal,
): Promise<R | undefined> {
  return new Promise((resolve) => {
    let off = () => {}
    const end = (value: R | undefined) => {
      off()
      signal?.removeEventListener("abort", aborted)
      resolve(value)
    }
    const aborted = () => end(undefined)
    const check = () => {
      const picked = pick(store.get())
      if (picked !== undefined) end(picked)
    }
    if (signal?.aborted) return resolve(undefined)
    signal?.addEventListener("abort", aborted)
    off = store.subscribe(check)
    check()
  })
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The wallet's spelling of `address`, if the wallet permits it. */
export function permittedAccount(accounts: readonly Hex[], address: string): Hex | undefined {
  return accounts.find((a) => sameAddress(a, address))
}

/**
 * Send from `address`: pinned at once when the wallet permits it, else the wallet's account picker
 * opens and it is pinned once granted. True when pinned at once.
 */
export function pickAccount(
  l1: {
    accounts: readonly Hex[]
    selectAccount: (account: Hex) => void
    switchAccount: (prefer?: Hex) => Promise<unknown>
  },
  address: Hex,
): boolean {
  const permitted = permittedAccount(l1.accounts, address)
  if (permitted) {
    l1.selectAccount(permitted)
    return true
  }
  void l1.switchAccount(address)
  return false
}

/**
 * Whether a saved wallet is an account of the connected wallet app. A deposit names its funder
 * after the wallet it came from; a contact without that name counts as the connected wallet's.
 */
export function savedInWallet(entry: Contact, walletName: string | null): boolean {
  const saved = entry.l1Wallet
  const from = saved?.provenance === "deposit-attested" && !saved.userLabeled && saved.walletName
  if (!from || from === L1_PLACEHOLDER_NAME || !walletName) return true
  return from.trim().toLowerCase() === walletName.trim().toLowerCase()
}
