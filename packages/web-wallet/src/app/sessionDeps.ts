/** The page's one composition root for sessions: the only place they read config and singletons. */
import {
  contractServiceFactory,
  manifestGate,
  openContractService,
  createOxideTeeSignerSource,
  createProver,
  createTurn,
  ensAddresses,
  openDatabase,
  passThroughScreener,
  PredicateScreeningService,
  queries,
  screenings,
  syncCatchUp,
  type BridgeInProvider,
  type Database,
  type Prover,
  type Turn,
  createClock,
  memoryStore,
  type ReadonlyStore,
  type Store,
  type PortalCapacityRegistry,
  type QueryEntry,
  type QueryFactory,
  type Screenings,
  type Service,
  type TeeSignerSource,
  type WithdrawalSpeedupEstimator,
  valueOf,
} from "@obsidion/front-core"
import type { Pace } from "@obsidion/core/cadence"
import {
  createNode,
  TokenService,
  type ContractService,
  type FpcRefuelService,
  type ObsidionWallet,
} from "@obsidion/sdk"
import type { Config } from "wagmi"
import type { Address } from "viem"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { SipaIntentName } from "@obsidion/core/oxide"
import type { PhoneReach, UserAgentInfo } from "@obsidion/passkey-web"
import type { WebBootConfig, WebWalletConfig } from "../config/env"
import { backupPasskeySettingsEnabled } from "../config/features"
import { fleetUrl } from "../config/oxideTuple"
import { BrowserContractServiceStorage } from "../platform/contracts/BrowserContractServiceStorage"
import { getPreviousAccountWatcher } from "../features/backupPasskey/previousAccountWatcher"
import { pageBackupReminder, type BackupReminder } from "../features/backupPasskey/backupReminder"
import { sipaProcessingObserver } from "../features/deposit/sipaProcessingObserver"
import { registrationCustody } from "../features/registration/openRegistration"
import { createPastUser, type PastUser } from "../features/registration/pastUser"
import { createClaims, type Claims } from "../features/paylink/claims"
import { verifyTag } from "../features/contacts/registryResolution"
import { createSignupStash, type SignupStash } from "../features/registration/signupStash"
import type { OnboardingMock } from "../features/onboarding/OnboardingScreen/signupFlow"
import type { ShownAddress } from "../features/sipa/depositTarget"
import { registrationFunnel } from "../features/registration/registrationFunnel"
import { fireOnboardingEvent } from "../lib/analytics"
import { reportBackupRotationUnreadable } from "../lib/backupPasskeyTelemetry"
import { bindPasskeyEnvironment } from "../lib/passkeyTelemetry"
import { landingRate, type LandingRate } from "../features/savings/landingRate"
import { createWalletPrompt, type WalletPrompt } from "../session/walletPrompt"
import { pageSponsors, type PageSponsors } from "../features/registration/sponsorAccounts"
import { createPreBoot, type PreBoot } from "../session/preBoot"
import { createPreparedTicket, type PreparedTicket } from "../features/onboarding/goldenTicket"
import { pageTicketOffer, type PageTicketOffer } from "../features/paylink/ticketOffer"
import {
  rollupMigrationStores,
  type RollupMigrationStores,
} from "../features/migration/rollupMigrationStores"
import { createAuthService, walletAuth } from "../platform/auth/useAuthenticator"
import type { WebAlphaAuthService } from "../platform/auth/WebAlphaAuthService"
import {
  accountsOfSession,
  followSavedSession,
  switchSession,
  type PageSessionDeps,
  type PageSessions,
  type SessionDeps,
} from "../session/session"
import { sessionTasks } from "./sessionTasks"
import { sessionLock, type SessionLock } from "../platform/storage/activeStorage"
import { deviceState, type Device } from "../platform/storage/deviceKeys"
import { tabStash } from "../platform/storage/tabStash"
import { pageTheme, type PageTheme } from "../platform/storage/theme"
import { bindTestDatabase, opfsBackend } from "../platform/storage/walletStorage"
import { pagePace } from "../platform/pagePace"
import { createPageWallet, type PageWallet } from "../platform/wallet"
import type { ActiveTabHold } from "../ActiveTabGate/ActiveTabGate"
import { capacityRegistry } from "../features/deposit/capacityRegistry"
import { pageTokenServices, type TokenServices } from "../features/token/tokenServices"
import { chainClock, type ChainClock } from "../features/paylink/chainClock"
import { networkReadiness, type NetworkReady } from "../features/cutover/networkReadiness"
import { highFees, type HighFees } from "../features/fees/highFees"
import { l1Balances, type L1Balances } from "../features/deposit/l1Balances"
import { readL1DepositTokenBalance } from "../features/deposit/l1DepositTokenBalance"
import { pageSpeedupEstimator } from "../features/withdraw/useFasterWithdrawal"
import { savingsMoveTimings, type SavingsMoveTimings } from "../features/savings/savingsMoveTiming"
import { SAVINGS_ESTIMATE_TICK_MS } from "../features/savings/savingsEstimate"
import { pageFpcRefuel } from "../features/fees/fpcRefuel"
import { wagmiConfig } from "../session/wagmi"
import { openL1Wallet, type L1Wallet } from "../session/l1Wallet"
import type { PageChain } from "../session/pageChain"
import {
  createPageChain,
  createPageReads,
  depositTokenReads,
  slotGrids,
  type PageLoaders,
  type PageReads,
  type PrimedReads,
} from "./pageChain"
import type { ArrivalGrid } from "../features/deposit/depositArrival"
import type { DepositTokens } from "../features/sipa/loadDepositFacts"
import { phoneReach, userAgentClaims } from "../platform/userAgent"
import type { NoirWasm } from "../platform/noirProver"
import type { DepositStart } from "../features/deposit/depositStart"
import type { WithdrawStart } from "../features/withdraw/WithdrawFlow/withdrawStart"
import type { PayStart } from "../features/requests/payStart"
import { pageNoirWasm } from "../platform/noirWasmStart"

/** Whether the tab is shown: the page's polls pause while it is not. */
export const documentVisible: ReadonlyStore<boolean> = {
  get: () => document.visibilityState === "visible",
  subscribe(listener) {
    document.addEventListener("visibilitychange", listener)
    return () => document.removeEventListener("visibilitychange", listener)
  },
}

/** What the page entry builds once, after the config resolves: every session it opens shares it. */
export interface Page extends PageSessions, PageWallet, PageReads {
  /** The resolved config ContractService was built from. */
  config: WebWalletConfig
  chain: PageChain
  liveProfilePortal: WebBootConfig["liveProfilePortal"]
  database: Database
  auth: WebAlphaAuthService
  visible: ReadonlyStore<boolean>
  /** Every poll on outside state waits on it; a test world wakes it. */
  pace: Pace
  /** Every remote value of the page, read at its pace while the page is visible. */
  query: QueryFactory
  /** Wall time, ms epoch: every clock and task of the page reads it. */
  now: () => number
  /** Wall time each second, ticking while a countdown reads it. */
  seconds: ReadonlyStore<number>
  /** Wall time every 30 s, for selectors: request expiry, stuck clocks, elapsed waits. */
  wallClock: ReadonlyStore<number>
  /** Set by a page exit that writes its sign-out first: the gates hold until the page goes. */
  leaving: Store<boolean>
  /** When this tab became the active one: the interrupted-operations sweep ends what started before. */
  activeSince: Store<number>
  /** Loaded once the wallet database opens (`ActiveTabGate`, the demo seed). */
  device: Device
  sessionLock: SessionLock
  /** This tab's signup before its passkey. */
  signup: SignupStash
  pastUser: PastUser
  claims: Claims
  /** A tag's registry binding over a fresh manifest. */
  verifyTag: (tag: string) => ReturnType<typeof verifyTag>
  teeSignerSource: TeeSignerSource
  wagmi: Config
  /** The connected L1 wallet. */
  l1Wallet: L1Wallet
  contractService: Service<ContractService>
  /** Fails on a mainnet manifest the contract service refused. */
  manifestGate: Service<true>
  capacity: PortalCapacityRegistry
  activeTab: ActiveTabHold
  tokenServices: TokenServices
  /** The chain seconds the page's views gate on. */
  chainClock: ChainClock
  /** The rollup's slot grid. */
  slotGrid: QueryEntry<ArrivalGrid>
  /** What a SIPA of the pinned table accepts for each intent. */
  depositTokens: (intent: SipaIntentName) => QueryEntry<DepositTokens>
  /** This browser's claims, probed when a view first reads them. */
  userAgent: ReadonlyStore<UserAgentInfo | undefined>
  /** Whether this laptop can reach a phone for a passkey. */
  phoneReach: QueryEntry<PhoneReach>
  /** Whether a node's network has proven a checkpoint. */
  networkReady: NetworkReady
  /** The fee reads Home warns on. */
  highFees: HighFees
  /** The connected L1 wallet's balances the deposit form reads. */
  l1Balance: L1Balances
  /** Screening verdicts per L1 address. */
  screening: Screenings
  /** Whether the notifications panel is open. */
  notificationsOpen: Store<boolean>
  backupReminder: BackupReminder
  /** ENS names' addresses, looked up again on every read. */
  ensAddress: ReturnType<typeof ensAddresses>
  speedupEstimator: Service<WithdrawalSpeedupEstimator>
  savingsMoveTiming: SavingsMoveTimings
  /** The clock the Savings figure ticks on while it shows. */
  savingsEstimateClock: ReadonlyStore<number>
  fpcRefuel: Service<FpcRefuelService>
  /** Why an account's deposits wait for their sweeps; a test page has none. */
  sipaProcessingObserver?: NonNullable<SessionDeps["sipaProcessingObserver"]>
  /** A dev build's onboarding preview, read when the signup screen opens. */
  onboardingMock?: () => OnboardingMock | null
  /** A demo page's fixture deposit address, which stands in for a derived one. */
  demoDepositAddress?: (tag: string) => ShownAddress
  /** A demo page's screens, each opening where its start says on its first showing. */
  screens?: PageScreens
  /** Every session of the page reads these. */
  rollup: RollupMigrationStores
  /** The one prover every proof of the page goes through: user flows go before background proofs. */
  prover: Prover
  /** The one request a connected wallet holds for the page, whichever sheet asked. */
  walletPrompt: WalletPrompt
  /** Every registration session and tick of the page's sessions, one at a time. */
  registrationTurn: Turn
  /** Who pays each sponsored batch, over the page's auth service. */
  sponsors: PageSponsors
  /** Sky's live rate the landing advertises; the boot starts it. */
  landingRate: LandingRate
  /** The taps the pre-boot screen took before the wallet's router was up. */
  preBoot: PreBoot
  /** The witness wasm every proof on the page waits for: started once, a failed start again. */
  noirWasm: NoirWasm
  /** A ticket signup's witness, read in the visitor's session and redeemed in the account's. */
  preparedTicket: PreparedTicket
  /** The claim server's ticket offer, which the pre-boot visitor page reads early. */
  ticketOffer: PageTicketOffer
  theme: PageTheme
}

/** Where each screen of a demo page opens. */
export interface PageScreens {
  deposit?: DepositStart
  withdraw?: WithdrawStart
  pay?: PayStart
}

/** The boot's result: the resolved config and the page built over it. */
export type PageBoot = WebBootConfig & { page: Page }

export function openPage(
  { config, contractServiceOptions, liveProfilePortal }: WebBootConfig,
  {
    primed,
    pace = pagePace(),
    l1Wallet: devL1Wallet,
    bridgeInProvider,
    loaders,
    ...dev
  }: Pick<Page, "onboardingMock" | "demoDepositAddress" | "screens"> & {
    primed?: PrimedReads
    /** The boot's, so the configuration read and the page's polls wait on one pace. */
    pace?: Pace
    /** A demo page's bridge in place of the profile's. */
    bridgeInProvider?: BridgeInProvider
    /** A demo page's reads in place of the remote ones. */
    loaders?: Partial<PageLoaders>
    /** A demo page's fake wallet, built over the page's pace and wagmi config. */
    l1Wallet?: (page: Pick<Page, "pace" | "wagmi">) => L1Wallet
  } = {},
): Page {
  const database = openDatabase(opfsBackend)
  bindTestDatabase(database)
  const core = { database, device: deviceState(database), sessionLock: sessionLock() }
  bindPasskeyEnvironment(() => core.device.get().passkeyEnv)
  const now = Date.now
  const prover = createProver({ now })
  const auth = createAuthService(
    { ...config, backupPasskeySettings: backupPasskeySettingsEnabled },
    { ...core, signing: prover.signing },
    () => followSavedSession(core.device, sessions),
  )
  const query = queries({ pace, visible: documentVisible, now })
  const chain = createPageChain(
    config,
    { query, database, now },
    contractServiceOptions.resolveClassArtifact,
    primed,
  )
  // The Main token's co-signer; it shares every token's fleet signers.
  const teeSignerSource = createOxideTeeSignerSource({
    l1RpcUrl: config.l1RpcUrl,
    l1Chain: config.l1Chain,
    transformEnclaveUrl: (url) => fleetUrl(config, { enclaveUrl: url }),
    connect: (fleet, portal) => chain.connectFleetSigner(fleet, portal).ready(),
    oxideClient: () => valueOf(contractService)?.getOxideClient(),
  })
  const wallet = createPageWallet(
    contractServiceFactory({
      network: config.network,
      storage: new BrowserContractServiceStorage(config.network),
      options: contractServiceOptions,
    }),
  )
  const contractService = openContractService({
    wallet: wallet.wallet,
    options: contractServiceOptions,
    // Every sponsored rail here pays through the ClaimFPC, which each registers itself.
    registerSponsorFpc: false,
  })
  const wagmi = wagmiConfig(config)
  // The page's own node client, for reads a view starts before or without the wallet.
  let node: AztecNode | undefined
  const noirWasm = pageNoirWasm()
  const page: Page = {
    config,
    chain,
    liveProfilePortal,
    ...core,
    auth,
    visible: documentVisible,
    pace,
    query,
    now,
    seconds: createClock(1000, now),
    wallClock: createClock(30_000, now),
    leaving: memoryStore(false),
    // The gate sets it once the tab is ready; the demo and the tests keep the page start.
    activeSince: memoryStore(performance.timeOrigin),
    signup: createSignupStash(tabStash),
    pastUser: createPastUser(tabStash, wagmi, auth, config),
    claims: createClaims(),
    verifyTag: (tag) => verifyTag(page, tag),
    rollup: rollupMigrationStores(),
    prover,
    walletPrompt: createWalletPrompt(),
    registrationTurn: createTurn(),
    sponsors: pageSponsors(auth),
    landingRate: landingRate(query, { config, chain }),
    preBoot: createPreBoot(),
    noirWasm,
    preparedTicket: createPreparedTicket(noirWasm),
    ticketOffer: pageTicketOffer(query, config),
    theme: pageTheme(
      document.documentElement,
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]'),
    ),
    switchTo: (namespace, handoff) => switchSession(namespace, sessions, handoff),
    teeSignerSource,
    wagmi,
    l1Wallet: devL1Wallet?.({ pace, wagmi }) ?? openL1Wallet({ wagmi }),
    ...wallet,
    contractService,
    manifestGate: manifestGate(contractService),
    capacity: capacityRegistry(config, wallet.wallet, query),
    activeTab: { attempts: 0 },
    tokenServices: pageTokenServices(wallet.wallet),
    chainClock: chainClock(query, wallet.wallet),
    slotGrid: loaders?.slotGrid
      ? query<[], ArrivalGrid>("slotGrid", { load: loaders.slotGrid })()
      : slotGrids(query, () => (node ??= createNode(config.nodeUrl, config.nodeApiKey))),
    depositTokens: depositTokenReads(query, { config, chain }),
    userAgent: userAgentClaims(query),
    phoneReach: phoneReach(query, auth),
    networkReady: networkReadiness(query, wallet.wallet),
    highFees: highFees(query, config, wallet.wallet),
    l1Balance: l1Balances(query, (account, token) =>
      readL1DepositTokenBalance(account, token, { config, chain }),
    ),
    screening: screenings(
      query,
      loaders?.screening
        ? { screen: loaders.screening }
        : config.predicate
        ? new PredicateScreeningService(config.predicate)
        : passThroughScreener,
    ),
    ensAddress: loaders?.ensAddress
      ? query<[name: string], Address | null>("ensAddress", { load: loaders.ensAddress, stale: 0 })
      : ensAddresses(query, () => chain.ensClient()),
    notificationsOpen: memoryStore(false),
    backupReminder: pageBackupReminder(),
    speedupEstimator: pageSpeedupEstimator(wallet.wallet, config),
    savingsMoveTiming: savingsMoveTimings(query, () => page),
    savingsEstimateClock: createClock(SAVINGS_ESTIMATE_TICK_MS, now, documentVisible),
    fpcRefuel: pageFpcRefuel(wallet.wallet, config),
    sipaProcessingObserver: (deposits) => sipaProcessingObserver(page, deposits),
    ...createPageReads({ config, chain }, query, {
      bridgeOut: chain.bridgeOut,
      bridgeInProvider,
      loaders,
    }),
    ...dev,
  }
  const sessions = pageSessionDeps(page)
  return page
}

export const pageSessionDeps =
  (page: Page): PageSessionDeps =>
  (namespace, handoff) => {
    return {
      namespace,
      database: page.database,
      auth: page.auth,
      device: page.device,
      sessionLock: page.sessionLock,
      leaving: page.leaving,
      wallet: page.wallet,
      contractService: page.contractService,
      visible: page.visible,
      catchUp: syncCatchUp,
      teeSignerSource: page.teeSignerSource,
      custody: registrationCustody,
      registrationCommitted: (changes) => registrationFunnel(fireOnboardingEvent)(changes),
      features: sessionTasks,
      page,
      rollup: page.rollup,
      ...(namespace.id
        ? {
            sipaProcessingObserver: page.sipaProcessingObserver,
            signIn: {
              storageId: namespace.id,
              auth: (ready: ObsidionWallet) => walletAuth(page.auth, ready, accountsOfSession),
              createToken: (wallet, account) => TokenService.create(wallet, account),
              handoff,
              backupRotationUnreadable: reportBackupRotationUnreadable,
              previousAccount: getPreviousAccountWatcher(),
            },
          }
        : {}),
    }
  }
