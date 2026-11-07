import {
  getWalletConnectConnector,
  type RainbowKitWalletConnectParameters,
  type Wallet,
} from "@rainbow-me/rainbowkit"
import { rabbyWallet as rabbyExtension } from "@rainbow-me/rainbowkit/wallets"

type Params = { projectId: string; walletConnectParameters?: RainbowKitWalletConnectParameters }

/**
 * Rabby's own scheme on both platforms. Its Android app registers only `rabby`, never `wc`, so the
 * raw WalletConnect uri RainbowKit hands Android would open some other wallet; the app accepts
 * `rabby://wc?uri=` on iOS and Android alike.
 */
const deepLink = (uri: string) => `rabby://wc?uri=${encodeURIComponent(uri)}`

const HOMEPAGE = "https://rabby.io/"

/**
 * Rabby by name on every platform: the extension when it is injected, the Rabby app over
 * WalletConnect otherwise. Dedupes with Rabby's EIP-6963 announcement by rdns.
 */
export const rabbyWallet = ({ projectId, walletConnectParameters }: Params): Wallet => {
  const extension = rabbyExtension()
  const downloadUrls = {
    ...extension.downloadUrls,
    ios: "https://apps.apple.com/us/app/rabby-wallet-crypto-evm/id6474381673",
    android: "https://play.google.com/store/apps/details?id=com.debank.rabbymobile",
    mobile: HOMEPAGE,
    qrCode: HOMEPAGE,
  }
  if (extension.installed) return { ...extension, downloadUrls }
  return {
    ...extension,
    installed: undefined,
    downloadUrls,
    mobile: {
      getUri: deepLink,
    },
    qrCode: {
      getUri: (uri) => uri,
      instructions: {
        learnMoreUrl: HOMEPAGE,
        steps: [
          {
            step: "install",
            title: "Install the Rabby app",
            description: "Get Rabby Wallet from the App Store or Google Play.",
          },
          {
            step: "create",
            title: "Create or import a wallet",
            description: "Set up a new wallet or bring in one you already have.",
          },
          {
            step: "scan",
            title: "Scan the code",
            description: "Use the scanner in Rabby to read this code and approve the connection.",
          },
        ],
      },
    },
    createConnector: getWalletConnectConnector({ projectId, walletConnectParameters }),
  }
}
