import { useEffect } from "react"
import {
  balanceScope,
  BalanceStorage,
  bootPriority,
  ContactStorage,
  createSavingsLookup,
  createTagForwardResolver,
  createTransferScan,
  createWalletSyncSource,
  getActiveNetworkId,
  oldVersionWithdrawalTask,
  startRuntime,
  useAccountContext,
  useAssetContext,
  useAztecContext,
  useContractServiceContext,
  WalletSyncCoordinator,
  within,
  WithdrawalStorage,
  type ReadonlyStore,
} from "@obsidion/front-core"
import { getConfig } from "../config/env"
import { broadcastState } from "../features/broadcasts/broadcastState"
import { resolveTagForCommit } from "../features/contacts/registryResolution"
import { loadWalletIdentity } from "../features/identity/walletIdentity"
import {
  importHistoricActivityOnce,
  importHistoricContactsOnce,
} from "../features/migration/historicActivityImport"
import { upgradeFirst } from "../features/migration/upgradeFirst"
import { savingsRescanToken } from "../features/savings/savingsGateway"
import { settleOldVersionWithdrawal } from "../features/withdraw/oldVersionWithdrawals"
import { rescanWithdrawals } from "../features/withdraw/withdrawGateway"
import { oldVersionWithdrawalRecords } from "../ui/activity/feedSources"
import { useSession } from "./session"
import { webStorage } from "./storage/WebStorageAdapter"
import { createContactsByL2 } from "./xmtp/adapters"

const documentVisible: ReadonlyStore<boolean> = {
  get: () => document.visibilityState === "visible",
  subscribe(listener) {
    document.addEventListener("visibilitychange", listener)
    return () => document.removeEventListener("visibilitychange", listener)
  },
}

/**
 * Runs the wallet's background tasks while the account is unlocked over a ready PXE: the transfer
 * scan, the rescan of Main's withdrawals (Savings' are rebuilt with its moves), the Savings lookup,
 * old-version withdrawals' refund checks and the one-shot import of the activity this browser kept
 * for the account on retired rollups. They stop on lock or teardown.
 */
export function useWalletRuntime(enabled: boolean): void {
  const { tokenService } = useAssetContext()
  const { obsidionWallet, currentNetwork } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const { contractService } = useContractServiceContext()
  const { activity, kv } = useSession()

  useEffect(() => {
    const identity = loadWalletIdentity()
    const networkId = getActiveNetworkId()
    if (!enabled || !tokenService || !obsidionWallet || !obsidionAccount) return
    if (!identity || !networkId || !currentNetwork) return

    const scan = createTransferScan({
      context: {
        accountAddress: identity.address,
        // Nameless accounts still receive; the tag is display-only, so fall back to the address.
        accountTag: identity.handle ?? identity.address,
        networkId,
        endpointScope: getConfig().nodeEndpointDigest,
      },
      // The v6 balance sync waits for the upgrade's probe of a stale record.
      token: async () => {
        await upgradeFirst.v6MayStart()
        return tokenService.fetchTokenInformation()
      },
      visible: documentVisible,
      // The balance of the account the page runs on.
      main: {
        readBalanceAssumingSynced: () => tokenService.readBalanceAssumingSynced(obsidionAccount),
      },
      coordinator: (token, readBalances) =>
        new WalletSyncCoordinator({
          source: createWalletSyncSource({
            readBalances,
            prepareToken: async () => {
              await tokenService.getTokenContract()
            },
            wallet: obsidionWallet,
            tokenAddress: token.address,
            accountAddress: identity.address,
            contractService: contractService ?? undefined,
          }),
          kv,
          transactionStore: activity,
          // A fresh manifest: the contact cache never vouches for a sender.
          tags: createTagForwardResolver(resolveTagForCommit),
          contacts: createContactsByL2(ContactStorage.get()),
          token,
          balance: {
            store: BalanceStorage.get(webStorage),
            scope: balanceScope(
              currentNetwork.type,
              obsidionAccount.getCompleteAddress().toString(),
            ),
            tokenAddress: token.address,
          },
          transactions: activity.rows,
          withdrawals: WithdrawalStorage.get(webStorage),
        }),
    })
    const runtime = startRuntime(
      [
        scan.task,
        {
          id: "historicActivity",
          stage: "historicActivity",
          cadence: "once", // a failed import is retried next boot
          run: async () => void (await importHistoricActivityOnce()),
        },
        {
          id: "historicContacts",
          cadence: "once", // a failed import is retried next boot
          run: async () => void (await importHistoricContactsOnce()),
        },
        {
          id: "withdrawalRescan",
          stage: "withdrawalRescan",
          cadence: "once", // not retried: the Savings replay runs it again
          run: async ({ signal }) => {
            const rescan = rescanWithdrawals(obsidionWallet, [{ tokenService }])
            await within(rescan, "withdrawalRescan", { signal })
          },
        },
        createSavingsLookup({
          lookup: async () =>
            (await savingsRescanToken(obsidionWallet, obsidionAccount))?.tokenService,
          scan,
          refreshBalance: () => WalletSyncCoordinator.refreshBalance(),
        }),
        oldVersionWithdrawalTask({
          records: oldVersionWithdrawalRecords(),
          settle: (id) =>
            settleOldVersionWithdrawal(id, (hash) => broadcastState(obsidionWallet, hash)),
        }),
      ],
      {
        kv,
        whenReady: (stage) => bootPriority.whenReady(stage),
        visible: documentVisible,
      },
    )
    return () => {
      runtime.stop()
      scan.dispose()
    }
  }, [
    enabled,
    tokenService,
    obsidionWallet,
    obsidionAccount,
    currentNetwork,
    contractService,
    activity,
    kv,
  ])
}
