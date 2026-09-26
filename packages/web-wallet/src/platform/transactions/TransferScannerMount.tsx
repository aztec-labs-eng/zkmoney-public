/**
 * TransferScannerMount — side-effect-only component (inside WalletGate) running the wallet's chain
 * sync: the `WalletSyncCoordinator` that ingests incoming transfers and writes the balance on each
 * synced tick, and the one-shot rescan that rebuilds withdrawal records this browser never had
 * from the account's own `Withdraw` events. Independent of XMTP. Exactly one tab scans transfers
 * at a time: the visible tab holds the `transfer-scan` Web Lock while scanning, so two tabs can
 * never interleave TransactionStorage's read-modify-write or advance the shared cursor past each
 * other's rows (browsers without Web Locks fall back to scanning per-tab). Pauses while the tab is
 * hidden; re-acquires on visibility return.
 *
 * Also owns the request-fulfillment reconciler: receive rows are inserted here, and the reconciler
 * listens to that in-process insert event (plus a store sweep for the receive-before-request
 * order), so it must live with the scanner rather than the XMTP pipeline — it then also runs in
 * XMTP-unsupported browsers and non-leader tabs.
 */

import { useEffect } from "react"
import {
  BalanceStorage,
  ContactStorage,
  RequestStorage,
  TransactionStorage,
  WalletSyncCoordinator,
  WithdrawalStorage,
  balanceScope,
  createTagForwardResolver,
  createWalletSyncSource,
  getActiveNetworkId,
  startRequestFulfillmentReconciler,
  useAssetContext,
  useAztecContext,
} from "@obsidion/front-core"
import { resolveTagForCommit } from "../../features/contacts/registryResolution"
import { loadWalletIdentity } from "../../features/identity/walletIdentity"
import { rescanWithdrawals } from "../../features/withdraw/withdrawGateway"
import { webStorage } from "../storage/WebStorageAdapter"
import { createContactsByL2 } from "../xmtp/adapters"

const TRANSFER_SCAN_LOCK = "transfer-scan"

export function TransferScannerMount(): null {
  const { tokenService } = useAssetContext()
  const { obsidionWallet, currentNetwork } = useAztecContext()

  useEffect(() => {
    const identity = loadWalletIdentity()
    const networkId = getActiveNetworkId()
    if (!tokenService || !obsidionWallet || !identity || !networkId || !currentNetwork) return

    const transactionStore = TransactionStorage.get(webStorage)
    const stopReconciler = startRequestFulfillmentReconciler(RequestStorage.get(), transactionStore)

    let disposed = false
    let building = false
    let built: { acquire: () => void; release: () => void } | undefined

    rescanWithdrawals(obsidionWallet, tokenService).catch((err) => {
      console.warn("[TransferScannerMount] withdrawal rescan failed (retried on next mount)", err)
    })

    const build = async (): Promise<void> => {
      if (disposed || built || building) return
      building = true
      try {
        const token = await tokenService.fetchTokenInformation()
        if (disposed) return
        const coordinator = new WalletSyncCoordinator({
          source: createWalletSyncSource({
            readBalance: () => tokenService.readBalanceAssumingSynced(),
            wallet: obsidionWallet,
            tokenAddress: token.address,
            accountAddress: identity.address,
          }),
          storage: webStorage,
          transactionStore,
          // Always the Registry with a fresh manifest — the contact cache never vouches for a sender.
          tags: createTagForwardResolver(resolveTagForCommit),
          contacts: createContactsByL2(ContactStorage.get()),
          token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
          balance: {
            store: BalanceStorage.get(webStorage),
            scope: balanceScope(
              currentNetwork.type,
              tokenService.account.getCompleteAddress().toString(),
            ),
            tokenAddress: token.address,
          },
          transactions: transactionStore,
          withdrawals: WithdrawalStorage.get(webStorage),
        })
        const context = {
          accountAddress: identity.address,
          // Nameless accounts still receive; the tag is display-only, so fall back to the address.
          accountTag: identity.handle ?? identity.address,
          networkId,
        }

        // Lock leadership: request while visible, withdraw/release while hidden.
        let abort: AbortController | null = null
        let releaseHold: (() => void) | null = null
        const acquire = () => {
          if (abort || disposed) return
          if (typeof navigator.locks?.request !== "function") {
            // No Web Locks: single-tab semantics, scan directly.
            void coordinator.start(context)
            return
          }
          abort = new AbortController()
          const held = new Promise<void>((resolve) => {
            releaseHold = resolve
          })
          navigator.locks
            .request(TRANSFER_SCAN_LOCK, { signal: abort.signal }, async () => {
              await coordinator.start(context)
              await held
              coordinator.stop()
            })
            .catch(() => {}) // withdrawn while waiting (hidden / unmounted)
        }
        const release = () => {
          releaseHold?.()
          releaseHold = null
          abort?.abort()
          abort = null
          coordinator.stop()
        }
        built = { acquire, release }
        if (!disposed && document.visibilityState === "visible") acquire()
      } catch (err) {
        // Leave `built` unset so returning to the tab retries instead of never scanning again.
        console.warn("[TransferScannerMount] token info unavailable", err)
      } finally {
        building = false
      }
    }

    // Subscribed before the token fetch: it is also the retry trigger for a build that threw, so
    // one failed fetch must not leave the tab permanently blind to incoming transfers.
    const onVisibility = () => {
      if (disposed) return
      if (document.visibilityState !== "visible") {
        built?.release()
      } else if (built) {
        built.acquire()
      } else {
        void build()
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    void build()

    return () => {
      disposed = true
      document.removeEventListener("visibilitychange", onVisibility)
      built?.release()
      stopReconciler()
    }
  }, [tokenService, obsidionWallet, currentNetwork])

  return null
}
