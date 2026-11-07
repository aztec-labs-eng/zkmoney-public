/** The page's one composition root for sessions: the only place they read config and singletons. */
import {
  BalanceStorage,
  contractServiceResource,
  createOxideTeeSignerSource,
  BroadcastDeferred,
  ContactStorage,
  TokenStorage,
  openDatabase,
  resolveAssetConstants,
  syncCatchUp,
  type Database,
  memoryStore,
  type ReadonlyStore,
  type Store,
  type Resource,
  type TeeSignerSource,
} from "@obsidion/front-core"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import {
  TokenService,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { getConfig, getContractServiceOptions, type WebBootConfig } from "../config/env"
import { fleetUrl } from "../config/oxideTuple"
import { connectFleetSigner } from "../features/token/oxideToken"
import { BrowserContractServiceStorage } from "../platform/contracts/BrowserContractServiceStorage"
import { sipaProcessingObserver } from "../features/deposit/sipaProcessingObserver"
import { followOperationScope, getOperationStore } from "../features/operations/operations"
import { rotationExecutor } from "../features/broadcasts/rotationBroadcastExecutor"
import { slotExecutor } from "../features/broadcasts/slotExecutor"
import { registrationCustody } from "../features/registration/openRegistration"
import { createPastUser, type PastUser } from "../features/registration/pastUser"
import { createSignupStash, type SignupStash } from "../features/registration/signupStash"
import type { OnboardingMock } from "../features/onboarding/OnboardingScreen/signupFlow"
import type { ShownAddress } from "../features/sipa/depositTarget"
import { registrationFunnel } from "../features/registration/registrationFunnel"
import { fireOnboardingEvent } from "../lib/analytics"
import {
  backgroundProveReserved,
  onBackgroundProvesEnded,
  onUserFlowsIdle,
  trackBackgroundProve,
  userFlowActive,
} from "../features/provingGate"
import { withdrawalRails } from "../features/withdraw/withdrawGateway"
import { activeTabSince } from "../platform/activeTabSince"
import { createAuthService, walletAuth } from "../platform/auth/useAuthenticator"
import type { WebAlphaAuthService } from "../platform/auth/WebAlphaAuthService"
import {
  accountsOfSession,
  followSavedSession,
  type BroadcastDeps,
  type PageSessionDeps,
} from "../session/session"
import { sessionTasks } from "./sessionTasks"
import { contactsWriteLock } from "../platform/storage/contactsLock"
import { webStorage } from "../platform/storage/WebStorageAdapter"
import { sessionLock, type SessionLock } from "../platform/storage/activeStorage"
import { deviceState, type Device } from "../platform/storage/deviceKeys"
import { tabStash } from "../platform/storage/tabStash"
import { opfsBackend } from "../platform/storage/walletStorage"
import { pageWallet } from "../platform/wallet"

const documentVisible: ReadonlyStore<boolean> = {
  get: () => document.visibilityState === "visible",
  subscribe(listener) {
    document.addEventListener("visibilitychange", listener)
    return () => document.removeEventListener("visibilitychange", listener)
  },
}

async function createToken(wallet: ObsidionWallet, account: ObsidionAccount) {
  const token = await TokenService.create(wallet, account)
  await seedTokenRow(token)
  return token
}

/** The wallet token's row, so the next cold boot names Main's cached balance before the token builds. */
async function seedTokenRow(token: TokenService) {
  const address = token.tokenAddressOrNull?.toString()
  const entry = resolveAssetConstants(getConfig().network)[WALLET_TOKEN_SYMBOL]
  const rows = TokenStorage.get(webStorage)
  if (!address || !entry || (await rows.getTokens()).some((t) => t.address === address)) return
  await rows.addToken({
    address,
    name: entry.name,
    symbol: entry.symbol,
    decimals: entry.decimals,
  })
}

/**
 * Every SIPA broadcast this wallet owes is proven one at a time, after the user's own transaction:
 * local proving is single-flight, so an attempt never starts under another proof.
 */
const pageBroadcasts: BroadcastDeps = {
  executors: (wallet) => ({
    rotation: rotationExecutor(wallet, getConfig()),
    slot: slotExecutor(wallet),
  }),
  // Checked in the same synchronous block that registers the proof, so a user flow raised during
  // the attempt's reads makes it wait instead of colliding with it.
  runExclusive: async (attempt) => {
    if (userFlowActive() || backgroundProveReserved()) throw new BroadcastDeferred(Date.now())
    let result!: Awaited<ReturnType<typeof attempt>>
    await trackBackgroundProve(async () => {
      result = await attempt()
    })
    return result
  },
  busy: () => userFlowActive() || backgroundProveReserved(),
  onIdle(listener) {
    const offIdle = onUserFlowsIdle(listener)
    const offEnded = onBackgroundProvesEnded(listener)
    return () => {
      offIdle()
      offEnded()
    }
  },
  describe: (job) =>
    job.kind === "pool"
      ? undefined
      : {
          flow: "deposit",
          summary: job.source.type === "rotation" ? "Backup passkey" : "Deposit address",
          background: true,
        },
}

/** What the page entry builds once, after the config resolves: every session it opens shares it. */
export interface Page {
  database: Database
  auth: WebAlphaAuthService
  visible: ReadonlyStore<boolean>
  /** Set by a page exit that writes its sign-out first: the gates hold until the page goes. */
  leaving: Store<boolean>
  /** Loaded once the wallet database opens (`ActiveTabGate`, the demo seed). */
  device: Device
  sessionLock: SessionLock
  /** This tab's signup before its passkey. */
  signup: SignupStash
  pastUser: PastUser
  teeSignerSource: TeeSignerSource
  contractService(wallet: Resource<ObsidionWallet>): Resource<ContractService>
  /** A dev build's onboarding preview, read when the signup screen opens. */
  onboardingMock?: () => OnboardingMock | null
  /** A demo page's fixture deposit address, which stands in for a derived one. */
  demoDepositAddress?: (tag: string) => ShownAddress
}

/** The boot's result: the resolved config and the page built over it. */
export type PageBoot = WebBootConfig & { page: Page }

export function openPage(
  config: Parameters<typeof createAuthService>[0],
  dev: Pick<Page, "onboardingMock" | "demoDepositAddress"> = {},
): Page {
  const database = openDatabase(opfsBackend)
  const core = { database, device: deviceState(database), sessionLock: sessionLock() }
  followOperationScope(core.device)
  const auth = createAuthService(config, core, () => followSavedSession(core.device, sessions))
  // The Main token's co-signer, built on first demand; it shares every token's fleet signers.
  let oxideSource: TeeSignerSource | undefined
  const oxideSigner = (): TeeSignerSource => {
    const config = getConfig()
    return (oxideSource ??= createOxideTeeSignerSource({
      l1RpcUrl: config.l1RpcUrl,
      l1Chain: config.l1Chain,
      transformEnclaveUrl: (url) => fleetUrl(config, { enclaveUrl: url }),
      connect: connectFleetSigner,
    }))
  }
  // Keyed by wallet: the page's wallet starts as a stand-in until the active tab boots one.
  const contractServices = new WeakMap<Resource<ObsidionWallet>, Resource<ContractService>>()
  const page: Page = {
    ...core,
    auth,
    visible: documentVisible,
    leaving: memoryStore(false),
    signup: createSignupStash(tabStash),
    pastUser: createPastUser(tabStash),
    teeSignerSource: {
      get label() {
        return oxideSigner().label
      },
      load: () => oxideSigner().load(),
      subscribe: (onChange) => oxideSigner().subscribe?.(onChange) ?? (() => {}),
      refresh: () => oxideSigner().refresh?.(),
    },
    contractService(wallet) {
      let service = contractServices.get(wallet)
      if (!service) {
        service = contractServiceResource({
          wallet,
          get network() {
            return getConfig().network
          },
          get storage() {
            return new BrowserContractServiceStorage(getConfig().network)
          },
          get options() {
            return getContractServiceOptions()
          },
          // Every sponsored rail here pays through the ClaimFPC, which each registers itself.
          registerSponsorFpc: false,
        })
        contractServices.set(wallet, service)
      }
      return service
    },
    ...dev,
  }
  const sessions = pageSessionDeps(page)
  return page
}

export const pageSessionDeps =
  (page: Page): PageSessionDeps =>
  (namespace, handoff) => {
    const wallet = pageWallet()
    return {
      namespace,
      database: page.database,
      auth: page.auth,
      device: page.device,
      sessionLock: page.sessionLock,
      leaving: page.leaving,
      wallet,
      contractService: page.contractService(wallet),
      visible: page.visible,
      get network() {
        return getConfig().network
      },
      get endpointScope() {
        return getConfig().nodeEndpointDigest
      },
      catchUp: syncCatchUp,
      teeSignerSource: page.teeSignerSource,
      operations: getOperationStore(),
      get activeSince() {
        return activeTabSince()
      },
      withdrawalRails: () => withdrawalRails(getConfig()),
      broadcasts: pageBroadcasts,
      custody: registrationCustody,
      registrationCommitted: (changes) => registrationFunnel(fireOnboardingEvent)(changes),
      features: (core) => sessionTasks(core, page),
      page: pageSessionDeps(page),
      ...(namespace.id
        ? {
            sipaProcessingObserver,
            signIn: {
              storageId: namespace.id,
              balances: BalanceStorage.get(webStorage),
              tokens: TokenStorage.get(webStorage),
              contacts: ContactStorage.get(webStorage, contactsWriteLock),
              auth: (ready: ObsidionWallet) => walletAuth(page.auth, ready, accountsOfSession),
              createToken,
              handoff,
            },
          }
        : {}),
    }
  }
