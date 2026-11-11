import { useCallback } from "react"
import type { Hex } from "viem"
import type { Config } from "wagmi"
import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit"
import { useStore } from "@obsidion/front-core"
import { useScreenFlow } from "../ui/useScreenFlow"
import { useSession } from "./session"
import { wrongChain, type ConnectedWallet } from "./l1Wallet"

interface L1WalletState {
  /** The account deposits send from: the app's selection, not the wallet's. */
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
  /**
   * True while a connect is out: RainbowKit's wallet picker is up, the WalletConnect sheet it opens
   * included, or `connectAnother` is opening it.
   */
  pickerOpen: boolean
  /**
   * Drop the connected wallet and open RainbowKit's connect modal for another. `then` runs with the
   * wallet the modal connects; never for a dismissed modal, nor once a later `connectAnother`
   * replaced it.
   */
  connectAnother: (then?: (wallet: ConnectedWallet) => void) => void
  /** Opens the connect modal once a render offers it: the `open` that `connectAnother` takes. */
  openPicker: () => Promise<void>
  /** The latest render's picker, or the connect it started: the `pickerOpen` it takes. */
  pickerShown: () => boolean
  /** Drop the wagmi session. The wallet itself stays permitted until the user revokes it. */
  disconnect: () => void
  /** Switch to the expected chain; true once switched. */
  switchNetwork: () => Promise<boolean>
  /** Pick the sending account among the permitted ones; held until the wallet switches account. */
  selectAccount: (account: Hex) => void
  /**
   * Re-open the wallet's permission picker to grant more accounts, then send from `prefer` when
   * granted, else from the first permitted account. Resolves false when the wallet refused.
   */
  switchAccount: (prefer?: Hex) => Promise<boolean | void>
  /** The page's wagmi config, which the exits sign with. */
  wagmi: Config
}

/**
 * The page's L1 wallet for a view, with RainbowKit's modals. RainbowKit keeps its modal state in
 * React and offers its connect modal only once a render has seen the wallet disconnected.
 */
export function useL1Wallet(opts?: { expectedChainId?: number; rpcUrl?: string }): L1WalletState {
  const { page } = useSession()
  const l1 = page.l1Wallet
  const view = useStore(l1.view)
  const { openConnectModal, connectModalOpen } = useConnectModal()
  const { openAccountModal } = useAccountModal()
  const pickerOpen = connectModalOpen || view.reopening
  const picker = useScreenFlow(
    { openConnectModal, pickerOpen, connecting: view.connecting },
    (latest) => ({
      start() {},
      // React renders a store change in a microtask: past it, the latest render saw the disconnect.
      async open() {
        await Promise.resolve()
        latest().openConnectModal?.()
      },
      isOpen: () => latest().pickerOpen || latest().connecting,
    }),
  )

  const connectAnother = useCallback(
    (then?: (wallet: ConnectedWallet) => void) =>
      void l1.connectAnother(picker.open, picker.isOpen).then((wallet) => wallet && then?.(wallet)),
    [l1, picker],
  )
  const connect = useCallback(async () => {
    ;(openAccountModal ?? openConnectModal)?.()
  }, [openAccountModal, openConnectModal])
  const expectedChainId = opts?.expectedChainId
  const switchNetwork = useCallback(
    async () => expectedChainId != null && l1.switchNetwork(expectedChainId),
    [expectedChainId, l1],
  )

  return {
    account: view.account,
    accounts: view.accounts,
    chainId: view.chainId,
    walletName: view.walletName,
    connecting: view.connecting,
    wrongChain: wrongChain(view, expectedChainId),
    connect,
    pickerOpen,
    connectAnother,
    openPicker: picker.open,
    pickerShown: picker.isOpen,
    disconnect: l1.disconnect,
    switchNetwork,
    selectAccount: l1.selectAccount,
    switchAccount: l1.switchAccount,
    wagmi: page.wagmi,
  }
}
