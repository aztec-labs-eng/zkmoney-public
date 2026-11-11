/**
 * zkmoney-demo-mode-seed — writes a scenario's fixtures into the real stores, unlocks a synthetic
 * session, and stands up the two collaborators an offline browser lacks (an injected L1 wallet and
 * the L1 RPC behind it). Runs to completion before React mounts, so every hook's first read
 * already sees a populated wallet.
 *
 * Runtime gates skip external services for the demo session. Contact lookup and Share inject
 * deterministic inputs at their service boundaries; persistence and payload encoding remain real.
 */
import SCENARIO_HELP from "./demoScenarios.json"
import { PaylinkActionEnum, WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EcdsaK256AlphaAuthProvider } from "@obsidion/sdk"
import {
  WalletError,
  fundingOf,
  readIdentity,
  recordOf,
  type PaylinkTransaction,
  type SipaDeposit,
  type TokenTransaction,
  type Transaction,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import type { Pace } from "@obsidion/core/cadence"
import type { WebBootConfig } from "../config/env"
import { saveIdentity } from "../session/account"
import { WebPasskeyIdentityMap } from "../platform/auth/WebPasskeyIdentityMap"
import { activateTab } from "../platform/storage/activeTab"
import { writeDeviceKeys } from "../platform/storage/deviceKeys"
import { WEB_STORAGE_PREFIX } from "../platform/storage/WebStorageAdapter"
import { walletStorage } from "../platform/storage/walletStorage"
import { openPage, type Page, type PageScreens } from "../app/sessionDeps"
import { devMockRoute } from "../app/devRoutes"
import type { PrimedReads } from "../app/pageChain"
import { activeNamespace, commitSecret, sessionLoaded, signedInAccount } from "../session/session"
import type { Session } from "../session/session"
import {
  disableDemoMode,
  DEMO_DEFAULT_SCENARIO,
  DEMO_SCENARIOS,
  type DemoScenario,
} from "./demoFlag"
import { profileBridge } from "../session/walletChains"
import {
  activityDeposits,
  demoBridgeIns,
  demoClaimFragments,
  demoContacts,
  demoRequests,
  demoTransactions,
  demoWithdrawals,
  recoveryDeposits,
  DEMO_BALANCE_RAW,
  DEMO_COMPLETE_ADDRESS,
  DEMO_CREDENTIAL_ID,
  DEMO_HANDLE,
  DEMO_L2_ADDRESS,
  DEMO_L2_TOKEN,
  DEMO_MSK_HEX,
  DEMO_NETWORK_ID,
  DEMO_OXIDE_DEPLOYMENT,
  DEMO_OXIDE_TUPLE,
  DEMO_PASSKEY_PUBKEY_HEX,
  DEMO_SIGNING_KEY_HEX,
} from "./demoFixtures"
import { longDemoContacts } from "./contactDemo"
import { installFakeEthereum } from "./fakeEthereum"
import { fakeL1Wallet } from "./fakeL1Wallet"
import { createL1RpcHandler, installL1RpcStub, registerDemoSipaPrediction } from "./fakeL1Rpc"
import { mockOnboarding as onboardingMock } from "./mockOnboarding"
import { demoDepositAddress } from "./demoDeposit"
import { demoBridgeIn } from "./fakeBridgeIn"
import { mockQuoteBridgeOut, withdrawMock } from "./mockWithdraw/mockWithdraw"
import { depositMock } from "./mockDeposit"
import { payMock } from "./mockPay"
import type { DemoMock } from "./demoMock"
import type { WebWalletConfig } from "../config/env"

/**
 * Demo mode owns this origin's wallet state — seeding on top of whatever is there would duplicate
 * contacts and interleave two accounts' history. Scoped to the keys the wallet itself writes.
 */
async function resetWalletStorage(): Promise<void> {
  // Both prefixes: front-core's stores go through the adapter, while the identity record and the
  // session are written directly.
  // eslint-disable-next-line local/legacy-store -- ZKM-1625
  await walletStorage.commitRemoveUnder(WEB_STORAGE_PREFIX)
  await walletStorage.commitRemoveUnder("webwallet.")
}

/**
 * An unlocked session without a passkey: `commitSecret` installs the master key and a signing
 * provider in memory, which is exactly what a completed passkey ceremony leaves behind — so
 * `getSecretKey()` (and the stealth-key derivation the recovery flow runs on it) answers normally.
 * The breadcrumb + identity record are what the wallet route gate reads.
 */
async function seedIdentity(page: Page, rpId: string): Promise<Session> {
  const unlocked = {
    secretKey: Fr.fromHexString(DEMO_MSK_HEX),
    authProvider: new EcdsaK256AlphaAuthProvider(Buffer.from(DEMO_SIGNING_KEY_HEX, "hex")),
  }
  const scope = { auth: page.auth, device: page.device, page }
  const committed = await commitSecret(scope, unlocked, () => true)
  if (!committed) throw new WalletError("wallet.notReady", "the demo commit did not land")
  await new WebPasskeyIdentityMap(page.database, rpId).upsert({
    credentialId: DEMO_CREDENTIAL_ID,
    l2Address: DEMO_L2_ADDRESS,
    pubkey: DEMO_PASSKEY_PUBKEY_HEX,
    isMskRoot: true,
  })
  await signedInAccount(committed.session).apply({
    type: "saved",
    completeAddress: DEMO_COMPLETE_ADDRESS,
    signer: { credentialId: DEMO_CREDENTIAL_ID, pubkey: DEMO_PASSKEY_PUBKEY_HEX },
  })
  await saveIdentity(page, { handle: DEMO_HANDLE, address: DEMO_L2_ADDRESS, claimedAt: Date.now() })
  return committed.session
}

/** The scoped balance record, named, that the balances store reads the home figure from. */
async function seedBalance(session: Session, networkType: string, balance: bigint): Promise<void> {
  // The fixture has no sync: a balance written once the session's balances start is its read.
  void session.balances
  const { balanceStore } = session
  if (!balanceStore) throw new WalletError("wallet.notReady", "the demo seeds an account session")
  const scope = `${networkType}:${DEMO_COMPLETE_ADDRESS}`
  await balanceStore.write(scope, DEMO_L2_TOKEN, balance, undefined, undefined, WALLET_TOKEN_SYMBOL)
}

async function seedDeposits(session: Session, records: SipaDeposit[]): Promise<void> {
  const store = session.sipaDeposits
  for (const record of records) {
    await store.adopt({ ...record, networkId: DEMO_NETWORK_ID })
    // Teach the fake Registry this fixture's CREATE2 answer — the self-sweep refuses to deploy
    // unless `predictSIPA` reproduces the record's own address.
    registerDemoSipaPrediction(record.recipientHash, record.sipaAddress)
  }
}

async function seedWithdrawals(session: Session, records: WithdrawalRecord[]): Promise<void> {
  const store = session.withdrawals
  for (const record of records) await store.create({ ...record, networkId: DEMO_NETWORK_ID })
}

async function seedBridgeIns(session: Session, now: number): Promise<void> {
  const chains = (profileBridge(session.page.config)?.chains ?? []).map((c) => c.chainId)
  if (!chains.length) return
  const { bridgeIns } = session
  for (const record of demoBridgeIns(now, chains)) await bridgeIns.rebuild(record)
}

/**
 * Past-dated history, written as the rows themselves so every fixture keeps its own time; a created
 * link's row files its link and keeps its funding transfer.
 */
async function seedTransactions(session: Session, rows: Transaction[]): Promise<void> {
  const { transfers, paylinks, operations } = session
  for (const tx of rows) {
    const row = { ...tx, networkId: DEMO_NETWORK_ID }
    const link = row as PaylinkTransaction
    if (link.emailPaymentAction === PaylinkActionEnum.PAY && link.payToEmailSecret) {
      await paylinks.put(recordOf({ ...link, payToEmailSecret: link.payToEmailSecret }))
      await transfers.record(fundingOf(row))
    } else if (row.status === "pending" && row.action === "send") {
      // This device's own send is its operation.
      const { token, to = "", toTag } = row as TokenTransaction
      const operationId = row.operationId ?? `demo-${row.txHash}`
      const payload = { networkId: DEMO_NETWORK_ID, token, amountAtomic: String(row.amountAtomic) }
      await operations.begin({ operationId, flow: "send", summary: "" }, row.timestamp)
      await operations.apply(operationId, {
        type: "transfer",
        transfer: { kind: "send", payload: { ...payload, to, toTag } },
      })
      if (row.txHash) await operations.apply(operationId, { type: "sent", txHash: row.txHash })
      operations.release(operationId)
    } else await transfers.record(row)
  }
}

async function seedContactsAndRequests(
  session: Session,
  now: number,
  networkId: string,
  longContacts = false,
): Promise<void> {
  const { contacts, requests } = session
  if (!contacts) throw new WalletError("wallet.notReady", "the demo seeds an account session")
  await contacts.addEntries(longContacts ? longDemoContacts() : demoContacts())
  for (const request of demoRequests(now, networkId)) await requests.add(request)
}

/**
 * What this origin already holds, named for the refusal message — or null when it holds nothing
 * but the demo's own prior seed. Both halves of the app's onboarded definition count: the claimed
 * handle AND the breadcrumb of a passkey that opens it. An onboarding that died between the two
 * leaves only the breadcrumb, and the passkey behind it is still a real account key.
 */
async function foreignWalletState(page: Page, rpId: string): Promise<string | null> {
  await page.device.load()
  const identity = await readIdentity(page.database.scoped(activeNamespace(page.device).prefix))
  if (identity && identity.address !== DEMO_L2_ADDRESS) {
    return `a wallet identity ("${identity.handle}")`
  }
  const opening = await new WebPasskeyIdentityMap(page.database, rpId).getOpeningRecord()
  if (opening && opening.l2Address !== DEMO_L2_ADDRESS) return "a passkey for another account"
  return null
}

/** Every URL query demo mode understands, keyed off the scenario list so the two cannot drift. */
function demoHelp(): string {
  const rows: [string, string][] = [
    ...DEMO_SCENARIOS.map((name): [string, string] => [
      `?demo=${name}`,
      SCENARIO_HELP[name] ?? "(no description)",
    ]),
    ["?demo", `same as ?demo=${DEMO_DEFAULT_SCENARIO}`],
    ["?demo=off", "leave demo mode (clears the sessionStorage latch)"],
  ]
  const width = Math.max(...rows.map(([query]) => query.length))
  const lines = rows.map(([query, what]) => `  ${query.padEnd(width)}  ${what}`)
  return [
    "[demo] URL queries:",
    ...lines,
    "  The scenario is latched in sessionStorage, so in-app navigation keeps it.",
  ].join("\n")
}

/** The `/dev/mock/<area>/<name>` page this URL opens; undefined anywhere else. */
function urlMock(config: WebWalletConfig): DemoMock | undefined {
  const route = devMockRoute(window.location.pathname, window.location.search)
  if (!route) return undefined
  const { area, name, query } = route
  if (area === "deposit") return depositMock(name, query, config)
  if (area === "withdraw") return withdrawMock(name, config)
  return payMock(name, query, config)
}

/**
 * Seeds the scenario on a page it builds over the boot's `pace`, its reads `primed`, and a
 * `/dev/mock/` URL's mock over it; null when this origin holds a real wallet and was left untouched.
 */
export async function seedDemo(
  scenario: DemoScenario,
  boot: WebBootConfig,
  primed: PrimedReads = { tuple: DEMO_OXIDE_TUPLE, deployment: DEMO_OXIDE_DEPLOYMENT },
  pace?: Pace,
): Promise<Page | null> {
  const { config } = boot
  const mock = urlMock(config)
  // Filled once the mock's records are seeded: a start names the records it opens on.
  const screens: PageScreens = {}
  const page = openPage(boot, {
    onboardingMock,
    demoDepositAddress,
    primed,
    pace,
    ...(mock && { screens }),
    bridgeInProvider: mock?.bridgeInProvider ?? demoBridgeIn(Date.now),
    loaders: { bridgeOutQuote: (_facts, ask) => mockQuoteBridgeOut(ask), ...mock?.loaders },
    l1Wallet: (deps) =>
      fakeL1Wallet(deps, {
        chainId: config.l1ChainId,
        connected: mock?.connected,
        provider: () => window.ethereum,
      }),
  })
  // Never replace a real wallet. Only an origin with no wallet state — or one holding the demo's
  // own from a prior seed — may be seeded; anything else refuses and boots the real app.
  const foreign = await foreignWalletState(page, config.rpId)
  if (foreign) {
    console.error(
      `[demo] refusing to seed: this origin already holds ${foreign}. ` +
        "Demo mode replaces the origin's wallet state — use a browser profile without a wallet. " +
        "Booting the real app.",
    )
    disableDemoMode()
    return null
  }

  // Demo mode runs no active-tab lifecycle, so the seed marks this page as the active tab.
  activateTab()
  const now = Date.now()
  console.info(`[demo] seeding scenario "${scenario}" — this origin's wallet state is replaced`)
  console.info(demoHelp())

  await resetWalletStorage()
  await page.device.load()
  // A hidden-balance pref the load carried in would blank the seeded figure.
  await writeDeviceKeys(page.database, { hideBalances: "false" })
  await sessionLoaded(page.switchTo(activeNamespace(page.device)))
  // Onboarding uses mockOnboarding's local transitions and starts without an identity or provider.
  // Its token lists still read the table.
  if (scenario === "onboarding") {
    installL1RpcStub(config.l1RpcUrl, createL1RpcHandler(config.l1ChainId))
    return page
  }
  installL1RpcStub(config.l1RpcUrl, installFakeEthereum(config.l1ChainId))

  const session = await seedIdentity(page, config.rpId)
  await seedBalance(session, config.network, scenario === "empty" ? 0n : DEMO_BALANCE_RAW)

  if (scenario === "recovery") {
    await seedDeposits(session, recoveryDeposits(now))
    await seedTransactions(session, demoTransactions(now).slice(0, 2))
  }
  if (["activity", "contacts", "contact-search", "share-retry", "share-long"].includes(scenario)) {
    await seedContactsAndRequests(
      session,
      now,
      config.network,
      scenario === "contacts" || scenario === "contact-search",
    )
    await seedTransactions(session, demoTransactions(now))
    await seedWithdrawals(session, demoWithdrawals(now))
    await seedDeposits(session, activityDeposits(now))
    await seedBridgeIns(session, now)
    const claims = demoClaimFragments()
    console.info(
      `[demo] claimable paylinks:\n  direct: /link#${claims.direct}\n  email:  /link#${claims.email}`,
    )
  }
  if (mock) {
    if (mock.balance !== undefined) await seedBalance(session, config.network, mock.balance)
    Object.assign(screens, await mock.seed(session))
  }
  return page
}
