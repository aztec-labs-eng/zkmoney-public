import { getWebBroadcasterArtifact } from "../../config/classArtifacts"
/**
 * Session wiring for historic residual detection: read the manifest's other same-rollup entries,
 * bind the unlocked wallet's stealth key / PXE / L1 client, and run `probeHistoricResiduals`.
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
  deriveRefundableSipaSources,
  deriveStealthKey,
  PendingPaylinkMigrationService,
  PendingPaylinkMigrationStore,
  setupSipaDiscovery,
  TransactionStorage,
  WithdrawalStorage,
  deriveBootstrapKey,
} from "@obsidion/front-core"
import {
  fetchSipaEvents,
  IntraRollupMigrationService,
  isSipaDepositClaimed,
  type ObsidionAccount,
  type ObsidionWallet,
  predictAccountAddress,
} from "@obsidion/sdk"
import { erc20Abi, type Address } from "viem"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { latestChainSeconds } from "../paylink/chainTime"
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
  residuals: HistoricResidualSummary[]
  /** Non-terminal withdrawals, surfaced so the user knows they are untouched. */
  pendingWithdrawals: number
} | null> {
  const config = getConfig()
  const publicClient = l1PublicClient(config)
  const { current, historic } = await IntraRollupMigrationService.detectHistoricDeployments({
    ...config.oxideProfile,
    network: config.network,
    publicClient,
  })
  if (historic.length === 0) {
    console.info("[migration] no historic deployments in manifest")
    return null
  }

  const { transactions, pendingPaylinks } = pendingPaylinkService()
  const chainSec = await chainSeconds(wallet)
  const msk = await getAuthService().getSecretKey()
  if (!msk) {
    console.info("[migration] wallet locked — probe skipped")
    return null
  }
  const stealthPublicKey = deriveStealthKey(msk).publicKey
  const recipient = account.getAddress()
  const depositMetadata = await (
    await account.makeDepositSpendMetadataResolver()
  )(recipient as never)
  const scanHead = await publicClient.getBlockNumber({ cacheTime: 0 })
  const found = await probeHistoricResiduals({
    wallet,
    account,
    publicClient,
    current,
    historic,
    rows: await transactions.getTransactions(),
    nowSec: chainSec,
    sipaDiscovery: {
      scanRange: (tuple) => deploymentScanRange(publicClient, tuple, scanHead),
      sources: async (tuple) => {
        // Registers the senders the historic token's `SIPA` events are tagged with.
        await setupSipaDiscovery({
          artifactFor: (address) => getWebBroadcasterArtifact(wallet, address),
          pxe: wallet.pxe as never,
          node: wallet.node as never,
          publicClient,
          tuple,
          network: config.network,
          resolverFallbackTuple: current,
          scanHead,
        })
        const events = await fetchSipaEvents(
          wallet,
          AztecAddress.fromStringUnsafe(tuple.l2Token),
          recipient as never,
        )
        return deriveRefundableSipaSources({
          events: events.map((event) => ({
            messageSecret: event.sharedSecretSalt.toString(),
            resweepable: event.resweepable,
          })),
          recipientL2Address: recipient.toString(),
          stealthPublicKey,
          tuple,
          // An account-protocol deployment commits its SIPAs to the owner's L1 account.
          recoveryAccount:
            tuple.sipaRecoveryProtocol === "account" && tuple.accountFactory
              ? await predictAccountAddress(
                  publicClient,
                  tuple.accountFactory as Address,
                  deriveBootstrapKey(msk).address,
                )
              : undefined,
        })
      },
      balance: (tuple, sipaAddress) =>
        publicClient.readContract({
          address: tuple.token as Address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [sipaAddress as Address],
        }),
      claimed: (tuple, deposit) =>
        isSipaDepositClaimed(wallet.node as never, {
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
    residuals: found.filter((r) => r.hasResiduals),
    pendingWithdrawals: countPendingWithdrawals(withdrawals.list()),
  }
}
