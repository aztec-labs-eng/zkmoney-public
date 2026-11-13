import { createPace } from "@obsidion/core/cadence"
import { http } from "viem"
import { foundry } from "viem/chains"
import { createConfig } from "wagmi"
import {
  createProver,
  createTurn,
  createClock,
  ensAddresses,
  memoryStore,
  openDatabase,
  passThroughScreener,
  queries,
  screenings,
  service,
  type AddressScreener,
  type Database,
} from "@obsidion/front-core"
import type { Page } from "../../src/app/sessionDeps"
import { createWalletPrompt } from "../../src/session/walletPrompt"
import { openL1Wallet } from "../../src/session/l1Wallet"
import { pageSponsors } from "../../src/features/registration/sponsorAccounts"
import { createPreBoot } from "../../src/session/preBoot"
import { createPreparedTicket } from "../../src/features/onboarding/goldenTicket"
import { pageTicketOffer } from "../../src/features/paylink/ticketOffer"
import {
  createPageChain,
  createPageReads,
  depositTokenReads,
  slotGrids,
  type PrimedReads,
} from "../../src/app/pageChain"
import { phoneReach, userAgentClaims } from "../../src/platform/userAgent"
import { pageTheme } from "../../src/platform/storage/theme"
import type { WebWalletConfig } from "../../src/config/env"
import {
  WebAlphaAuthService,
  type WebAlphaAuthServiceOptions,
} from "../../src/platform/auth/WebAlphaAuthService"
import { createPastUser } from "../../src/features/registration/pastUser"
import { createClaims } from "../../src/features/paylink/claims"
import { verifyTag } from "../../src/features/contacts/registryResolution"
import { createSignupStash } from "../../src/features/registration/signupStash"
import { sessionLock, type SessionLock } from "../../src/platform/storage/activeStorage"
import { tabStash } from "../../src/platform/storage/tabStash"
import { TEST_CONFIG } from "./seedBootConfig"
import { deviceState, writeDeviceKeys, type Device } from "../../src/platform/storage/deviceKeys"
import { opfsBackend } from "../../src/platform/storage/walletStorage"
import { rollupMigrationStores } from "../../src/features/migration/rollupMigrationStores"
import { pageNoirWasm } from "../../src/platform/noirWasmStart"
import { createPageWallet } from "../../src/platform/wallet"
import { capacityRegistry } from "../../src/features/deposit/capacityRegistry"
import { chainClock } from "../../src/features/paylink/chainClock"
import { SAVINGS_ESTIMATE_TICK_MS } from "../../src/features/savings/savingsEstimate"
import { networkReadiness } from "../../src/features/cutover/networkReadiness"
import { highFees } from "../../src/features/fees/highFees"
import { l1Balances } from "../../src/features/deposit/l1Balances"
import { pageTokenServices } from "../../src/features/token/tokenServices"
import { pageBackupReminder } from "../../src/features/backupPasskey/backupReminder"

/** Screening verdicts over `screener`, for a suite that renders under a `ScreeningProvider`. */
export const testScreenings = (screener: AddressScreener = passThroughScreener) =>
  screenings(
    queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => Date.now() }),
    screener,
  )

/** A service a suite's page never builds. */
const never = (name: string) =>
  service(name, { from: [], retry: "manual" }, () => new Promise<never>(() => {}))

type Core = { database: Database; device: Device; sessionLock: SessionLock }

/** `test/setup.ts` reloads its device keys before each test. */
const TEST_PAGE = Symbol.for("zk.money/test-page")

/** A suite that never opens the wallet store loads no device keys. */
const unopened = () => undefined

/**
 * The suite's page database, device keys and session lock, built on first use. The device keys
 * load at once, ahead of every write made through the database.
 */
export function testCore(): Core {
  const holder = globalThis as { [TEST_PAGE]?: Core }
  if (!holder[TEST_PAGE]) {
    const database = openDatabase(opfsBackend)
    const device = deviceState(database)
    void device.load().then(undefined, unopened)
    holder[TEST_PAGE] = { database, device, sessionLock: sessionLock() }
  }
  return holder[TEST_PAGE]
}

/** The page core over `database`: the suite's own, or one with its own device keys. */
export function pageOver(database: Database): Core {
  const core = testCore()
  if (database === core.database) return core
  const device = deviceState(database)
  void device.load().then(undefined, unopened)
  return { database, device, sessionLock: core.sessionLock }
}

/** The suite page's device keys as saved. */
export const committed = () => testCore().device.get()

/** An auth service over this test's page, `options` in place of its defaults. */
export const testAuth = (options: Partial<WebAlphaAuthServiceOptions> = {}) =>
  new WebAlphaAuthService({ ...testCore(), rpId: "localhost", ...options })

/** No connectors: a suite connects no L1 wallet. */
export const testWagmi = createConfig({
  chains: [foundry],
  connectors: [],
  multiInjectedProviderDiscovery: false,
  transports: { [foundry.id]: http() },
  storage: null,
})

/** The sandbox config `test/setup.ts` resolves for each suite. */
export const defaultConfig = (globalThis as { [TEST_CONFIG]?: WebWalletConfig })[TEST_CONFIG]!

/**
 * A visible page over the test's wallet database, with `auth` and `config` in place of its own, its
 * reads `primed`.
 */
export function testPage(
  auth?: unknown,
  config: WebWalletConfig = defaultConfig,
  primed?: PrimedReads,
): Page {
  const pageAuth = (auth as WebAlphaAuthService) ?? testAuth()
  // Read on a proof's first call: a suite that mocks the prover names no init.
  const noirWasm = pageNoirWasm()
  const wallet = createPageWallet({} as never)
  const pace = createPace()
  const visible = memoryStore(true).readonly
  const now = () => Date.now()
  const query = queries({ pace, visible, now })
  const chain = createPageChain(
    config,
    { query, database: testCore().database, now },
    undefined,
    primed,
  )
  const page: Page = {
    ...testCore(),
    config,
    chain,
    ...createPageReads({ config, chain }, query, { bridgeOut: chain.bridgeOut }),
    liveProfilePortal: async () => config.oxideProfile.portal,
    auth: pageAuth,
    visible,
    pace,
    query,
    now,
    seconds: createClock(1000, now),
    wallClock: createClock(30_000, now),
    leaving: memoryStore(false),
    activeSince: memoryStore(performance.timeOrigin),
    signup: createSignupStash(tabStash),
    pastUser: createPastUser(tabStash, testWagmi, pageAuth, config),
    claims: createClaims(),
    verifyTag: (tag) => verifyTag(page, tag),
    rollup: rollupMigrationStores(),
    prover: createProver({ now: () => Date.now() }),
    walletPrompt: createWalletPrompt(),
    registrationTurn: createTurn(),
    sponsors: pageSponsors(pageAuth),
    landingRate: query<[], { rate: undefined }>("landingRate", {
      load: async () => ({ rate: undefined }),
    })(),
    preBoot: createPreBoot(),
    noirWasm,
    preparedTicket: createPreparedTicket(noirWasm),
    ticketOffer: pageTicketOffer(query, config),
    theme: pageTheme({ dataset: {} }),
    switchTo: () => {
      throw new Error("testPage switches no session")
    },
    // A suite's page reaches no fleet signer and builds no contract service.
    teeSignerSource: { label: "test", load: async () => undefined },
    wagmi: testWagmi,
    l1Wallet: openL1Wallet({ wagmi: testWagmi }),
    ...wallet,
    contractService: never("contractService"),
    manifestGate: never("manifestGate"),
    capacity: capacityRegistry(config, wallet.wallet, query),
    activeTab: { attempts: 0 },
    tokenServices: pageTokenServices(wallet.wallet),
    chainClock: chainClock(query, wallet.wallet),
    // A suite's page reads no slot grid.
    slotGrid: slotGrids(query, () => ({ getL1Constants: () => new Promise<never>(() => {}) })),
    depositTokens: depositTokenReads(query, { config, chain }),
    userAgent: userAgentClaims(query),
    phoneReach: phoneReach(query, pageAuth),
    networkReady: networkReadiness(query, wallet.wallet),
    highFees: highFees(query, config, wallet.wallet),
    // A suite's page reads no L1 balance.
    l1Balance: l1Balances(query, () => new Promise<never>(() => {})),
    screening: screenings(query, passThroughScreener),
    ensAddress: ensAddresses(query, () => page.chain.ensClient()),
    notificationsOpen: memoryStore(false),
    backupReminder: pageBackupReminder(),
    speedupEstimator: never("speedupEstimator"),
    savingsMoveTiming: query<[], never>("savingsMoveTiming", { load: () => new Promise(() => {}) }),
    savingsEstimateClock: createClock(SAVINGS_ESTIMATE_TICK_MS, now, visible),
    fpcRefuel: never("fpcRefuel"),
  }
  return page
}

/** Saves device keys through the page's database. */
export const seedDeviceKeys = (values: Parameters<typeof writeDeviceKeys>[1]) =>
  writeDeviceKeys(testCore().database, values)

/** Reads the device keys again, for a test that reopened the wallet store under the page. */
export const reloadDevice = () => testCore().device.load()
