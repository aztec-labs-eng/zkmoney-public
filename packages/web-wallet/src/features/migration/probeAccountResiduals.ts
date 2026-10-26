/**
 * Session wiring for historic residual detection: resolve the profile's selected migration sources,
 * bind the unlocked wallet's stealth key / PXE / L1 client, and run `probeHistoricResiduals`.
 * Every still-escrowed historic paylink it finds is recorded for `reconcilePendingPaylinks`.
 */
import { AztecAddress } from "@aztec/aztec.js/addresses"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  AppNotificationStore,
  type CheckSpent,
  deploymentScanRange,
  PendingPaylinkMigrationService,
  PendingPaylinkMigrationStore,
  TransactionStorage,
  WithdrawalStorage,
} from "@obsidion/front-core"
import {
  frozenSourceSummary,
  IntraRollupMigrationService,
  readSipaDepositsConsumed,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { latestChainSeconds } from "../paylink/chainTime"
import { historicChain } from "./historicTokenContext"
import { sourceFrozenEscrows } from "./sourceFrozenEscrows"
import { sourceSipaSources } from "./sourceSipaSources"
import {
  countPendingWithdrawals,
  probeHistoricResiduals,
  type HistoricResidualSummary,
} from "./historicResiduals"

function pendingPaylinkService(storageId: string | null, checkSpent?: CheckSpent) {
  const transactions = TransactionStorage.get(webStorage)
  return {
    transactions,
    pendingPaylinks: new PendingPaylinkMigrationService({
      store: PendingPaylinkMigrationStore.get(webStorage),
      notificationStore: AppNotificationStore.get(webStorage),
      accountTransactions: () => transactions.getTransactions(),
      checkSpent,
      ownsStorage: () => getActiveStorageId() === storageId,
    }),
  }
}

const chainSeconds = (wallet: ObsidionWallet) => latestChainSeconds(wallet.node).catch(() => null)

export async function reconcilePendingPaylinks(
  wallet: ObsidionWallet,
  checkSpent?: CheckSpent,
): Promise<void> {
  const storageId = getActiveStorageId()
  const sec = await chainSeconds(wallet)
  if (sec != null) await pendingPaylinkService(storageId, checkSpent).pendingPaylinks.reconcile(sec)
}

export async function probeAccountResiduals(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
): Promise<{
  current: OxideEnvTuple
  historic: OxideEnvTuple[]
  residuals: HistoricResidualSummary[]
  /** Non-terminal withdrawals, surfaced so the user knows they are untouched. */
  pendingWithdrawals: number
  /** The chain tip was unreadable, so no paylink was judged against its claim window. */
  chainTimeUnknown: boolean
} | null> {
  const config = getConfig()
  const publicClient = l1PublicClient(config)
  const storageId = getActiveStorageId()
  const { current, historic } = await IntraRollupMigrationService.detectHistoricDeployments({
    ...config.oxideProfile,
    network: config.network,
    publicClient,
    sourcePortals: new Set(config.sourceRollupNodes?.keys()),
  })
  if (historic.length === 0) {
    console.info("[migration] no supported migration sources in profile")
    return { current, historic, residuals: [], pendingWithdrawals: 0, chainTimeUnknown: false }
  }

  const { transactions, pendingPaylinks } = pendingPaylinkService(storageId)
  const chainSec = await chainSeconds(wallet)
  const msk = await getAuthService().getSecretKey()
  if (!msk || !storageId) {
    console.info("[migration] wallet locked — probe skipped")
    return null
  }
  // The key and the link rows must be the account the probe started for.
  if (getActiveStorageId() !== storageId) {
    console.info("[migration] account changed — probe skipped")
    return null
  }
  const recipient = account.getAddress()
  const depositMetadata = await (
    await account.makeDepositSpendMetadataResolver()
  )(recipient as never)
  const scanHead = await publicClient.getBlockNumber({ cacheTime: 0 })
  // A retired deployment on another rollup is read through that rollup's node and PXE.
  const chainFor = async (tuple: OxideEnvTuple) =>
    (await historicChain(account, current, tuple)) ?? { wallet, account }
  const found = await probeHistoricResiduals({
    wallet,
    account,
    publicClient,
    current,
    historic,
    rows: await transactions.getTransactions(),
    nowSec: chainSec,
    frozenSource: async (tuple, depositDescriptors) => {
      const chain = await chainFor(tuple)
      return frozenSourceSummary({
        client: publicClient,
        ...chain,
        tuple,
        depositDescriptors,
        escrows: () => sourceFrozenEscrows({ chain, tuple, current, masterSecret: msk, storageId }),
      })
    },
    sipaDiscovery: {
      scanRange: (tuple) => deploymentScanRange(publicClient, tuple, scanHead),
      sources: async (tuple) =>
        sourceSipaSources({
          chain: await chainFor(tuple),
          tuple,
          current,
          publicClient,
          masterSecret: msk,
          scanHead,
        }),
      consumed: async (tuple, deposits) =>
        readSipaDepositsConsumed(
          (
            await chainFor(tuple)
          ).wallet.node as never,
          {
            l2Token: AztecAddress.fromStringUnsafe(tuple.l2Token),
            masterNullifierHidingKey: depositMetadata.masterNullifierHidingKey as never,
          },
          deposits.map((deposit) => deposit.messageKey),
        ),
    },
  })
  // A scan that outlived its account writes nothing; the next account's probe reads its own.
  if (getActiveStorageId() !== storageId) {
    console.info("[migration] account changed — probe results dropped")
    return null
  }
  const withdrawals = WithdrawalStorage.get(webStorage)
  await withdrawals.load()
  const pending = found.flatMap((r) => r.paylinkCandidates)
  await pendingPaylinks.recordPending(pending)
  // A legacy row without a token matches every retired deployment: a live one's claim keeps it.
  const claimed = new Set(pending.map((row) => row.txHash))
  await pendingPaylinks.retire(
    found.flatMap((r) =>
      r.frozenLinks.flatMap((row) => (row.txHash && !claimed.has(row.txHash) ? [row.txHash] : [])),
    ),
  )
  return {
    current,
    historic,
    // An incomplete scan stays visible, so an empty result never reads as drained.
    residuals: found.filter((r) => r.hasResiduals || r.incomplete),
    pendingWithdrawals: countPendingWithdrawals(withdrawals.list()),
    chainTimeUnknown: chainSec === null,
  }
}
