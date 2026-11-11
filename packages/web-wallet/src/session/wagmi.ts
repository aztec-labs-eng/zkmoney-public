import { darkTheme, getDefaultConfig, type Theme } from "@rainbow-me/rainbowkit"
import {
  base as baseWallet,
  coinbaseWallet,
  ledgerWallet,
  metaMaskWallet,
  rainbowWallet,
  readyWallet,
  safeWallet,
  trustWallet,
  uniswapWallet,
  walletConnectWallet,
  zerionWallet,
} from "@rainbow-me/rainbowkit/wallets"
import { l1Transport, type WebWalletConfig } from "../config/env"
import { isDemoMode } from "../dev/demoFlag"
import { rabbyWallet } from "./rabbyWallet"
import { walletChains } from "./walletChains"
import { createConfig, type Config } from "wagmi"

const base = darkTheme({
  accentColor: "#a000ff",
  accentColorForeground: "#fdfdfd",
  borderRadius: "medium",
  overlayBlur: "small",
})

/** Stock RainbowKit modal, painted with web-ds tokens. */
export const rainbowkitTheme: Theme = {
  ...base,
  fonts: { body: "var(--font-body)" },
  colors: {
    ...base.colors,
    accentColor: "var(--purple-500)",
    accentColorForeground: "var(--text-primary)",
    closeButtonBackground: "var(--surface-faint)",
    connectButtonBackground: "var(--surface-sheet)",
    connectButtonText: "var(--text-primary)",
    error: "var(--accent-pink)",
    generalBorder: "var(--border-hairline)",
    generalBorderDim: "var(--border-hairline)",
    menuItemBackground: "var(--surface-card)",
    modalBackground: "var(--surface-sheet)",
    modalBorder: "var(--border-hairline)",
    modalText: "var(--text-primary)",
    modalTextDim: "var(--text-secondary)",
    modalTextSecondary: "var(--text-secondary)",
    profileAction: "var(--surface-card)",
    profileActionHover: "var(--surface-faint)",
    profileForeground: "var(--surface-sheet)",
  },
  radii: {
    ...base.radii,
    actionButton: "var(--radius-12)",
    modal: "var(--radius-16)",
    modalMobile: "var(--radius-16)",
  },
}

// Same fallback project id as launch-campaign-web.
const projectId =
  (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ||
  "119816ec622bbdb56824439b1e72e824"

/** wagmi config for RainbowKit: the L1 over the shared transport, then the bridge's chains. */
export function wagmiConfig(config: WebWalletConfig): Config {
  const { chains, transports: bridgeTransports } = walletChains(config)
  const transports = { ...bridgeTransports, [chains[0].id]: l1Transport(config) }
  // Capture fixtures do not initialize wallet connectors or their remote configuration clients.
  if (import.meta.env.DEV && isDemoMode()) {
    return createConfig({
      chains,
      connectors: [],
      multiInjectedProviderDiscovery: false,
      transports,
      storage: null,
    })
  }
  return getDefaultConfig({
    appName: "zk.money",
    appDescription: "Private payments on Ethereum",
    appUrl: window.location.origin,
    appIcon: `${window.location.origin}/favicon.png`,
    projectId,
    // Replaces RainbowKit's stock Popular group with the same wallets plus Rabby, which people look
    // for by name on phones as well as desktops: the extension when it is injected (deduped with
    // its EIP-6963 announcement by rdns), the Rabby app over WalletConnect otherwise.
    // safeWallet reports itself installed only inside a Safe App iframe, and is filtered out
    // everywhere else. "More" holds wallets that pair over a scanned QR. Phantom and Brave stay
    // unlisted: injected-only and rarely asked for, so EIP-6963 surfacing them once installed is
    // enough, and a named entry would be an install prompt for everyone else.
    wallets: [
      {
        groupName: "Popular",
        wallets: [
          safeWallet,
          rainbowWallet,
          baseWallet,
          metaMaskWallet,
          rabbyWallet,
          walletConnectWallet,
        ],
      },
      {
        groupName: "More",
        wallets: [
          readyWallet,
          trustWallet,
          coinbaseWallet,
          ledgerWallet,
          uniswapWallet,
          zerionWallet,
        ],
      },
    ],
    chains,
    transports,
    // No storage. A persisted connection is never revived (reconnectOnMount is off), but wagmi
    // rehydrates it as a method-less {id,name,type,uid} stub with `current` set — and a cancelled
    // connect then flips status back to "connected" on that stub, so the app claims a session the
    // wallet never had and every connector call throws. RainbowKit's "Recent" badge is its own
    // rk-recent key, so nothing about reconnecting gets harder.
    storage: null,
  })
}
