/**
 * TransferScannerMount — side-effect-only component (inside WalletGate) running the wallet's chain
 * sync: the `WalletSyncCoordinator` that ingests incoming transfers and writes the balances on each
 * synced tick (Main's, and Savings' shares once Savings' deployment resolves), and the one-shot
 * rescan that rebuilds Main's withdrawal records this browser never had from the account's own
 * recovery events (`WebSavingsProvider` rebuilds Savings' with its moves), and the one-shot import
 * of the activity this browser kept for the account on retired rollups. Independent of XMTP.
 * Exactly one tab scans transfers at a time: the visible tab holds the `transfer-scan` Web Lock
 * while scanning, so two tabs can never interleave TransactionStorage's read-modify-write or
 * advance the shared cursor past each other's rows (browsers without Web Locks fall back to
 * scanning per-tab). Pauses while the tab is hidden; re-acquires on visibility return.
 *
 * The withdrawal rescan and the historic import each wait for their boot stage (see `bootPriority`).
 *
 * Also owns the request-fulfillment reconciler: receive rows are inserted here, and the reconciler
 * listens to that in-process insert event (plus a store sweep for the receive-before-request
 * order), so it must live with the scanner rather than the XMTP pipeline — it then also runs in
 * XMTP-unsupported browsers and non-leader tabs.
 */

import { useEffect } from "react"
import type { TokenService, WalletBalances } from "@obsidion/sdk"
import {
  balanceScope,
  BalanceStorage,
  bootPriority,
  ContactStorage,
  createTagForwardResolver,
  createWalletSyncSource,
  getActiveNetworkId,
  RequestStorage,
  startRequestFulfillmentReconciler,
  TransactionStorage,
  useAccountContext,
  useAssetContext,
  useAztecContext,
  useContractServiceContext,
  WalletSyncCoordinator,
  WithdrawalStorage,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { resolveTagForCommit } from "../../features/contacts/registryResolution"
import { loadWalletIdentity } from "../../features/identity/walletIdentity"
import {
  importHistoricActivityOnce,
  importHistoricContactsOnce,
} from "../../features/migration/historicActivityImport"
import { upgradeFirst } from "../../features/migration/upgradeFirst"
import { savingsRescanToken } from "../../features/savings/savingsGateway"
import { rescanWithdrawals } from "../../features/withdraw/withdrawGateway"
import { webStorage } from "../storage/WebStorageAdapter"
import { createContactsByL2 } from "../xmtp/adapters"

const TRANSFER_SCAN_LOCK = "transfer-scan"

/** How long a failed Savings lookup waits before it tries again. */
export const SAVINGS_LOOKUP_RETRY_MS = 30_000

export function TransferScannerMount(): null {
  const { tokenService } = useAssetContext()
  const { obsidionWallet, currentNetwork } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const { contractService } = useContractServiceContext()

  // Built for the account the page runs on: its balance is read and cached under its address.
  useEffect(() => {
    const identity = loadWalletIdentity()
    const networkId = getActiveNetworkId()
    if (
      !tokenService ||
      !obsidionWallet ||
      !obsidionAccount ||
      !identity ||
      !networkId ||
      !currentNetwork
    )
      return

    const transactionStore = TransactionStorage.get(webStorage)
    const stopReconciler = startRequestFulfillmentReconciler(
      RequestStorage.get(),
      transactionStore,
      ContactStorage.get(),
    )

    let disposed = false
    let building = false
    let built: { acquire: () => void; release: () => void } | undefined

    // Savings' token, looked up at its boot stage: its shares are read beside Main's balance. A
    // failed lookup is tried again by the next ask.
    let savingsLookup: ReturnType<typeof savingsRescanToken> | undefined
    const savingsToken = (account: NonNullable<typeof obsidionAccount>) => {
      if (savingsLookup) return savingsLookup
      const lookup = bootPriority
        .whenReady("savings")
        .then(() => savingsRescanToken(obsidionWallet, account))
      lookup.catch(() => savingsLookup === lookup && (savingsLookup = undefined))
      return (savingsLookup = lookup)
    }

    void bootPriority
      .whenReady("historicActivity")
      .then(() => (disposed ? undefined : importHistoricActivityOnce()))
      .catch((err: unknown) =>
        console.warn(
          "[TransferScannerMount] historic activity import failed (retried next boot)",
          err,
        ),
      )

    void importHistoricContactsOnce().catch((err: unknown) =>
      console.warn(
        "[TransferScannerMount] historic contacts import failed (retried next boot)",
        err,
      ),
    )

    void bootPriority
      .whenReady("withdrawalRescan")
      .then(() => (disposed ? undefined : rescanWithdrawals(obsidionWallet, [{ tokenService }])))
      .catch((err: unknown) =>
        console.warn(
          "[TransferScannerMount] withdrawal rescan failed (the Savings replay retries it)",
          err,
        ),
      )

    // Read beside Main's balance at every synced anchor, keyed by token address.
    const alsoRead = new Map<string, TokenService>()
    let trackRetry: ReturnType<typeof setTimeout> | undefined
    const trackSavings = (account: NonNullable<typeof obsidionAccount>) =>
      void savingsToken(account)
        .then((savings) => {
          if (!savings || disposed) return
          alsoRead.set(savings.tokenService.tokenAddress.toString(), savings.tokenService)
          return WalletSyncCoordinator.refreshBalance()
        })
        .catch((err: unknown) => {
          console.warn("[TransferScannerMount] Savings balance not read yet, retrying", err)
          if (!disposed)
            trackRetry = setTimeout(() => trackSavings(account), SAVINGS_LOOKUP_RETRY_MS)
        })
    trackSavings(obsidionAccount)

    const build = async (): Promise<void> => {
      if (disposed || built || building) return
      building = true
      try {
        await upgradeFirst.v6MayStart()
        if (disposed) return
        const token = await tokenService.fetchTokenInformation()
        if (disposed) return
        const coordinator = new WalletSyncCoordinator({
          source: createWalletSyncSource({
            readBalances: async () => {
              const balances: WalletBalances = {}
              const readAt: Record<string, number> = {}
              const stamp = (address: string, balance: bigint) => {
                balances[address] = balance
                readAt[address] = Date.now()
              }
              stamp(token.address, await tokenService.readBalanceAssumingSynced(obsidionAccount))
              // Another token's failed read leaves Main's balance standing; the next tick retries it.
              for (const [address, service] of alsoRead) {
                try {
                  stamp(address, await service.readBalanceAssumingSynced())
                } catch (err) {
                  console.warn(`[TransferScannerMount] balance of ${address} unread`, err)
                }
              }
              return { balances, readAt }
            },
            prepareToken: async () => {
              await tokenService.getTokenContract()
            },
            wallet: obsidionWallet,
            tokenAddress: token.address,
            accountAddress: identity.address,
            contractService: contractService ?? undefined,
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
              obsidionAccount.getCompleteAddress().toString(),
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
          endpointScope: getConfig().nodeEndpointDigest,
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
      clearTimeout(trackRetry)
      document.removeEventListener("visibilitychange", onVisibility)
      built?.release()
      stopReconciler()
    }
  }, [tokenService, obsidionWallet, obsidionAccount, currentNetwork, contractService])

  return null
}
