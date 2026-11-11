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
  deploymentScanRange,
  type After,
  type CheckSpent,
  HISTORIC_ACTIVITY_IMPORTED_KEY,
  linkedActivity,
  PendingPaylinkMigrationService,
  PendingPaylinkMigrationStore,
} from "@obsidion/front-core"
import {
  detectHistoricDeployments,
  frozenSourceSummary,
  migrationRouteFor,
  readSipaDepositsConsumed,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { l1MulticallClient } from "../../config/oxideTuple"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import type { PageChain } from "../../session/pageChain"
import type { Session } from "../../session/session"
import { stillCommitted } from "../../session/stillCommitted"
import { latestChainSeconds } from "../paylink/chainTime"
import { isReadableSource, sourceChain } from "./historicTokenContext"
import { markRefundedSourceLinks, sourceFrozenEscrows, sourceLinkRows } from "./sourceFrozenEscrows"
import { sourceSavingsDeposits } from "./sourceSavingsDeposits"
import { importHistoricActivityOnce } from "./historicActivityImport"
import { readSourceHistory } from "./sourceHistoryReplay"
import { sourceSipaSources } from "./sourceSipaSources"
import { ManifestUnavailableError } from "./freezeWatch"

/** A frozen source's links its refunds paid out on L1: escrow note reads, after the history import. */
const REFUNDED_AFTER: After = {
  firstBalance: true,
  depositsReplayed: true,
  movesReplayed: true,
  historyAtHead: true,
}
import {
  recordRetiredSourceRead,
  retiredSourceCandidate,
  retiredSourceSettled,
  type L1Tip,
} from "./upgradeLock"
import {
  awaitingFreezeResidual,
  countPendingWithdrawals,
  probeHistoricResiduals,
  type HistoricResidualSummary,
} from "./historicResiduals"

function pendingPaylinkService(own: Session, checkSpent?: CheckSpent) {
  const { transfers, paylinks, operations, notifications } = own
  const rows = () => linkedActivity(transfers, paylinks, operations)
  return {
    rows,
    pendingPaylinks: new PendingPaylinkMigrationService({
      store: PendingPaylinkMigrationStore.get(webStorage),
      notifications,
      accountTransactions: rows,
      checkSpent,
      ownsStorage: () => stillCommitted(own),
    }),
  }
}

const chainSeconds = (wallet: ObsidionWallet) => latestChainSeconds(wallet.node).catch(() => null)

export async function reconcilePendingPaylinks(
  session: Session,
  wallet: ObsidionWallet,
  checkSpent?: CheckSpent,
): Promise<void> {
  const sec = await chainSeconds(wallet)
  if (sec != null)
    await pendingPaylinkService(session, checkSpent).pendingPaylinks.reconcile(
      sec,
      wallet.networkId,
    )
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
export async function migrationFeatureListed(reads: PageChain, waiting: readonly FeatureWait[]) {
  reads.invalidateDeployment()
  const { deployment } = await reads.oxideDeployment.read()
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
  session: Session,
  wallet: ObsidionWallet,
  account: ObsidionAccount,
  /** The account's name: its registration addresses are found from it. */
  handle: string | undefined,
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
  const { config, chain: pageChain } = session.page
  // A previous generation whose profile boot could not read is missing from the config, so its
  // sources would read as no history too. Only a reload reads its profile again.
  const unread = config.sourceRollupIssues ?? []
  if (unread.length)
    throw new ManifestUnavailableError(
      new Error(
        `previous-generation profile unread: ${unread
          .map(({ profileUrl, code }) => `${profileUrl} (${code})`)
          .join(", ")}`,
      ),
    )
  // Folds the contract reads of the scan, and of the migration subsidy, into Multicall3 calls.
  const publicClient = l1MulticallClient(config)
  const storageId = session.namespace.id
  // Unread, its sources would read as no history: the probe fails as a manifest that cannot be read.
  const otherSources = await pageChain.otherManifestSources.read().catch((error) => {
    throw new ManifestUnavailableError(error)
  })
  const savings = await pageChain.savingsTuple.read().catch((error) => {
    console.warn("[migration] the Savings deployment failed to load:", error)
    return undefined
  })
  const products = savings ? [{ tuple: savings, symbol: "sUSDS" }] : []
  const detected = await detectHistoricDeployments({
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
  const accountId = account.getAddress().toString()
  const offRollup = (tuple: OxideEnvTuple) => tuple.rollupVersion !== current.rollupVersion
  // A settled source on another rollup is not read, so its rollup's node, PXE and bundle stay unloaded.
  const settled = listed.filter(
    (tuple) => offRollup(tuple) && retiredSourceSettled(config, accountId, tuple.portal),
  )
  const reading = listed.filter((tuple) => !settled.includes(tuple))
  const readable = await Promise.all(reading.map((t) => isReadableSource(config, current, t)))
  const historic = reading.filter((_, i) => readable[i])
  const awaiting = reading.filter((_, i) => !readable[i])
  if (historic.length === 0 && awaiting.length === 0) {
    console.info("[migration] no historic deployments to read")
    return {
      current,
      historic,
      destinations,
      residuals: [],
      pendingWithdrawals: 0,
      chainTimeUnknown: false,
    }
  }

  const { rows, pendingPaylinks } = pendingPaylinkService(session)
  const chainSec = await chainSeconds(wallet)
  const msk = await session.auth.getSecretKey()
  if (!msk || !storageId) {
    console.info("[migration] wallet locked — probe skipped")
    return null
  }
  // The key and the link rows must be the account the probe started for.
  if (!stillCommitted(session)) {
    console.info("[migration] account changed — probe skipped")
    return null
  }
  const recipient = account.getAddress()
  const depositMetadata = await (
    await account.makeDepositSpendMetadataResolver()
  )(recipient as never)
  const scanHead = await publicClient.getBlockNumber({ cacheTime: 0 })
  // A retired deployment on another rollup is read through that rollup's node and PXE.
  const chainFor = (tuple: OxideEnvTuple) =>
    sourceChain(config, { wallet, account }, current, tuple, session.auth)
  const found = await probeHistoricResiduals({
    wallet,
    account,
    publicClient,
    current,
    historic,
    rows: await rows(),
    nowSec: chainSec,
    frozenSource: async (tuple, depositDescriptors) => {
      const chain = await chainFor(tuple)
      const unverified = new Set<string>()
      const allDescriptors = async () => [
        ...(await depositDescriptors()),
        ...(await sourceSavingsDeposits({
          page: session.page,
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
      const paylinkRows = () => sourceLinkRows({ tuple, current, own: session })
      if (chain.kind === "pxe") {
        const summary = await frozenSourceSummary({
          client: publicClient,
          ...chain,
          tuple,
          depositDescriptors: allDescriptors,
          escrows: async () =>
            sourceFrozenEscrows({
              chain,
              contractService: await session.contractService.ready(),
              tuple,
              masterSecret: msk,
              rows: await paylinkRows(),
            }),
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
          page: session.page,
          chain: await chainFor(tuple),
          tuple,
          publicClient,
          masterSecret: msk,
          scanHead,
          handle,
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
  // Each pass answers whether the source's history is in and its links were checked.
  const passes = new Map<string, Promise<boolean>>()
  for (const tuple of historic) {
    if (destinations.get(tuple.portal.toLowerCase())?.symbol) continue
    const pass = chainFor(tuple)
      .then(async (chain) => {
        if (chain.kind !== "generation") return true
        const { session: migration } = chain
        // `/tags`: a source read before counterparty tags were checked is read once more for them.
        const key = `${HISTORIC_ACTIVITY_IMPORTED_KEY}/${
          migration.rollupAddress
        }/${tuple.l2Token.toLowerCase()}/tags`
        const replay = importHistoricActivityOnce(session, storageId, {
          key,
          read: () =>
            readSourceHistory({
              page: session.page,
              session: migration,
              tuple,
              publicClient,
              masterSecret: msk,
              scanHead,
              handle,
              // A settled source still names the portal of a Savings move made through it.
              deployments: [...historic, ...settled].filter(
                (t) => t.rollupVersion === tuple.rollupVersion,
              ),
            }),
        }).catch((error) =>
          console.warn(`[migration] history replay failed for ${tuple.portal}:`, error),
        )
        if (!(await session.milestones.after(REFUNDED_AFTER))) return false
        // Its boot stage reports a failed import of this browser's databases.
        await Promise.allSettled([replay, importHistoricActivityOnce(session, storageId)])
        await markRefundedSourceLinks({ session: migration, tuple, current, own: session })
        if (!stillCommitted(session)) return false
        // A link row either import brings in later would miss its refund check.
        const imported = await Promise.all(
          // eslint-disable-next-line local/legacy-store -- ZKM-1625
          [key, HISTORIC_ACTIVITY_IMPORTED_KEY].map((k) => webStorage.getItem(k)),
        )
        return imported.every((marker) => marker !== null)
      })
      .catch((error) => {
        console.warn(`[migration] refunded link check failed for ${tuple.portal}:`, error)
        return false
      })
    passes.set(tuple.portal.toLowerCase(), pass)
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
      .then(() => pageChain.oxideDeployment.read())
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
  if (!stillCommitted(session)) {
    console.info("[migration] account changed — probe results dropped")
    return null
  }
  const { withdrawals } = session
  await withdrawals.ready
  const pending = found.flatMap((r) => r.paylinkCandidates)
  await pendingPaylinks.recordPending(pending, wallet.networkId)
  // A legacy row without a token matches every retired deployment: a live one's claim keeps it.
  const claimed = new Set(pending.map((row) => row.txHash))
  await pendingPaylinks.retire(
    found.flatMap((r) =>
      r.frozenLinks.flatMap((row) => (row.txHash && !claimed.has(row.txHash) ? [row.txHash] : [])),
    ),
  )
  // A frozen source holds nothing new once read empty, so it settles once such a read is final.
  let finalized: Promise<bigint> | undefined
  const finalizedBlock = () =>
    (finalized ??= publicClient.getBlock({ blockTag: "finalized" }).then((block) => block.number))
  /** Whether `prior` is final and still the chain's block at its height. */
  const onFinalChain = async (prior: L1Tip | undefined) => {
    if (!prior || (await finalizedBlock()) < prior.number) return false
    return (await publicClient.getBlock({ blockNumber: prior.number })).hash === prior.hash
  }
  for (const r of found) {
    if (!offRollup(r.tuple) || !r.frozen || r.incomplete) continue
    if (r.hasResiduals || r.unverifiedMoves) {
      recordRetiredSourceRead(config, accountId, r.tuple.portal, { empty: false })
      continue
    }
    void (passes.get(r.tuple.portal.toLowerCase()) ?? Promise.resolve(true))
      .then(async (done) => {
        if (!done || !stillCommitted(session)) return
        // Read once the source's reads are done, so it is past every refund they saw.
        const tip = await publicClient.getBlock({ blockTag: "latest" })
        recordRetiredSourceRead(config, accountId, r.tuple.portal, {
          empty: true,
          tip: { number: tip.number, hash: tip.hash },
          priorFinal: await onFinalChain(retiredSourceCandidate(config, accountId, r.tuple.portal)),
        })
      })
      .catch((error) => console.warn(`[migration] settling ${r.tuple.portal} failed:`, error))
  }
  return {
    current,
    historic,
    destinations,
    // An incomplete scan stays visible, so an empty result never reads as drained.
    residuals: [...withFeatures, ...awaitingFreeze].filter(
      (r) => r.hasResiduals || r.incomplete || !!r.unverifiedMoves,
    ),
    pendingWithdrawals: countPendingWithdrawals(await withdrawals.all()),
    chainTimeUnknown: chainSec === null,
  }
}
