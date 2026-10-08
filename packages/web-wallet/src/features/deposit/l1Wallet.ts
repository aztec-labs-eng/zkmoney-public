/**
 * L1 wallet connection over wagmi/RainbowKit: exposes the connected account and a viem
 * walletClient for the ERC-20 transfer that funds a SIPA deposit address.
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
import { useCallback, useState } from "react"
import { useAccount, useSwitchChain } from "wagmi"
import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit"
import {
  disconnect as wagmiDisconnect,
  getAccount,
  switchChain as wagmiSwitchChain,
} from "wagmi/actions"
import { showReportableError } from "../../errors/errorModal"
import { l1ChainFor } from "../../config/env"
import { wagmiConfig } from "./wagmi"

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
function liveConnector() {
  const { connector } = getAccount(wagmiConfig())
  return typeof connector?.getProvider === "function" ? connector : undefined
}

/** The wagmi-connected wallet's provider, else the injected one (demo mode installs a fake). */
async function connectorProvider(): Promise<Eip1193> {
  const connector = liveConnector()
  if (connector) return (await connector.getProvider()) as Eip1193
  if (window.ethereum) return window.ethereum as Eip1193
  throw new Error("No wallet connected")
}

async function ensureChain(provider: Eip1193, chainId: number): Promise<void> {
  const config = wagmiConfig()
  const { chainId: current } = getAccount(config)
  if (liveConnector()) {
    if (current !== chainId) await wagmiSwitchChain(config, { chainId })
    return
  }
  const hex = `0x${chainId.toString(16)}`
  if ((await provider.request({ method: "eth_chainId" })) !== hex) {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] })
  }
}

/** Re-open the wallet's account permission picker (EIP-2255) and return the permitted set. */
async function requestAccountPermissions(): Promise<Hex[]> {
  const provider = await connectorProvider()
  await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] })
  const accounts = (await provider.request({ method: "eth_accounts" })) as Hex[]
  if (!accounts[0]) throw new Error("No account selected")
  return accounts
}

interface L1Clients {
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
export async function getL1Clients(chainId: number, from?: Hex): Promise<L1Clients> {
  const provider = await connectorProvider()
  await ensureChain(provider, chainId)
  const chain = l1ChainFor(chainId)
  const walletClient = createWalletClient({
    chain,
    transport: custom(withoutWalletNamespace(provider)),
  })
  // A wagmi connector already holds permission; the bare injected fallback must still prompt.
  const addresses = liveConnector()
    ? await walletClient.getAddresses()
    : await walletClient.requestAddresses()
  const account = from
    ? addresses.find((a) => a.toLowerCase() === from.toLowerCase())
    : addresses[0]
  if (!account) {
    throw new Error(
      from
        ? "That account is no longer connected. Reconnect it in your wallet and try again."
        : "No account connected",
    )
  }
  return { walletClient, account, chain }
}

interface L1WalletState {
  /** The account deposits send from — the app's selection, not the wallet's. */
  account: Hex | null
  /** Every account the wallet has permitted for this origin. */
  accounts: Hex[]
  chainId: number | null
  /** Connector name for display ("Deposit from Rainbow"). */
  walletName: string | null
  connecting: boolean
  /** True when connected but on the wrong chain for the active network. */
  wrongChain: boolean
  /** Open RainbowKit's connect modal (the account modal once connected). */
  connect: () => Promise<void>
  /** True while RainbowKit's wallet picker is up, the WalletConnect sheet it opens included. */
  pickerOpen: boolean
  /** Drop the wagmi session. The wallet itself stays permitted until the user revokes it. */
  disconnect: () => void
  /** Switch to the expected chain (the connector adds it when the wallet lacks it). */
  switchNetwork: () => Promise<void>
  /** Pick the sending account among the permitted ones. */
  selectAccount: (account: Hex) => void
  /** Re-open the wallet's permission picker to grant more accounts. */
  switchAccount: () => Promise<void>
}

/** React state for the wagmi-connected wallet. */
export function useL1Wallet(opts?: { expectedChainId?: number; rpcUrl?: string }): L1WalletState {
  const { addresses, chainId, connector, isConnecting, isReconnecting } = useAccount()
  const { switchChainAsync, isPending: switching } = useSwitchChain()
  const { openConnectModal, connectModalOpen } = useConnectModal()
  const { openAccountModal } = useAccountModal()
  const [selected, setSelected] = useState<Hex | null>(null)
  const [busy, setBusy] = useState(false)

  const accounts = (addresses ?? []) as Hex[]
  const account =
    selected && accounts.some((a) => a.toLowerCase() === selected.toLowerCase())
      ? selected
      : accounts[0] ?? null

  const expectedChainId = opts?.expectedChainId
  const wrongChain = expectedChainId != null && chainId != null && chainId !== expectedChainId

  const switchNetwork = useCallback(async () => {
    if (expectedChainId == null) return
    try {
      await switchChainAsync({ chainId: expectedChainId })
    } catch (e) {
      if (!isWalletRejection(e)) showReportableError(e, "l1-wallet:network-switch")
    }
  }, [expectedChainId, switchChainAsync])

  const switchAccount = useCallback(async () => {
    setBusy(true)
    try {
      const [first] = await requestAccountPermissions()
      setSelected(first)
    } catch (e) {
      if (!isWalletRejection(e)) showReportableError(e, "l1-wallet:account-switch")
    } finally {
      setBusy(false)
    }
  }, [])

  const connect = useCallback(async () => {
    ;(openAccountModal ?? openConnectModal)?.()
  }, [openAccountModal, openConnectModal])

  const disconnect = useCallback(() => {
    setSelected(null)
    const config = wagmiConfig()
    // Tear the wallet's session down best-effort, then drop ours regardless. wagmi clears its
    // state only after the wallet answers, and a phone that dropped the session answers a
    // disconnect no sooner than it answers anything else — the button has to work anyway.
    const connector = liveConnector()
    if (connector) void wagmiDisconnect(config, { connector }).catch(() => {})
    config.setState({
      ...config.state,
      connections: new Map(),
      current: null,
      status: "disconnected",
    })
  }, [])

  return {
    account,
    accounts,
    chainId: chainId ?? null,
    walletName: connector?.name ?? null,
    connecting: isConnecting || isReconnecting || switching || busy,
    wrongChain,
    connect,
    pickerOpen: connectModalOpen,
    disconnect,
    switchNetwork,
    selectAccount: setSelected,
    switchAccount,
  }
}
