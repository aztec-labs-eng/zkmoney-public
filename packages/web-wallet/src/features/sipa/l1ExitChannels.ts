/**
 * How an L1 exit reaches the chain. Two channels, because the desktop launcher's Chrome profile
 * carries no wallet extension: an injected wallet both pays the gas and receives the funds, while
 * the launcher hands the prepared transaction to a helper page in the user's default browser and
 * the funds go to an address the user types (any EOA can submit — only `target` is paid).
 */
import type { Address, Hex, PublicClient } from "viem"
import type { Config } from "wagmi"
import type { Pace } from "@obsidion/core/cadence"
import { WalletError } from "@obsidion/core/errors"
import { l1ChainFor, type WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { submitViaDesktopBridge } from "../../platform/desktopBridge"
import { getL1Clients } from "../../session/l1Wallet"
import copy from "./l1ExitChannels.copy"

/** A live L1 receipt wait's interval. viem keeps its own timer, which no pace wake reaches. */
export const L1_RECEIPT_POLL_MS = 4_000

/** Progress of one L1 submission — shared by both exits. */
export type L1ExitStage = "signing" | "awaiting-browser" | "confirming"

/** Who the transaction pays and how it reaches L1. Shared by the recovery and self-sweep exits. */
export interface L1ExitChannel {
  /** Receives the recovered funds, the deposit fee on a self-sweep, or a finalize's relayer tip. */
  target: Address
  sendTransaction: (to: Address, data: Hex) => Promise<Hex>
  /** False on a reverted transaction. */
  waitForReceipt: (hash: Hex) => Promise<boolean>
}

/**
 * The injected wallet pays the gas and is itself the destination. Receipts are polled over the
 * app's own RPC, not the wallet's: connected over a scanned QR the wallet is a phone behind a
 * WalletConnect relay, and plenty of mobile wallets answer no reads at all. `readClient` overrides
 * that for callers whose environment cannot reach the RPC.
 */
export async function injectedWalletChannel(
  config: WebWalletConfig,
  opts: {
    wagmi: Config
    from?: Hex
    onStage?: (stage: L1ExitStage) => void
    readClient?: PublicClient
    /** The page's: the receipt wait polls at its interval. */
    pace: Pick<Pace, "foreignMs">
  },
): Promise<L1ExitChannel> {
  const { walletClient, account, chain } = await getL1Clients(
    opts.wagmi,
    config.l1ChainId,
    opts.from,
  )
  const publicClient = opts.readClient ?? l1PublicClient(config)
  return {
    target: account,
    sendTransaction: async (to, data) => {
      const block = await publicClient.getBlock({ blockTag: "latest" })
      // EIP-7825 caps individual transactions on Ethereum and Sepolia independently of the
      // block limit. Local/other chains retain their own block limit.
      const transactionCap = chain.id === 1 || chain.id === 11155111 ? 16_777_216n : block.gasLimit
      const limit = block.gasLimit < transactionCap ? block.gasLimit : transactionCap
      // Bound the estimate too: some RPCs otherwise simulate against the larger block limit.
      // Propagate estimation errors before signing; never let a wallet substitute a fallback.
      const estimate = await publicClient.estimateGas({ to, data, account, gas: limit })
      if (estimate > limit) {
        throw new WalletError(
          "tx.overGasLimit",
          `gas estimate ${estimate} exceeds the limit ${limit}`,
        )
      }
      const buffered = (estimate * 120n + 99n) / 100n
      const gas = buffered < limit ? buffered : limit
      opts.onStage?.("signing")
      return walletClient.sendTransaction({ to, data, account, chain, gas })
    },
    waitForReceipt: async (hash) => {
      opts.onStage?.("confirming")
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: opts.pace.foreignMs(L1_RECEIPT_POLL_MS),
      })
      return receipt.status === "success"
    },
  }
}

export interface DesktopBridgeChannelParams {
  /**
   * Who the transaction pays. Typed by the user on the deposit exits; on a withdrawal finalize it
   * is the withdrawal's own recipient, which takes the relayer tip.
   */
  destination: Address
  /** The only account the helper page may pay from. */
  from?: Address
  chainId: number
  /** App-owned client: the helper page's wallet is not ours to poll. */
  publicClient: PublicClient
  /** Helper-page summary; the network row is appended. */
  display: { title: string; lines: [string, string][] }
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
  /** The page's: the receipt wait polls at its interval. */
  pace: Pick<Pace, "foreignMs">
}

/** Submission through the desktop launcher's helper page in the user's default browser. */
export function desktopBridgeChannel(params: DesktopBridgeChannelParams): L1ExitChannel {
  return {
    target: params.destination,
    sendTransaction: (to, data) => {
      params.onStage?.("awaiting-browser")
      return submitViaDesktopBridge({
        onHelperOpened: params.onHelperOpened,
        tx: { from: params.from, to, data, chainId: params.chainId },
        display: {
          title: params.display.title,
          lines: [...params.display.lines, [copy.network, l1ChainFor(params.chainId).name]],
        },
      })
    },
    waitForReceipt: async (hash) => {
      params.onStage?.("confirming")
      const receipt = await params.publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: params.pace.foreignMs(L1_RECEIPT_POLL_MS),
      })
      return receipt.status === "success"
    },
  }
}
