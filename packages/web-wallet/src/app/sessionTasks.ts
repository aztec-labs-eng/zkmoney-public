/**
 * A session's feature tasks, services and views, built over its core. `openSession` takes them from
 * here through its deps, so `session/` imports no feature.
 */
import {
  WalletSyncCoordinator,
  balanceScope,
  bestEffort,
  createRequests,
  createTagForwardResolver,
  derived,
  memoryStore,
  oldVersionWithdrawalTask,
  resource,
  reorg,
  savingsLookup,
  sipaBroadcasts,
  transferScan,
  watchNotifications,
  watchPayerApprovals,
  type OxideResumeDeps,
  type PendingRegistrationRecord,
  type ReadonlyStore,
  type Resource,
  type SipaProcessingState,
} from "@obsidion/front-core"
import {
  createWalletSyncSource,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"
import { getConfig } from "../config/env"
import { getOxideTuple, l1PublicClient } from "../config/oxideTuple"
import { broadcastState } from "../features/broadcasts/broadcastState"
import {
  oweRegistrationBroadcast,
  registrationExecutor,
  type RegistrationPayloads,
} from "../features/broadcasts/registrationExecutor"
import { resolveTagForCommit } from "../features/contacts/registryResolution"
import {
  createFundingStamps,
  fundDeposit,
  type FundDepositParams,
} from "../features/deposit/fundDeposit"
import { readL1DepositTokenBalance } from "../features/deposit/l1DepositTokenBalance"
import { createSipaAddresses } from "../features/deposit/sipaAddresses"
import {
  resolverDeploymentsResource,
  sipaDiscoveryResource,
  sipaKeysResource,
} from "../features/deposit/sipaRail"
import { sipaPipeline } from "../features/deposit/sipaTasks"
import { historicImports } from "../features/migration/historicActivityImport"
import {
  bell,
  bellRows,
  notificationSources,
  recordReorgOutcome,
} from "../features/notifications/notifications"
import { interruptedSweep, operationsSettle } from "../features/operations/operationsTasks"
import { claimPublishesAddress } from "../features/paylink/ticketContinuation"
import { chainFunding, fundingTransfers } from "../features/registration/registrationFunding"
import { chainPricing, registrationPricing } from "../features/registration/registrationPricing"
import { registrationRecovery } from "../features/registration/registrationRecovery"
import {
  registrationDetection,
  registrationEntry,
  registrationHeal,
  registrationIdentity,
  registrationRederive,
  registrationRefunds,
  sponsoredRail,
} from "../features/registration/registrationTasks"
import type { RailPending } from "../features/registration/sponsoredRailReadiness"
import { buildWebDetectionDeps } from "../features/registration/webRegistration"
import { openSavings, savingsRescanToken } from "../features/savings/savingsGateway"
import { savingsMovesReplay, savingsResource } from "../features/savings/savingsTasks"
import { loadDepositDisplayFacts, tokenMetadata } from "../features/sipa/loadDepositFacts"
import { settleOldVersionWithdrawal } from "../features/withdraw/oldVersionWithdrawals"
import { rescanWithdrawals, withdrawalRescan } from "../features/withdraw/withdrawGateway"
import { wallClock } from "../lib/clock"
import { isDesktopL1SubmitActive, submitViaDesktopBridge } from "../platform/desktopBridge"
import { legacyUnlisted } from "../platform/storage/requests"
import { createContactsByL2 } from "../platform/xmtp/adapters"
import { saveIdentity } from "../session/account"
import { getL1Clients } from "../session/l1Wallet"
import type { Page } from "./sessionDeps"
import type { SessionCore, SignInDeps } from "../session/session"
import {
  activityReads,
  contactActivity,
  feedBase,
  feedSources,
  mergedRows,
  oldVersionWithdrawalRecords,
} from "../ui/activity/feedSources"

const NOTHING_WAITS: ReadonlyStore<ReadonlyMap<string, SipaProcessingState>> = memoryStore(
  new Map(),
).readonly

/** What the feed, the bell and the contact lists read, and the watchers that write from them. */
function views(core: SessionCore) {
  const { db, activity, withdrawals, sipaDeposits, notifications, milestones } = core
  const processing = core.sipaProcessingObserver()?.states ?? NOTHING_WAITS
  const reads = activityReads(activity)
  const requests = createRequests({
    db,
    payments: derived([reads.paying, sipaDeposits.view] as const, (rows, sipa) => ({
      rows: rows.records,
      deposits: sipa.records,
      loaded: rows.loaded && sipa.loaded,
      failed: rows.failed || sipa.failed,
    })),
    legacyUnlisted,
  })
  const base = feedBase(requests, withdrawals, sipaDeposits, processing)
  const rows = bellRows(activity, notifications, reads.open)
  const sources = notificationSources(
    base,
    rows,
    core.identity,
    milestones,
    core.registrations.view,
  )
  // Home: the window, with every pending row, escrowed link and request payment.
  const homeRows = mergedRows([activity.view, reads.pending, reads.open, reads.paying])
  return {
    requests,
    reads,
    base,
    homeRows,
    feed: feedSources(base, homeRows),
    contactActivity: contactActivity(activity, requests, withdrawals, sipaDeposits),
    bell: bell(sources, notifications),
    sources,
  }
}

/** Builds the session's feature tasks, services and views over `core`. */
export function sessionTasks(
  core: SessionCore,
  page: Pick<Page, "signup" | "pastUser" | "onboardingMock" | "demoDepositAddress">,
) {
  const { deps, db, activity, withdrawals, sipaDeposits, notifications, milestones } = core
  const { namespace, wallet, contractService, signIn } = deps
  const { account, token, wake } = core
  const stops: Array<() => void> = []
  let built: ReturnType<typeof views> | undefined
  const open = () => {
    if (built) return built
    built = views(core)
    stops.push(watchNotifications(built.sources, wallClock, notifications))
    if (signIn) {
      // The payer of each paid request becomes a full contact.
      stops.push(
        watchPayerApprovals({
          requests: built.requests,
          rows: derived([built.reads.paying], (rows) => rows.records),
          approve: (address) => signIn.contacts.approveAutoAdded(address),
        }),
      )
    }
    return built
  }
  if (signIn) open()
  /** An account's chain sync, its Savings and the background work over them. */
  const accountWork = (
    signIn: SignInDeps,
    account: Resource<ObsidionAccount>,
    token: Resource<TokenService>,
  ) => {
    const scan = transferScan({
      wallet,
      account,
      token,
      contractService,
      tag: () => core.identity.get().value?.handle,
      endpointScope: () => deps.endpointScope,
      visible: deps.visible,
      coordinator: ({ wallet, account, token, contractService }, readBalances) =>
        new WalletSyncCoordinator({
          source: createWalletSyncSource({
            readBalances,
            prepareToken: async () => void (await token.getTokenContract()),
            wallet,
            tokenAddress: token.metadata.address,
            accountAddress: account.getAddress().toString(),
            contractService,
          }),
          db,
          transactionStore: activity,
          // A fresh manifest: the contact cache never vouches for a sender.
          tags: createTagForwardResolver(resolveTagForCommit),
          contacts: createContactsByL2(signIn.contacts),
          token: token.metadata,
          balance: {
            store: signIn.balances,
            scope: balanceScope(deps.network, account.getCompleteAddress().toString()),
            tokenAddress: token.metadata.address,
          },
          // A pending row settles wherever it sits, even past the newest rows.
          transactions: mergedRows([activity.view, open().reads.pending]),
          withdrawals: withdrawals.list,
          milestones,
        }),
    })
    const savings = savingsResource(
      [wallet, account, token, contractService],
      (wallet, account, tokenService, contractService) =>
        openSavings({
          wallet,
          account,
          tokenService,
          network: deps.network,
          contractService,
          refreshBalance: () => scan.refreshBalance(),
        }),
    )
    const rescan = rescanWithdrawals({
      store: withdrawals,
      deployment: () => getOxideTuple(getConfig()),
      l1Symbol: (token) => tokenMetadata(getConfig(), token).then((m) => m.symbol),
      wake: () => void wake(core.withdrawalTracker),
    })
    const tasks = [
      scan.task,
      withdrawalRescan({ wallet, account, token }, rescan),
      savingsLookup({ wallet, account, scan, lookup: savingsRescanToken }),
      savingsMovesReplay({ wallet, account, token, savings }, milestones, {
        rescan,
        savingsToken: savingsRescanToken,
      }),
      oldVersionWithdrawalTask({
        wallet,
        records: oldVersionWithdrawalRecords(),
        settle: (id, wallet) =>
          settleOldVersionWithdrawal(id, (hash) => broadcastState(wallet, hash)),
      }),
      ...historicImports(wallet, signIn, deps),
    ]
    return { scan, savings, tasks }
  }
  const work = signIn && account && token ? accountWork(signIn, account, token) : null
  const fundingStamps = createFundingStamps(sipaDeposits)
  const sipaKeys = account
    ? sipaKeysResource(wallet, account, () => deps.auth.getSecretKey())
    : null
  const sipaDiscovery = sipaDiscoveryResource(wallet)
  const resolverDeployments = sipaKeys && resolverDeploymentsResource(sipaKeys)
  const wakeBroadcasts = () => void wake(broadcasts.task)
  const pipeline =
    work && account && token && sipaKeys && resolverDeployments
      ? sipaPipeline({
          store: sipaDeposits,
          registrations: core.registrations,
          db,
          wallet,
          keys: sipaKeys,
          discovery: sipaDiscovery,
          deployments: resolverDeployments,
          account,
          token,
          milestones,
          visible: deps.visible,
          catchUp: deps.catchUp,
          custody: deps.custody(core.registrations.view, sipaDeposits.view, withdrawals.list),
          stamps: fundingStamps,
          refreshBalance: () => work.scan.refreshBalance(),
          async republish(sipa, sinceBlock) {
            const at = Date.now()
            const reopened = await sipaDeposits.apply(sipa, {
              type: "broadcastRepublish",
              sinceBlock,
              at,
            })
            wakeBroadcasts()
            return !!reopened
          },
        })
      : null
  const railPending = memoryStore<RailPending>(undefined)
  const sipaAddresses =
    sipaKeys &&
    createSipaAddresses({
      store: sipaDeposits,
      wallet,
      keys: sipaKeys,
      discovery: sipaDiscovery,
      identity: core.identity,
      railPending: railPending.readonly,
      wakeBroadcasts,
      wake,
    })
  const { onIdle, ...broadcasting } = deps.broadcasts
  const registrationPayloads: RegistrationPayloads = new Map()
  const registrationBroadcasts = {
    registrationPayloads,
    sipaDeposits,
    nameClaims: core.nameClaims,
    registrations: core.registrations,
    accountRecord: core.accountRecord,
    namespace,
    database: deps.database,
    device: deps.device,
    identity: core.identity,
    signup: page.signup,
  }
  const registrationReads = resource(
    "registrationReads",
    { from: [], lazy: true, backoff: "manual" },
    () => buildWebDetectionDeps(getConfig(), registrationBroadcasts),
  )
  const detection = registrationDetection(core.registrations, registrationReads)
  const entering = registrationIdentity({
    registrations: core.registrations,
    sipaDeposits,
    identity: core.identity,
    signedIn: () => {
      const { storageId, msk } = deps.device.get()
      return storageId === namespace.id && msk !== null
    },
    save: (identity) => saveIdentity(deps, identity),
  })
  const seeding = { ...registrationBroadcasts, auth: deps.auth, config: getConfig }
  const recovery = registrationRecovery(seeding)
  const refunds = registrationRefunds({ ...seeding, recovery })
  // A visitor's claim prices its link's split too.
  const pricing = registrationPricing(chainPricing(getConfig))
  const funding = fundingTransfers(chainFunding(getConfig), sipaDeposits)
  /** The user keeps the tag: the write that confirms it owes the address's broadcast. */
  const confirmTag = async (record: Pick<PendingRegistrationRecord, "sipaAddress">) => {
    await core.registrations.confirmTag(record.sipaAddress)
    wakeBroadcasts()
  }
  const entry = registrationEntry({
    ...pricing,
    registrations: core.registrations,
    sipaDeposits,
    withdrawals,
    registrationRecovery: recovery,
    linkFunds: (record) => claimPublishesAddress(record),
    confirmTag,
  })
  const broadcasts = sipaBroadcasts<ObsidionWallet>({
    ...broadcasting,
    executors: (wallet) => ({
      ...broadcasting.executors(wallet),
      registration: registrationExecutor(
        wallet,
        getConfig(),
        registrationBroadcasts,
        contractService,
      ),
    }),
    wallet,
    store: sipaDeposits,
    operations: deps.operations,
    txState: broadcastState,
    scope: namespace.id,
  })
  const { operations } = deps
  // They need the page's wallet: demo mode has none, so they never run.
  const tasks = [
    broadcasts.task,
    detection,
    entering,
    refunds,
    entry,
    ...(account
      ? [
          registrationRederive({ wallet }, seeding),
          registrationHeal({ wallet }, seeding),
          sponsoredRail({ wallet, account, contractService }, railPending),
        ]
      : []),
    ...(pipeline ? [pipeline.check, pipeline.scan, pipeline.claim] : []),
    ...(sipaAddresses ? [sipaAddresses.pool] : []),
    reorg({
      wallet,
      activity,
      withdrawals,
      tracker: core.withdrawalTracker,
      onOutcome: (outcome) =>
        void bestEffort("unknown", recordReorgOutcome(notifications, outcome)),
    }),
    operationsSettle({ wallet, operations }),
    interruptedSweep({
      wallet,
      db,
      activity,
      withdrawals,
      operations,
      activeSince: () => deps.activeSince,
    }),
    ...(work?.tasks ?? []),
  ]
  return {
    tasks,
    named: {
      transferScan: work?.scan.task ?? null,
      sipaBroadcasts: broadcasts.task,
      sipaCheck: pipeline?.check ?? null,
      sipaScan: pipeline?.scan ?? null,
      sipaClaim: pipeline?.claim ?? null,
      registrationDetection: detection,
      registrationIdentity: entering,
      registrationRefunds: refunds,
    },
    /** Called once the session's runtime runs these tasks. */
    started() {
      stops.push(onIdle(() => void wake(broadcasts.task)))
    },
    views: open,
    services: {
      signup: page.signup,
      pastUser: page.pastUser,
      onboardingMock: page.onboardingMock,
      demoDepositAddress: page.demoDepositAddress,
      /** This page sends the address's broadcast itself: the task leaves it until released. */
      holdBroadcast(address: string) {
        const release = broadcasts.hold(address)
        return () => {
          release()
          void wake(broadcasts.task)
        }
      },
      /**
       * Owing is a ledger write; the ledger proves it once the wallet is up. A ticket's claim on
       * this tab publishes the address itself, so it only keeps the fresh payload for that claim.
       */
      oweRegistrationBroadcast: (async (record, owed) => {
        if (!claimPublishesAddress(record))
          return oweRegistrationBroadcast(registrationBroadcasts, wakeBroadcasts, record, owed)
        if (owed?.payload) registrationPayloads.set(record.sipaAddress.toLowerCase(), owed.payload)
      }) satisfies NonNullable<OxideResumeDeps["oweBroadcast"]>,
      registrationPayloads,
      confirmTag,
      registrationRecovery: recovery,
      ...pricing,
      /** Who funded each registration address, read once a view demands it. */
      fundingTransfers: funding,
      /** Why the account cannot ride the sponsored rail yet; undefined until the first read. */
      railPending: railPending.readonly,
      /** The account's SIPA keys; null for a visitor. */
      sipaKeys,
      /** The PXE's SIPA discovery setup, built on first demand. */
      sipaDiscovery,
      /** The account's own deposit addresses; null for a visitor. */
      sipaAddresses,
      /** The SIPA pipeline's watch and last read, and its passes over a previous account. */
      sipaPipeline: pipeline,
      /** Sends `params` from the connected L1 wallet and stamps the transfer on its deposit. */
      fundDeposit(params: FundDepositParams) {
        const config = getConfig()
        return fundDeposit(params, {
          fundingStamps,
          wakeBroadcasts,
          tuple: () => getOxideTuple(config),
          publicClient: l1PublicClient(config),
          tokenMetadata: (token) => tokenMetadata(config, token),
          displayFacts: loadDepositDisplayFacts,
          balance: readL1DepositTokenBalance,
          l1Clients: getL1Clients,
          desktop: { active: isDesktopL1SubmitActive, submit: submitViaDesktopBridge },
        })
      },
      /** Null for a visitor; its value is null without a sUSDS deployment. */
      savings: work?.savings ?? null,
    },
    close() {
      for (const stop of stops) stop()
      work?.scan.dispose()
      work?.savings.close()
      sipaKeys?.close()
      registrationReads.close()
      pricing.sweepFee.close()
      pricing.registrationSchedule.close()
      funding.close()
      sipaDiscovery.close()
      resolverDeployments?.close()
    },
  }
}

declare module "../session/session" {
  interface SessionParts {
    features: ReturnType<typeof sessionTasks>
  }
}
