import { cssStringFromTheme, darkTheme, getDefaultConfig, lightTheme } from "@rainbow-me/rainbowkit"
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

/** Stock RainbowKit modal, painted with web-ds tokens. */
const painted = (stock: typeof darkTheme) => {
  const base = stock({ borderRadius: "medium", overlayBlur: "small" })
  return {
    ...base,
    fonts: { body: "var(--font-body)" },
    colors: {
      ...base.colors,
      accentColor: "var(--purple-500)",
      accentColorForeground: "var(--on-brand-text-primary)",
      // Ink tints, not the white surface tokens, so they still show on the light sheet.
      closeButtonBackground: "rgba(var(--ink-rgb), 0.03)",
      connectButtonBackground: "var(--surface-sheet)",
      connectButtonText: "var(--text-primary)",
      error: "var(--accent-pink)",
      generalBorder: "var(--border-hairline)",
      generalBorderDim: "var(--border-hairline)",
      menuItemBackground: "rgba(var(--ink-rgb), 0.05)",
      modalBackground: "var(--surface-sheet)",
      modalBorder: "var(--border-hairline)",
      modalText: "var(--text-primary)",
      modalTextDim: "var(--text-secondary)",
      modalTextSecondary: "var(--text-secondary)",
      profileAction: "rgba(var(--ink-rgb), 0.05)",
      profileActionHover: "rgba(var(--ink-rgb), 0.03)",
      profileForeground: "var(--surface-sheet)",
    },
    radii: {
      ...base.radii,
      actionButton: "var(--radius-12)",
      modal: "var(--radius-16)",
      modalMobile: "var(--radius-16)",
    },
  }
}

export const rainbowkitTheme = painted(darkTheme)

const light = painted(lightTheme)

/**
 * What the wallet's light theme changes in `rainbowkitTheme`: RainbowKit's own light colors where
 * no token stands in, and the wallet's scrim. RainbowKit switches its themes on the system's color
 * scheme, not on the wallet's `data-theme`, so this stylesheet does it.
 */
export const rainbowkitLightCss = `:root[data-theme="light"] [data-rk]{${cssStringFromTheme(
  { ...light, colors: { ...light.colors, modalBackdrop: "rgba(var(--canvas-rgb), 0.65)" } },
  { extends: rainbowkitTheme },
)}}`

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
