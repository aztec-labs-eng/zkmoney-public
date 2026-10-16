/**
 * Session wiring for historic residual detection: read the manifest's retired entries the profile
 * reaches, bind the unlocked wallet's stealth key / PXE / L1 client, and run `probeHistoricResiduals`.
 * Returns null when there is no history or the wallet is locked. Every still-escrowed historic
 * paylink it finds is recorded for `reconcilePendingPaylinks`.
 */
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
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
  isSipaDepositClaimed,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { erc20Abi, type Address } from "viem"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { latestChainSeconds } from "../paylink/chainTime"
import { historicChain } from "./historicTokenContext"
import { sourceSipaSources } from "./sourceSipaSources"
import {
  countPendingWithdrawals,
  probeHistoricResiduals,
  type HistoricResidualSummary,
} from "./historicResiduals"

function pendingPaylinkService(checkSpent?: CheckSpent) {
  const transactions = TransactionStorage.get(webStorage)
  return {
    transactions,
    pendingPaylinks: new PendingPaylinkMigrationService({
      store: PendingPaylinkMigrationStore.get(webStorage),
      notificationStore: AppNotificationStore.get(webStorage),
      accountTransactions: () => transactions.getTransactions(),
      checkSpent,
    }),
  }
}

const chainSeconds = (wallet: ObsidionWallet) => latestChainSeconds(wallet.node).catch(() => null)

export async function reconcilePendingPaylinks(
  wallet: ObsidionWallet,
  checkSpent?: CheckSpent,
): Promise<void> {
  const sec = await chainSeconds(wallet)
  if (sec != null) await pendingPaylinkService(checkSpent).pendingPaylinks.reconcile(sec)
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
  const { current, historic } = await IntraRollupMigrationService.detectHistoricDeployments({
    ...config.oxideProfile,
    network: config.network,
    publicClient,
    reachable: new Set(config.sourceRollupNodes?.keys()),
  })
  if (historic.length === 0) {
    console.info("[migration] no historic deployments in manifest")
    return { current, historic, residuals: [], pendingWithdrawals: 0, chainTimeUnknown: false }
  }

  const { transactions, pendingPaylinks } = pendingPaylinkService()
  const chainSec = await chainSeconds(wallet)
  const msk = await getAuthService().getSecretKey()
  if (!msk) {
    console.info("[migration] wallet locked — probe skipped")
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
    frozenSource: async (tuple, depositDescriptors) =>
      frozenSourceSummary({
        client: publicClient,
        ...(await chainFor(tuple)),
        tuple,
        depositDescriptors,
      }),
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
      balance: (tuple, sipaAddress) =>
        publicClient.readContract({
          address: tuple.token as Address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [sipaAddress as Address],
        }),
      claimed: async (tuple, deposit) =>
        isSipaDepositClaimed((await chainFor(tuple)).wallet.node as never, {
          l1Portal: tuple.portal as Address,
          l1ChainId: BigInt(config.l1ChainId),
          l2Token: AztecAddress.fromStringUnsafe(tuple.l2Token),
          rollupVersion: BigInt(tuple.rollupVersion),
          recipient,
          messageSecret: Fr.fromString(deposit.messageSecret),
          amount: deposit.amount,
          inboxIndex: deposit.messageLeafIndex,
          masterNullifierHidingKey: depositMetadata.masterNullifierHidingKey as never,
        }),
    },
  })
  const withdrawals = WithdrawalStorage.get(webStorage)
  await withdrawals.load()
  await pendingPaylinks.recordPending(found.flatMap((r) => r.paylinkCandidates))
  return {
    current,
    historic,
    // An incomplete scan stays visible, so an empty result never reads as drained.
    residuals: found.filter((r) => r.hasResiduals || r.incomplete),
    pendingWithdrawals: countPendingWithdrawals(withdrawals.list()),
    chainTimeUnknown: chainSec === null,
  }
}
