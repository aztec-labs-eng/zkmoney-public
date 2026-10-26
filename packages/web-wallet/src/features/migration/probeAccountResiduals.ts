/**
 * Session wiring for historic residual detection: read the manifest's retired entries the profile
 * reaches, bind the unlocked wallet's stealth key / PXE / L1 client, and run `probeHistoricResiduals`.
 * Returns null when there is no history or the wallet is locked. Every still-escrowed historic
 * paylink it finds is recorded for `reconcilePendingPaylinks`.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address } from "viem"
import {
  AppNotificationStore,
  bootPriority,
  type CheckSpent,
  deploymentScanRange,
  HISTORIC_ACTIVITY_IMPORTED_KEY,
  PendingPaylinkMigrationService,
  PendingPaylinkMigrationStore,
  retiredDatabaseOf,
  TransactionStorage,
  WithdrawalStorage,
} from "@obsidion/front-core"
import {
  frozenSourceSummary,
  IntraRollupMigrationService,
  migrationRouteFor,
  readSipaDepositsConsumed,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import {
  getOtherManifestSources,
  getOxideDeployment,
  invalidateOxideDeployment,
  l1MulticallClient,
} from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { latestChainSeconds } from "../paylink/chainTime"
import { getSavingsTuple } from "../savings/savingsGateway"
import { isReadableSource, sourceChain } from "./historicTokenContext"
import { markRefundedSourceLinks, sourceFrozenEscrows, sourceLinkRows } from "./sourceFrozenEscrows"
import { sourceSavingsDeposits } from "./sourceSavingsDeposits"
import { importHistoricActivityOnce } from "./historicActivityImport"
import { sourceSipaScanParams, sourceSipaSources } from "./sourceSipaSources"
import { ManifestUnavailableError } from "./freezeWatch"
import {
  awaitingFreezeResidual,
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

/** Whether `destination`'s deployment publishes a usable migration route for `source`. */
function hasMigrationRoute(
  deployment: Parameters<typeof migrationRouteFor>[0],
  source: OxideEnvTuple,
  destination: OxideEnvTuple,
): boolean {
  if (!deployment) return false
  try {
    return !!migrationRouteFor(
      deployment,
      source.portal as Address,
      destination.portal as Address,
      destination.operationExecutor as Address,
    )
  } catch (error) {
    console.warn(`[migration] the migration feature for ${source.portal} is unusable:`, error)
    return false
  }
}

/** A frozen source that waits for its destination's migration feature, and that destination. */
export interface FeatureWait {
  source: OxideEnvTuple
  destination: OxideEnvTuple
}

/**
 * Whether one of `waiting` has a usable migration route now. It drops the cached manifest and reads
 * it again, and reads nothing else. A failed read throws.
 */
export async function migrationFeatureListed(waiting: readonly FeatureWait[]): Promise<boolean> {
  invalidateOxideDeployment()
  const { deployment } = await getOxideDeployment(getConfig())
  return waiting.some(({ source, destination }) =>
    hasMigrationRoute(deployment, source, destination),
  )
}

/** Where a historic deployment's funds move: the pinned deployment, or a product of its asset. */
export interface ResidualDestination {
  tuple: OxideEnvTuple
  /** The destination product's symbol; absent for the pinned deployment. */
  symbol?: string
}

export async function probeAccountResiduals(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
): Promise<{
  current: OxideEnvTuple
  historic: OxideEnvTuple[]
  /** Each historic deployment's destination by lowercase portal. */
  destinations: ReadonlyMap<string, ResidualDestination>
  residuals: HistoricResidualSummary[]
  /** Non-terminal withdrawals, surfaced so the user knows they are untouched. */
  pendingWithdrawals: number
  /** The chain tip was unreadable, so no paylink was judged against its claim window. */
  chainTimeUnknown: boolean
} | null> {
  const config = getConfig()
  // Folds the contract reads of the scan, and of the migration subsidy, into Multicall3 calls.
  const publicClient = l1MulticallClient(config)
  const storageId = getActiveStorageId()
  const otherSources = await getOtherManifestSources(config).catch((error) => {
    // Under-report; next boot retries.
    console.warn("[migration] another generation's manifest failed to load:", error)
    return []
  })
  const savings = await getSavingsTuple(config).catch((error) => {
    console.warn("[migration] the Savings deployment failed to load:", error)
    return undefined
  })
  const products = savings ? [{ tuple: savings, symbol: "sUSDS" }] : []
  const detected = await IntraRollupMigrationService.detectHistoricDeployments({
    ...config.oxideProfile,
    network: config.network,
    publicClient,
    sourcePortals: new Set(config.sourceRollupNodes?.keys()),
    otherSources,
    products: products.map((p) => p.tuple),
  })
  const { current, historic: listed } = detected
  const symbolOf = (tuple: OxideEnvTuple) =>
    products.find((p) => p.tuple.portal.toLowerCase() === tuple.portal.toLowerCase())?.symbol
  const destinations = new Map(
    [...detected.destinations].map(([portal, tuple]) => [
      portal,
      { tuple, symbol: symbolOf(tuple) },
    ]),
  )
  const readable = await Promise.all(listed.map((tuple) => isReadableSource(current, tuple)))
  const historic = listed.filter((_, i) => readable[i])
  const awaiting = listed.filter((_, i) => !readable[i])
  if (historic.length === 0 && awaiting.length === 0) {
    console.info("[migration] no historic deployments in manifest")
    return {
      current,
      historic,
      destinations,
      residuals: [],
      pendingWithdrawals: 0,
      chainTimeUnknown: false,
    }
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
  const chainFor = (tuple: OxideEnvTuple) => sourceChain({ wallet, account }, current, tuple)
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
      const unverified = new Set<string>()
      const allDescriptors = async () => [
        ...(await depositDescriptors()),
        ...(await sourceSavingsDeposits({
          chain,
          tuple,
          sourceTuples: listed,
          publicClient,
          masterSecret: msk,
          scanHead,
          onUnverified: (move) => unverified.add(move.nonce.toLowerCase()),
        })),
      ]
      const unverifiedMoves = () => (unverified.size ? { unverifiedMoves: unverified.size } : {})
      const paylinkRows = () => sourceLinkRows({ tuple, current, storageId })
      if (chain.kind === "pxe") {
        const summary = await frozenSourceSummary({
          client: publicClient,
          ...chain,
          tuple,
          depositDescriptors: allDescriptors,
          escrows: async () =>
            sourceFrozenEscrows({ chain, tuple, masterSecret: msk, rows: await paylinkRows() }),
        })
        return summary && { ...summary, ...unverifiedMoves() }
      }
      const summary = await chain.session.frozenSummary({
        tuple,
        depositDescriptors: allDescriptors,
        paylinkRows,
      })
      return (
        summary && {
          ...summary,
          notes: BigInt(summary.notes),
          links: BigInt(summary.links),
          waitingAmount: BigInt(summary.waitingAmount),
          ...unverifiedMoves(),
        }
      )
    },
    sipaDiscovery: {
      scanRange: (tuple) => deploymentScanRange(publicClient, tuple, scanHead),
      sources: async (tuple) =>
        sourceSipaSources({
          chain: await chainFor(tuple),
          tuple,
          publicClient,
          masterSecret: msk,
          scanHead,
        }),
      consumed: async (tuple, deposits) => {
        const chain = await chainFor(tuple)
        // Another generation's deployment is read only once frozen, and a frozen scan skips this.
        if (chain.kind !== "pxe") throw new Error("A live source of another generation is not read")
        return readSipaDepositsConsumed(
          chain.wallet.node as never,
          {
            l2Token: AztecAddress.fromStringUnsafe(tuple.l2Token),
            masterNullifierHidingKey: depositMetadata.masterNullifierHidingKey as never,
          },
          deposits.map((deposit) => deposit.messageKey),
        )
      },
    },
  })
  // The account's history on a frozen wallet-token source of another generation: that generation's
  // own sync rebuilds it, and it is imported as a retired database. A Savings source holds none.
  // Once that and this browser's retired rows are in, the links the upgrade refunded are marked.
  for (const tuple of historic) {
    if (destinations.get(tuple.portal.toLowerCase())?.symbol) continue
    void chainFor(tuple)
      .then(async (chain) => {
        if (chain.kind !== "generation") return
        const { session } = chain
        const replay = importHistoricActivityOnce({
          key: `${HISTORIC_ACTIVITY_IMPORTED_KEY}/${
            session.rollupAddress
          }/${tuple.l2Token.toLowerCase()}`,
          read: async () =>
            retiredDatabaseOf(
              tuple.rollupVersion,
              await session.history({
                ...(await sourceSipaScanParams({
                  tuple,
                  publicClient,
                  masterSecret: msk,
                  scanHead,
                })),
                accountTag: loadWalletIdentity()?.handle ?? session.address,
                linkBase: `${location.origin}/link#`,
                deployments: historic.filter((t) => t.rollupVersion === tuple.rollupVersion),
              }),
            ),
        }).catch((error) =>
          console.warn(`[migration] history replay failed for ${tuple.portal}:`, error),
        )
        await bootPriority.whenReady("refundedLinks")
        // Its boot stage reports a failed import of this browser's databases.
        await Promise.allSettled([replay, importHistoricActivityOnce()])
        await markRefundedSourceLinks({ session, tuple, current, storageId })
      })
      .catch((error) =>
        console.warn(`[migration] refunded link check failed for ${tuple.portal}:`, error),
      )
  }
  const awaitingFreeze = await Promise.all(
    awaiting.map(async (tuple) => {
      try {
        const chain = await chainFor(tuple)
        if (chain.kind !== "generation") throw new Error("A live source of this generation is read")
        return awaitingFreezeResidual(tuple, BigInt(await chain.session.balance({ tuple })), false)
      } catch (error) {
        console.warn(`[migration] balance probe failed for live portal ${tuple.portal}:`, error)
        return awaitingFreezeResidual(tuple, 0n, true)
      }
    }),
  )
  // A frozen source moves only through its destination's migration feature. Until the manifest
  // lists a usable one, the upgrade waits for it. Read only when a frozen source is found, so no
  // other probe pays for it. A failed read fails the probe, so the last scan stays.
  let pinned: Promise<Parameters<typeof hasMigrationRoute>[0]> | undefined
  const pinnedDeployment = () =>
    (pinned ??= Promise.resolve()
      .then(() => getOxideDeployment(config))
      .then(({ deployment }) => deployment)
      .catch((error) => {
        throw new ManifestUnavailableError(error)
      }))
  const withFeatures = await Promise.all(
    found.map(async (r) => {
      if (!r.frozen) return r
      const destination = destinations.get(r.tuple.portal.toLowerCase())?.tuple ?? current
      return hasMigrationRoute(await pinnedDeployment(), r.tuple, destination)
        ? r
        : { ...r, awaitingFeature: true }
    }),
  )
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
    destinations,
    // An incomplete scan stays visible, so an empty result never reads as drained.
    residuals: [...withFeatures, ...awaitingFreeze].filter(
      (r) => r.hasResiduals || r.incomplete || !!r.unverifiedMoves,
    ),
    pendingWithdrawals: countPendingWithdrawals(withdrawals.list()),
    chainTimeUnknown: chainSec === null,
  }
}
