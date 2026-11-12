/**
 * A session's feature tasks, services and views, built over its core. `openSession` takes them from
 * here through its deps, so `session/` imports no feature.
 */
import {
  BroadcastDeferred,
  TransferEventScanner,
  WalletSyncCoordinator,
  balanceScope,
  bestEffort,
  bridgeInRebuild,
  bridgeInTracker,
  createCatchUp,
  createRequests,
  createTagForwardResolver,
  claimReversalReports,
  derived,
  ensContactNames,
  liveStore,
  memoryStore,
  notificationStamps,
  oldVersionWithdrawalTask,
  payerApprovals,
  previousAccountFind,
  previousAccountHistory,
  previousAccountScan,
  provingBusy,
  rebuildPaylinks,
  keyedService,
  sameHolding,
  sponsoredAllowance,
  sameSettleDue,
  selectSavingsHolding,
  selectSettleDue,
  reorg,
  savingsLookup,
  sipaBroadcasts,
  transferScan,
  type BalanceStore,
  type Contacts,
  type Loaded,
  type NotificationSources,
  type OldVersionWithdrawal,
  type OxideResumeDeps,
  type PendingRegistrationRecord,
  type Prover,
  type ReadonlyStore,
  type SipaBroadcastsDeps,
  type SipaProcessingState,
  type Service,
  type SponsoredAllowance,
  type UpgradePricing,
  valueOf,
} from "@obsidion/front-core"
import {
  PaylinkService,
  createTransferEventSource,
  createWalletSyncSource,
  encodePaylinkInline,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"
import { selectAccountHistory, type AccountHistory } from "../features/backupPasskey/accountHistory"
import { backupAddReleases } from "../features/backupPasskey/backupAddTime"
import { accountKeys, readKeysOnDone } from "../features/backupPasskey/accountKeys"
import { webAccountRecordState } from "../features/migration/createWebMetadataMigration"
import { metadataRecordStates, oldVersionsByRecord } from "../features/migration/metadataRecord"
import { savedRotations } from "../features/backupPasskey/backupRotations"
import { getPreviousAccountWatcher } from "../features/backupPasskey/previousAccountWatcher"
import { l1PublicClient } from "../config/oxideTuple"
import { rotationView } from "../features/backupPasskey/backupRotations"
import { broadcastState } from "../features/broadcasts/broadcastState"
import {
  oweRegistrationBroadcast,
  registrationExecutor,
  type RegistrationPayloads,
} from "../features/broadcasts/registrationExecutor"
import { rotationExecutor } from "../features/broadcasts/rotationBroadcastExecutor"
import { slotExecutor } from "../features/broadcasts/slotExecutor"
import { resolveTagForCommit } from "../features/contacts/registryResolution"
import { fpcRefuels } from "../features/fees/fpcRefuel"
import { movedAccountCatchUp } from "./movedAccountCatchUp"
import { fundDeposit, type FundDepositParams } from "../features/deposit/fundDeposit"
import { bridgeFills, listedBridgeSymbol } from "../features/deposit/bridgeChains"
import { readL1DepositTokenBalance } from "../features/deposit/l1DepositTokenBalance"
import { createSipaAddresses } from "../features/deposit/sipaAddresses"
import { resolverDeployments, openSipaDiscovery, openSipaKeys } from "../features/deposit/sipaRail"
import { sipaPipeline } from "../features/deposit/sipaTasks"
import { historicImports } from "../features/migration/historicActivityImport"
import {
  bell,
  bellRows,
  notificationSources,
  recordReorgOutcome,
} from "../features/notifications/notifications"
import {
  interruptedSweep,
  operationsSettle,
  provingMarks,
} from "../features/operations/operationsTasks"
import { NO_SWEEP, chainPass, paylinkSweep } from "../features/paylink/paylinkTasks"
import { claimPublishesAddress } from "../features/paylink/ticketContinuation"
import { ticketClaim } from "../features/paylink/ticketClaim"
import { chainFunding, fundingTransfers } from "../features/registration/registrationFunding"
import { fasterOffers } from "../features/withdraw/fasterOffers"
import { loadFasterWithdrawal } from "../features/withdraw/useFasterWithdrawal"
import {
  chainPricing,
  registrationPricing,
  type RegistrationPricing,
} from "../features/registration/registrationPricing"
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
import type { RailQuery } from "../features/registration/sponsoredRailReadiness"
import { buildWebDetectionDeps } from "../features/registration/webRegistration"
import { openSavings, savingsRescanToken } from "../features/savings/savingsGateway"
import {
  NO_HOLDING,
  NO_PRICE,
  NO_REPLAY,
  NO_SETTLE_DUE,
  openSavingsSource,
  priceOf,
  readChainSavingsPrice,
  savingsMovesReplay,
  savingsPrices,
  savingsSettle,
  type SavingsPriceQuery,
} from "../features/savings/savingsTasks"
import { upgradePricing } from "../features/migration/upgradeRunAccount"
import { readSponsoredAllowance, sponsorDeps } from "../features/allowance/readAllowance"
import { readAllowanceUsage } from "../features/allowance/readAllowanceUsage"
import { loadDepositDisplayFacts, tokenMetadata } from "../features/sipa/loadDepositFacts"
import { settleOldVersionWithdrawal } from "../features/withdraw/oldVersionWithdrawals"
import {
  rescanWithdrawals,
  withdrawalRescan,
  type RescanDeps,
} from "../features/withdraw/withdrawGateway"
import { isDesktopL1SubmitActive, submitViaDesktopBridge } from "../platform/desktopBridge"
import { createContactsByL2 } from "../platform/xmtp/adapters"
import { saveIdentity } from "../session/account"
import { profileBridge } from "../session/walletChains"
import { getL1Clients } from "../session/l1Wallet"
import { contractAddresses } from "../session/contractAddresses"
import type { Page } from "./sessionDeps"
import type { SessionDeps, SignInDeps } from "../session/session"
import {
  activityReads,
  contactActivity,
  feedBase,
  feedSources,
  mergedRows,
} from "../ui/activity/feedSources"
import { withdrawReports } from "./withdrawReports"

const NOTHING_WAITS: ReadonlyStore<ReadonlyMap<string, SipaProcessingState>> = memoryStore(
  new Map(),
).readonly
/** A visitor has no account to ride the rail. */
const UNREAD_RAIL: RailQuery = memoryStore({ status: "pending" } as const).readonly
const NO_OLD_VERSION_WITHDRAWALS: ReadonlyStore<Loaded<OldVersionWithdrawal>> = memoryStore({
  records: [],
  hydrated: true,
}).readonly

/** The stores and services `openSession` builds the features over. */
type Core = Parameters<SessionDeps["features"]>[0]

const NO_HISTORY: ReadonlyStore<AccountHistory> = memoryStore<AccountHistory>({
  kind: "none",
}).readonly

/** Settings → Account history: a visitor has no event. */
function accountHistory(session: Core): ReadonlyStore<AccountHistory> {
  if (!session.backupRotations) return NO_HISTORY
  return derived(
    [
      getPreviousAccountWatcher().state,
      session.savedPreviousAccount.address,
      session.backupRotations.view,
    ] as const,
    (state, saved, rotations) => selectAccountHistory(state, saved, savedRotations(rotations)),
  )
}

/** What the feed, the bell and the contact lists read, and the watchers that write from them. */
function views(session: Core, pricing: ReadonlyStore<UpgradePricing>) {
  const { db, transfers, paylinks, withdrawals, sipaDeposits, notifications, milestones } = session
  const processing = session.sipaProcessingObserver()?.states ?? NOTHING_WAITS
  const reads = activityReads(transfers, paylinks, session.operations)
  const requests = createRequests({
    db,
    // A request this device paid is paid by its send's operation.
    payments: derived(
      [mergedRows([reads.paying, reads.transfers]), sipaDeposits.view] as const,
      (rows, sipa) => ({
        rows: rows.records,
        deposits: sipa.records,
        loaded: rows.loaded && sipa.loaded,
        failed: rows.failed || sipa.failed,
      }),
    ),
    legacy: session.deps.database,
  })
  const base = feedBase(
    requests,
    withdrawals,
    sipaDeposits,
    session.bridgeIns,
    processing,
    paylinks,
    session.operations,
    session.savingsMoves,
    {
      upgrades: session.rollup.upgrades,
      // A visitor's read would load the page-wide store under no account.
      oldVersionWithdrawals: session.deps.signIn
        ? session.rollup.oldVersionWithdrawals()
        : NO_OLD_VERSION_WITHDRAWALS,
    },
    rotationView(session),
    session.page.wallClock,
  )
  const rows = bellRows(transfers, paylinks, notifications, reads.open)
  const sources = notificationSources(
    base,
    rows,
    session.identity,
    milestones,
    session.registrations.view,
    session.operations,
    session.savedPreviousAccount.address,
  )
  // Home: the window, with every pending row and request payment.
  const homeRows = mergedRows([transfers.view, reads.pending, reads.paying, reads.transfers])
  let history: ReadonlyStore<AccountHistory> | undefined
  return {
    requests,
    reads,
    base,
    homeRows,
    feed: feedSources(base, homeRows),
    contactActivity: contactActivity(transfers, reads, requests, withdrawals, sipaDeposits),
    bell: bell(sources, pricing, notifications, session.page.wallClock),
    sources,
    /** Only Settings reads it, so it is built on first read. */
    get accountHistory() {
      return (history ??= accountHistory(session))
    },
  }
}

/**
 * Every SIPA broadcast this wallet owes is proven one at a time, after the user's own transaction:
 * local proving is single-flight, so an attempt never starts under another proof.
 */
const broadcastGate = (
  proving: Prover,
): Required<Pick<SipaBroadcastsDeps<ObsidionWallet>, "runExclusive" | "busy" | "describe">> => ({
  // Checked in the same synchronous block that registers the proof, so a user flow raised during
  // the attempt's reads makes it wait instead of colliding with it.
  runExclusive: async (attempt) => {
    if (provingBusy(proving.state.get())) throw new BroadcastDeferred(Date.now())
    let result!: Awaited<ReturnType<typeof attempt>>
    await proving.runBackground(async () => {
      result = await attempt()
    })
    return result
  },
  busy: () => provingBusy(proving.state.get()),
  describe: (job) =>
    job.kind === "pool"
      ? undefined
      : {
          flow: "deposit",
          summary: job.source.type === "rotation" ? "Backup passkey" : "Deposit address",
          background: true,
        },
})

/** Builds the session's feature tasks, services and views over its core, `session`. */
export function sessionTasks(session: Core) {
  const { deps, db, transfers, withdrawals, sipaDeposits, notifications, milestones } = session
  const { namespace, wallet, contractService, signIn } = deps
  const { account, token, wake, contacts, balanceStore, page } = session
  const stops: Array<() => void> = []
  const registrationPayloads: RegistrationPayloads = new Map()
  /** This page sends the address's broadcast itself: the task leaves it until released. */
  const holdBroadcast = (address: string): (() => void) => {
    const release = broadcasts.hold(address)
    return () => {
      release()
      void wake(broadcasts.task)
    }
  }
  const opened = memoryStore<ReturnType<typeof views> | undefined>(undefined)
  // The vault's share price: what Savings' figures and the bell's upgrade runs are valued at.
  const price = signIn
    ? savingsPrices(page.query, milestones, (signal) => readChainSavingsPrice(page, signal))
    : null
  const runPricing = upgradePricing(page, price ?? NO_PRICE)
  const open = () => {
    const built = opened.get() ?? views(session, runPricing)
    opened.set(built)
    return built
  }
  const signedIn = signIn ? open() : undefined
  const metadataRecordState =
    account &&
    metadataRecordStates(page.query, account, (own) =>
      webAccountRecordState({ auth: deps.auth, page }, own),
    )

  /** The views' notification sources: undefined until the views open, a visitor's on first read. */
  const sources = liveStore<NotificationSources | undefined>(undefined, {
    whileSubscribed: (set) => {
      let off: (() => void) | undefined
      const follow = () => {
        const built = opened.get()
        if (!built || off) return
        const put = () => set(built.sources.get())
        off = built.sources.subscribe(put)
        put()
      }
      const offOpened = opened.subscribe(follow)
      follow()
      return () => {
        offOpened()
        off?.()
      }
    },
  })
  /** They write from the session's own stores, so they run with no wallet. */
  const writers = [
    provingMarks(page.prover.progress, session.operations),
    withdrawReports({ withdrawals, funnel: session.withdrawFunnel, claims: session.owedClaims }),
    notificationStamps(sources, page.wallClock, notifications, page.now),
    claimReversalReports(sources, notifications, page.now),
    ...(signedIn && contacts
      ? [
          // The payer of each paid request becomes a full contact.
          payerApprovals({
            requests: signedIn.requests,
            rows: derived([signedIn.reads.paying], (rows) => rows.records),
            approve: (address) => contacts.approveAutoAdded(address),
          }),
          ensContactNames(contacts, page.chain.ensName),
        ]
      : []),
  ]
  /** An account's chain sync, its Savings and the background work over them. */
  const accountWork = (
    signIn: SignInDeps,
    account: Service<ObsidionAccount>,
    token: Service<TokenService>,
    contacts: Contacts,
    balanceStore: BalanceStore,
    price: SavingsPriceQuery,
  ) => {
    const claim = ticketClaim(
      { wallet, account, tokenService: token, teeSigner: session.teeSigner, contractService },
      {
        ...session,
        auth: deps.auth,
        database: deps.database,
        device: deps.device,
        namespace,
        claims: page.claims,
        signup: page.signup,
        registrationPayloads,
        holdBroadcast,
      },
    )
    const scan = transferScan({
      now: deps.page.now,
      wallet,
      account,
      token,
      contractService,
      tag: () => session.identity.get().value?.handle,
      endpointScope: () => deps.page.config.nodeEndpointDigest,
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
          transactionStore: transfers,
          operations: session.operations,
          // A fresh manifest: the contact cache never vouches for a sender.
          tags: createTagForwardResolver((tag) => resolveTagForCommit(deps.page, tag)),
          contacts: createContactsByL2(contacts),
          token: token.metadata,
          balance: {
            store: balanceStore,
            scope: balanceScope(deps.page.config.network, account.getCompleteAddress().toString()),
            tokenAddress: token.metadata.address,
          },
          // A pending row settles wherever it sits, even past the newest rows.
          transactions: mergedRows([transfers.view, open().reads.pending, open().reads.transfers]),
          withdrawals: withdrawals.list,
          milestones,
        }),
    })
    const savings = openSavingsSource([wallet, account, token, contractService], () =>
      openSavings({
        network: deps.page.config.network,
        refreshBalance: () => scan.refreshBalance(),
        price,
        session,
      }),
    )
    const settleDue = derived(
      [session.savingsMoves.view, withdrawals.list],
      (moves, burns) => selectSettleDue(moves.records, burns),
      sameSettleDue,
    )
    const settle = savingsSettle(savings, settleDue)
    const holding = derived(
      [savings, balanceStore.view, price],
      (source, balances, read) =>
        selectSavingsHolding(
          source.status === "ready" ? source.value : null,
          balances,
          priceOf(read),
        ),
      sameHolding,
    )
    const paylinks = paylinkSweep(
      { wallet, account, token, contractService },
      chainPass({
        transfers,
        paylinks: session.paylinks,
        operations: session.operations,
        db,
        secretKey: () => deps.auth.getSecretKey(),
        endpointScope: () => deps.page.config.nodeEndpointDigest,
      }),
      wake,
    )
    const rescanDeps: RescanDeps = {
      store: withdrawals,
      deployment: () => session.page.chain.oxideTuple.read(),
      l1Symbol: (token) => tokenMetadata(session.page, token).then((m) => m.symbol),
      wake: () => void wake(session.withdrawalTracker),
      readExecutor: session.page.chain.withdrawalExecutorAt,
      chain: session.page.chain,
      chainName: (chainId) =>
        profileBridge(session.page.config)?.chains.find((c) => c.chainId === chainId)?.name,
    }
    const rescan = rescanWithdrawals(rescanDeps)
    // Sky burns stay out: the Savings settle would try to claim their deposits for the session's
    // account, but they were paid to the previous one.
    const previousRescan = rescanWithdrawals({
      ...rescanDeps,
      keep: (burn) => !burn.sky,
      strict: true,
    })
    const replay = savingsMovesReplay(
      { wallet, account, token, savings },
      milestones,
      { rescan, savingsToken: savingsRescanToken(session.page) },
      settle,
    )
    const tasks = [
      scan.task,
      withdrawalRescan({ wallet, account, token }, rescan),
      savingsLookup({ wallet, account, scan, lookup: savingsRescanToken(session.page) }),
      settle,
      replay.task,
      oldVersionWithdrawalTask({
        wallet,
        records: session.rollup.oldVersionWithdrawals(),
        settle: (id, wallet) =>
          settleOldVersionWithdrawal(session.page.config, session.savingsMoves, id, (hash) =>
            broadcastState(wallet, hash),
          ),
      }),
      ...historicImports(
        wallet,
        { storageId: signIn.storageId, contacts },
        { ...session, namespace, device: deps.device, sessionLock: deps.sessionLock },
      ),
      paylinks.task,
      claim,
      movedAccountCatchUp({
        session: {
          ...session,
          auth: deps.auth,
          device: deps.device,
          database: deps.database,
          sessionLock: deps.sessionLock,
          namespace,
          page,
        },
        wallet,
        account,
        contractService,
      }),
      ...(metadataRecordState
        ? [oldVersionsByRecord({ account, record: metadataRecordState, milestones })]
        : []),
    ]
    const previous = signIn.previousAccount
    if (previous) {
      tasks.push(
        previousAccountFind({ wallet, account, find: (ready) => previous.locate(ready) }),
        previousAccountHistory({ wallet, account, read: (ready) => previous.readHistory(ready) }),
        previousAccountScan({
          now: deps.page.now,
          wallet,
          account,
          token,
          contractService,
          previousAccount: (ready) => previous.registeredAddress(ready),
          tag: () => session.identity.get().value?.handle,
          endpointScope: () => deps.page.config.nodeEndpointDigest,
          scanner: ({ wallet, token, contractService }, address) =>
            new TransferEventScanner({
              source: createTransferEventSource({
                wallet,
                tokenAddress: token.metadata.address,
                accountAddress: address,
                contractService,
              }),
              db,
              transactionStore: transfers,
              tags: createTagForwardResolver((tag) => resolveTagForCommit(deps.page, tag)),
              contacts: createContactsByL2(contacts),
              token: token.metadata,
              // Its rows land live: the account's own scan holds the activity skeleton.
              catchUp: createCatchUp(),
            }),
          links: async ({ wallet, account, token, contractService }, address, signal) => {
            const masterSecret = await deps.auth.getSecretKey()
            if (!masterSecret) return false
            const { complete } = await rebuildPaylinks({
              source: createTransferEventSource({
                wallet,
                tokenAddress: token.metadata.address,
                accountAddress: address,
                contractService,
              }),
              accountAddress: address,
              masterSecret,
              networkId: wallet.networkId,
              endpointScope: deps.page.config.nodeEndpointDigest,
              signal,
              paylinkService: new PaylinkService(wallet, account, token, contractService),
              linkFor: (params) => `${location.origin}/link#${encodePaylinkInline(params)}`,
              store: transfers,
              links: session.paylinks,
              db,
              token: token.metadata,
            })
            return complete
          },
          burns: ({ wallet, token }, address) =>
            previousRescan(wallet, address, [{ tokenService: token }]),
        }),
      )
    }
    return { scan, savings, settle, settleDue, replay, holding, paylinks, claim, tasks }
  }
  const work =
    signIn && account && token && contacts && balanceStore && price
      ? accountWork(signIn, account, token, contacts, balanceStore, price)
      : null
  const sipaKeys = account
    ? openSipaKeys(deps.page, wallet, account, () => deps.auth.getSecretKey())
    : null
  const sipaDiscovery = openSipaDiscovery(deps.page, wallet, session.contractService)
  // The account's sponsored allowance, read over its services once they are up.
  const sponsorOn =
    account &&
    ((signal?: AbortSignal): Promise<Parameters<typeof readAllowanceUsage>[0]> =>
      sponsorDeps({ ...session, sipaDiscovery }, signal))
  const allowance: SponsoredAllowance | null =
    sponsorOn &&
    sponsoredAllowance(
      page.query,
      async (signal) => readSponsoredAllowance(await sponsorOn(signal)),
      async (read, signal) => readAllowanceUsage(await sponsorOn(signal), read),
    )
  const deployments = resolverDeployments(page.query, deps.page)
  const wakeBroadcasts = () => void wake(broadcasts.task)
  const refuels = fpcRefuels({
    owed: session.owedRefuels,
    refuel: page.fpcRefuel,
    prover: page.prover,
  })
  const pipeline =
    work && account && token && contacts && sipaKeys
      ? sipaPipeline({
          store: sipaDeposits,
          registrations: session.registrations,
          db,
          wallet,
          keys: sipaKeys,
          discovery: sipaDiscovery,
          deployments,
          account,
          token,
          milestones,
          visible: deps.visible,
          catchUp: deps.catchUp,
          custody: deps.custody(session.registrations.view, sipaDeposits.view, withdrawals.list),
          contacts,
          upgrades: session.rollup.upgrades,
          refreshBalance: () => work.scan.refreshBalance(),
          wakeBroadcasts,
          page: deps.page,
        })
      : null
  const previous = signIn?.previousAccount
  if (previous) {
    stops.push(
      previous.serve({
        session,
        saved: session.savedPreviousAccount,
        pipeline,
        savings: work?.savings ?? null,
      }),
    )
  }
  const railPending: RailQuery = account
    ? sponsoredRail({ wallet, account, contractService }, session)
    : UNREAD_RAIL
  const sipaAddresses =
    sipaKeys &&
    createSipaAddresses({
      page: deps.page,
      store: sipaDeposits,
      wallet,
      keys: sipaKeys,
      discovery: sipaDiscovery,
      identity: session.identity,
      railPending,
      wakeBroadcasts,
      wake,
    })
  const registrationBroadcasts = {
    registrationPayloads,
    sipaDeposits,
    nameClaims: session.nameClaims,
    registrations: session.registrations,
    accountRecord: session.accountRecord,
    namespace,
    database: deps.database,
    device: deps.device,
    identity: session.identity,
    auth: session.auth,
    signup: page.signup,
    page,
    subscriptionChecks: session.subscriptionChecks,
    oweFpcRefuel: session.oweFpcRefuel,
  }
  const registrationReads = keyedService("registrationReads", { retry: "manual" }, () =>
    buildWebDetectionDeps(session.page.config, registrationBroadcasts),
  )
  const detection = registrationDetection(
    session.registrations,
    registrationReads,
    session.page.now,
  )
  const entering = registrationIdentity({
    registrations: session.registrations,
    sipaDeposits,
    identity: session.identity,
    signedIn: () => {
      const { storageId, msk } = deps.device.get()
      return storageId === namespace.id && msk !== null
    },
    save: (identity) => saveIdentity(deps.page, identity),
  })
  const recovery = registrationRecovery(registrationBroadcasts)
  const refunds = registrationRefunds({ ...registrationBroadcasts, recovery })
  // A visitor's claim prices its link's split too.
  const pricing = registrationPricing(
    page.query,
    chainPricing(() => session.page),
  )
  const funding = fundingTransfers(
    page.query,
    chainFunding(() => session.page),
    sipaDeposits,
  )
  /** The user keeps the tag: the write that confirms it owes the address's broadcast. */
  const confirmTag = async (record: Pick<PendingRegistrationRecord, "sipaAddress">) => {
    await session.registrations.confirmTag(record.sipaAddress)
    wakeBroadcasts()
  }
  const entry = registrationEntry({
    ...pricing,
    registrations: session.registrations,
    sipaDeposits,
    withdrawals,
    registrationRecovery: recovery,
    linkFunds: (record) => claimPublishesAddress(record),
    confirmTag,
  })
  const gate = broadcastGate(page.prover)
  const broadcasts = sipaBroadcasts<ObsidionWallet>({
    ...gate,
    executors: (wallet) => ({
      rotation: rotationExecutor(wallet, session),
      slot: slotExecutor(wallet, { ...session, sipaKeys, sipaDiscovery }),
      registration: registrationExecutor(
        wallet,
        session.page.config,
        registrationBroadcasts,
        contractService,
      ),
    }),
    wallet,
    db,
    store: sipaDeposits,
    operations: session.operations,
    txState: broadcastState,
    now: session.page.now,
  })
  const { operations } = session
  const { config } = session.page
  const { originChain: origin } = session.page.chain
  const bridgeProvider = valueOf(session.page.bridgeInProvider) ?? undefined
  const acrossDeposits = valueOf(session.page.bridgeInDeposits) ?? undefined
  const bridgeIns = {
    tracker: bridgeInTracker({
      store: session.bridgeIns,
      provider: () => bridgeProvider,
      origin,
      now: session.page.now,
    }),
    rebuild: bridgeInRebuild({
      deposits: sipaDeposits,
      bridgeIns: session.bridgeIns,
      fills: bridgeFills(config),
      provider: () => acrossDeposits,
      origin,
      listedSymbol: (chainId, token) => listedBridgeSymbol(config, chainId, token),
      landingDecimals: async (token) => (await tokenMetadata(session.page, token)).decimals,
    }),
  }
  const tasks = [
    bridgeIns.tracker,
    bridgeIns.rebuild,
    // They need the page's wallet: demo mode has none, so they never run.
    broadcasts.task,
    refuels,
    detection,
    entering,
    refunds,
    entry,
    ...(account
      ? [
          registrationRederive({ wallet }, registrationBroadcasts),
          registrationHeal({ wallet }, registrationBroadcasts),
        ]
      : []),
    ...(pipeline ? [pipeline.check, pipeline.scan, pipeline.claim] : []),
    ...(sipaAddresses ? [sipaAddresses.pool] : []),
    reorg({
      wallet,
      transfers,
      withdrawals,
      operations,
      tracker: session.withdrawalTracker,
      onOutcome: (outcome) =>
        void bestEffort("unknown", recordReorgOutcome(notifications, outcome)),
    }),
    operationsSettle({ wallet, operations }),
    interruptedSweep({
      wallet,
      withdrawals,
      operations,
      activeSince: () => deps.page.activeSince.get(),
    }),
    ...(work?.tasks ?? []),
  ]
  const fasterOffer = fasterOffers(
    page.query,
    page.loaders.fasterOffer ??
      ((signal) => loadFasterWithdrawal(session.burnDurations, session.page, signal)),
    page.now,
  )
  const backupAddRelease = backupAddReleases(page.query, session.burnDurations, () => session.page)
  const keys = accountKeys(page.query, {
    page: deps.page,
    auth: deps.auth,
    device: deps.device,
    wallet,
    contractService,
  })
  stops.push(readKeysOnDone(keys, rotationView(session), session.identity))
  return {
    tasks: [...tasks, ...writers],
    named: {
      bridgeInTracker: bridgeIns.tracker,
      bridgeInRebuild: bridgeIns.rebuild,
      transferScan: work?.scan.task ?? null,
      sipaBroadcasts: broadcasts.task,
      sipaCheck: pipeline?.check ?? null,
      sipaScan: pipeline?.scan ?? null,
      sipaClaim: pipeline?.claim ?? null,
      registrationDetection: detection,
      registrationIdentity: entering,
      registrationRefunds: refunds,
      savingsSettle: work?.settle ?? null,
    },
    /** Called once the session's runtime runs these tasks. */
    started() {
      stops.push(page.prover.state.subscribe(() => gate.busy() || void wake(broadcasts.task)))
      // The ticket claim waits on this page's own state as well as the chain's: the signup's burn records, and the
      // user's flows and the background proofs it yields to. It runs as soon as any changes, not on its next pass.
      const claim = work?.claim
      if (claim) {
        const wakeClaim = () => void wake(claim)
        stops.push(
          page.prover.state.subscribe(wakeClaim),
          withdrawals.list.subscribe(wakeClaim),
          page.claims.state.subscribe(wakeClaim),
        )
      }
    },
    views: open,
    services: {
      signup: page.signup,
      pastUser: page.pastUser,
      claims: page.claims,
      onboardingMock: page.onboardingMock,
      demoDepositAddress: page.demoDepositAddress,
      holdBroadcast,
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
      /** Who funded each registration address, read while a view subscribes. */
      fundingTransfers: funding,
      /** Why the account cannot ride the sponsored rail yet; undefined until the first read. */
      railPending,
      /** The contracts the settings list, read while a view subscribes. */
      contractAddresses: contractAddresses(page.query, { contractService, wallet }),
      /** The passkeys installed on the account, read while the Passkeys sheet shows. */
      accountKeys: keys,
      /** How the account's L1 metadata record names it; null for a visitor. */
      metadataRecordState,
      /** The account's SIPA keys; null for a visitor. */
      sipaKeys,
      /** The PXE's SIPA discovery setup, built once something asks for it. */
      sipaDiscovery,
      /** The account's own deposit addresses; null for a visitor. */
      sipaAddresses,
      /** The SIPA pipeline's watch and last read, and its passes over a previous account. */
      sipaPipeline: pipeline,
      /** Sends `params` from the connected L1 wallet and stamps the transfer on its deposit. */
      fundDeposit(params: FundDepositParams) {
        const { config } = session.page
        return fundDeposit(params, {
          deposits: sipaDeposits,
          wakeBroadcasts,
          tuple: () => session.page.chain.oxideTuple.read(),
          config,
          publicClient: l1PublicClient(config),
          pace: page.pace,
          tokenMetadata: (token) => tokenMetadata(session.page, token),
          displayFacts: (token) => loadDepositDisplayFacts(session.page, token),
          balance: (account, token) => readL1DepositTokenBalance(account, token, session.page),
          l1Clients: (chainId, from) => getL1Clients(page.wagmi, chainId, from),
          desktop: { active: isDesktopL1SubmitActive, submit: submitViaDesktopBridge },
        })
      },
      /** The faster withdrawal's tip. */
      fasterOffer,
      /** When a backup add's funding is released, by its landing. */
      backupAddRelease,
      /** Null for a visitor; its value is null without a sUSDS deployment. */
      savings: work?.savings ?? null,
      /** The Savings shares at the vault's price; a visitor holds none. */
      savingsHolding: work?.holding ?? NO_HOLDING,
      /** What values an upgrade run: the tokens it credits and the Savings share price. */
      upgradePricing: runPricing,
      /** The account's sponsored-transaction allowance; null for a visitor. */
      sponsoredAllowance: allowance,
      /** Whether this session rebuilt its Savings burns; a visitor's never does. */
      savingsReplayed: work?.replay.replayed ?? NO_REPLAY,
      /** What the settle pass has left; nothing for a visitor. */
      savingsSettleDue: work?.settleDue ?? NO_SETTLE_DUE,
      /** The sent links' rescan and claim sweep. */
      paylinkSweep: work?.paylinks ?? NO_SWEEP,
    },
    close() {
      for (const stop of stops) stop()
      work?.scan.dispose()
      work?.savings.close()
      sipaKeys?.close()
      registrationReads.close()
      sipaDiscovery.close()
    },
  }
}

type Services = ReturnType<typeof sessionTasks>["services"]

declare module "../session/session" {
  interface SessionParts {
    features: ReturnType<typeof sessionTasks>
    page: Page
  }
  /** Each by name: a `Pick` of the session resolves without building these services' types. */
  interface Session extends RegistrationPricing {
    signup: Services["signup"]
    pastUser: Services["pastUser"]
    claims: Services["claims"]
    onboardingMock: Services["onboardingMock"]
    demoDepositAddress: Services["demoDepositAddress"]
    holdBroadcast: Services["holdBroadcast"]
    oweRegistrationBroadcast: Services["oweRegistrationBroadcast"]
    registrationPayloads: Services["registrationPayloads"]
    confirmTag: Services["confirmTag"]
    registrationRecovery: Services["registrationRecovery"]
    fundingTransfers: Services["fundingTransfers"]
    railPending: Services["railPending"]
    contractAddresses: Services["contractAddresses"]
    accountKeys: Services["accountKeys"]
    metadataRecordState: Services["metadataRecordState"]
    sipaKeys: Services["sipaKeys"]
    sipaDiscovery: Services["sipaDiscovery"]
    sipaAddresses: Services["sipaAddresses"]
    sipaPipeline: Services["sipaPipeline"]
    fundDeposit: Services["fundDeposit"]
    fasterOffer: Services["fasterOffer"]
    backupAddRelease: Services["backupAddRelease"]
    savings: Services["savings"]
    savingsHolding: Services["savingsHolding"]
    savingsReplayed: Services["savingsReplayed"]
    savingsSettleDue: Services["savingsSettleDue"]
    upgradePricing: Services["upgradePricing"]
    sponsoredAllowance: Services["sponsoredAllowance"]
    paylinkSweep: Services["paylinkSweep"]
  }
}
