/**
 * The account's stores, services and tasks, built once per page and handed down by `useSession`. A
 * page serves one account: another account's sign-in reloads the page (`reloadIfSessionSwitched`),
 * so nothing here follows an account change. A page with no account, such as a link's visitor, runs on
 * the anonymous namespace until its first sign-in replaces it; its views and their watchers start
 * only once something reads them.
 */
import {
  WalletError,
  openAccount,
  type Loaded,
  type OldVersionWithdrawal,
  type UpgradeActivity,
  createAccountRecord,
  createBackupNudges,
  createBackupRotations,
  createBalanceStore,
  createContacts,
  createSavingsMoves,
  createReceiveCodes,
  createXmtpCursors,
  createXmtpInbox,
  createOwedClaims,
  createWithdrawFunnel,
  createBurnDurations,
  createIdentity,
  type AccountRecord,
  createTransfers,
  createOperations,
  createPaylinks,
  createBalances,
  createBridgeIns,
  createMilestones,
  createNotifications,
  createNameClaims,
  createUnresolvedSends,
  createZkJwtProofs,
  createRegistrations,
  createSavedPreviousAccount,
  createSipaDeposits,
  createWithdrawals,
  derived,
  memoryStore,
  startRuntime,
  openTeeSigner,
  openToken,
  useStore,
  withdrawalTracker,
  type AccountService,
  type Balances,
  type CatchUp,
  type Database,
  type PendingRegistrationRecord,
  type RegistrationChange,
  type ReadonlyStore,
  type Store,
  type RecordSet,
  type SipaDeposit,
  type Runtime,
  type Service,
  type SavedPreviousAccount,
  type SavingsSource,
  type SipaProcessingObserver,
  type Task,
  type TeeSignerSource,
  type QueryFactory,
  type Withdrawals,
} from "@obsidion/front-core"
import type {
  AlphaAuthService,
  CommitSecretInput,
  ContractService,
  FpcRefuelTarget,
  Network,
  ObsidionAccount,
  ObsidionWallet,
  Token,
  TokenService,
} from "@obsidion/sdk"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { useEffect } from "react"
import { backupPasskeySettingsEnabled } from "../config/features"
import type { WebAlphaAuthService } from "../platform/auth/WebAlphaAuthService"
import { recordAddress } from "../platform/auth/WebPasskeyIdentityMap"
import type { DeviceState } from "../platform/storage/deviceKeys"
import type { SessionLock } from "../platform/storage/activeStorage"
import { SIPA_SLOTS_PREFIX, WEB_STORAGE_PREFIX } from "../platform/storage/storageKeys"

/** `id` is null for the namespace a page with no account writes under. */
export type Namespace = { readonly id: string | null; readonly prefix: string }

export const namespaceOf = (id: string | null): Namespace => ({
  id,
  prefix: WEB_STORAGE_PREFIX + (id ? `${id}.` : ""),
})

/** The committed account's namespace, or the anonymous one when there is none. */
export const activeNamespace = (device: ReadonlyStore<DeviceState>): Namespace =>
  namespaceOf(device.get().storageId)

/** The session parts a rotated wallet's previous-account watcher reads and saves. */
export interface PreviousAccountParts {
  /** The session these parts are of: its keys sign and its record names the account. */
  session: SponsorParts & Pick<Session, "contractService">
  saved: SavedPreviousAccount
  /** The session's SIPA passes over another account of its key; null for a visitor. */
  pipeline: {
    passFor(
      recipient: AztecAddress,
      tokenServiceFor: (l2Token: string) => Promise<Pick<TokenService, "claimSweptDeposit">>,
    ): Promise<{ completed: boolean }>
    historyFor(recipient: AztecAddress): Promise<{ completed: boolean }>
  } | null
  /** Prices Savings' shares; null where the session has none. */
  savings: Service<SavingsSource | null> | null
}

/** What an account's session reads beside what every session does. */
export interface SignInDeps {
  storageId: string
  auth(wallet: ObsidionWallet): AlphaAuthService
  createToken(wallet: ObsidionWallet, account: ObsidionAccount): Promise<TokenService>
  /** The account a sign-in just built: the unlock returns it. */
  handoff?: ObsidionAccount
  /** A rotated wallet's previous account, whose history its own scans read. */
  previousAccount?: {
    /** Serves the session whose parts these are; the answer lets go of it. */
    serve(parts: PreviousAccountParts): () => void
    /** Finds the account and saves it for the feed and the bell; undefined while there is none. */
    locate(wallet: ObsidionWallet): Promise<string | undefined>
    /** The account once the PXE can read its events; undefined while there is none. */
    registeredAddress(wallet: ObsidionWallet): Promise<string | undefined>
    /** Records the deposits it was paid, claiming nothing; answers whether the scan read all. */
    readHistory(wallet: ObsidionWallet): Promise<boolean>
  }
}

export interface SessionDeps {
  namespace: Namespace
  database: Database
  /** The page's, as are `database`, `device`, `sessionLock` and `visible`. */
  auth: WebAlphaAuthService
  device: ReadonlyStore<DeviceState>
  sessionLock: SessionLock
  leaving: Store<boolean>
  /** The page's: it outlives every session. */
  wallet: Service<ObsidionWallet>
  /** The page's, over `wallet`. */
  contractService: Service<ContractService>
  visible: ReadonlyStore<boolean>
  catchUp: CatchUp
  teeSignerSource: TeeSignerSource
  /** Why the account's deposits wait for their sweeps; undefined while it cannot read L1. */
  sipaProcessingObserver?(
    deposits: ReadonlyStore<RecordSet<SipaDeposit>>,
  ): SipaProcessingObserver | undefined
  /** Whether a registration holds funds in signup's custody, over its stores. */
  custody(
    registrations: ReadonlyStore<RecordSet<PendingRegistrationRecord>>,
    deposits: ReadonlyStore<RecordSet<SipaDeposit>>,
    withdrawals: Withdrawals["list"],
  ): ReadonlyStore<boolean>
  /** Hears the registration changes the store committed: the funnel's source. */
  registrationCommitted?(changes: readonly RegistrationChange[]): void
  /** An account's session only. */
  signIn?: SignInDeps
  /** The rollup migration's page-wide stores (ZKM-1625): upgrade runs and old-version withdrawals. */
  rollup: {
    upgrades: UpgradeActivity
    oldVersionWithdrawals(): ReadonlyStore<Loaded<OldVersionWithdrawal>>
  }
  /** The feature tasks, services and views over the session's core (`app/sessionTasks.ts`). */
  features(core: Core): SessionFeatures
  /** What every session of the page shares (`app/sessionDeps.ts`). */
  page: SessionPage
}

/** The deps of this page's session for a namespace: `app/sessionDeps.ts` builds them. */
export type PageSessionDeps = (namespace: Namespace, handoff?: ObsidionAccount) => SessionDeps

/** The page's one way to change sessions; `app/sessionDeps.ts` builds it over the page's deps. */
export interface PageSessions {
  switchTo(namespace: Namespace, handoff?: ObsidionAccount): Session
}

/**
 * `app/sessionTasks.ts` adds its builder's result here as `features` and the page as `page`, so
 * `session/` names those types without importing `app/`.
 */
export interface SessionParts {}
type SessionFeatures = SessionParts extends { features: infer F } ? F : never
type SessionPage = SessionParts extends { page: infer P } ? P : never

/**
 * What a sponsored batch uses of its session: the page's sponsors name the payer, and the batch owes
 * its FPC a refuel check.
 */
export type SponsorParts = Pick<
  Session,
  "auth" | "nameClaims" | "identity" | "page" | "subscriptionChecks" | "oweFpcRefuel"
>

/** The session's stores its executors send over: a visitor has no rotations. */
export type ExecutorSession = SponsorParts &
  Pick<Session, "backupRotations" | "sipaDeposits" | "contractService">

const NO_RECORDS: ReadonlyStore<RecordSet<never>> = memoryStore({
  records: [],
  loaded: true,
  failed: false,
}).readonly
const NOTHING_STORED = memoryStore({ value: undefined, loaded: true }).readonly

/** One subscription read: it keys by its (account, ClaimFPC, rail), and `read` asks the PXE. */
export interface SubscriptionRead {
  toString(): string
  read(): Promise<boolean>
}

/**
 * Whether each (account, ClaimFPC, rail) holds its subscription. A held one stays known. A missing
 * one is read again next time, unless a subscribe of its key landed since.
 */
export function createSubscriptionChecks(query: QueryFactory) {
  const landed = new Set<string>()
  return {
    held: query<[SubscriptionRead], boolean>("claimFpcSubscription", {
      load: (check) => (landed.has(String(check)) ? Promise.resolve(true) : check.read()),
      stale: (held) => !held,
    }),
    /** A subscribe of `key` landed. */
    landed: (key: string) => void landed.add(key),
  }
}

/**
 * What a session builds before its features: its stores, services and milestones. `detect` wakes
 * registration detection: a record opened, or its address showed its first funds.
 */
function openCore(deps: SessionDeps, wake: Runtime["wake"], detect: () => void) {
  const { namespace, wallet, contractService, signIn } = deps
  const { now } = deps.page
  const ended = new AbortController()
  const db = deps.database.scoped(namespace.prefix, ended.signal)
  // First, so their opens queue before the other stores' migrations: the balance is read first.
  const balanceStore = signIn ? createBalanceStore({ db, now }) : null
  const withdrawals = createWithdrawals({ db, now })
  const bridgeIns = createBridgeIns({ db })
  const sipaDeposits = createSipaDeposits({
    db,
    now,
    account: namespace.id !== null,
    funded: detect,
    legacy: {
      db: deps.database.scoped(WEB_STORAGE_PREFIX),
      scope: namespace.id,
      slots: deps.database.scoped(SIPA_SLOTS_PREFIX),
    },
  })
  const registrations = createRegistrations({
    db,
    now,
    legacy: deps.database,
    deposits: sipaDeposits,
    account: namespace.id !== null,
    committed(changes) {
      deps.registrationCommitted?.(changes)
      if (changes.some(({ first }) => first.includes("startTime"))) detect()
    },
  })
  const nameClaims = createNameClaims({ db })
  const transfers = createTransfers({ db, now })
  const operations = createOperations({
    db,
    now,
    legacy: { db: deps.database.scoped(WEB_STORAGE_PREFIX), scope: namespace.id },
    transfers,
  })
  const zkJwtProofs = createZkJwtProofs({ db, now })
  /** The account's address as this browser's passkey map records it, at the session's open. */
  const opened = () => {
    const { storageId, passkeyMap, credentialId } = deps.device.get()
    if (namespace.id === null || storageId !== namespace.id || !credentialId) return undefined
    return recordAddress(passkeyMap, deps.page.config.rpId, credentialId)
  }
  const identity = createIdentity({ db, legacy: deps.database, opened })
  const unresolvedSends = createUnresolvedSends({
    page: deps.database,
    namespace: namespace.prefix,
    // Older builds kept the hold under the page's root, by network and account.
    legacyKey: () => {
      const address = opened()?.toLowerCase()
      return address && `webwallet.deposit.unresolved-send.${deps.page.config.network}.${address}`
    },
  })
  let observer: SipaProcessingObserver | undefined
  /** Set once a route that needs the token and the TEE signer opens: both build after it. */
  const assetsWanted = memoryStore(false)
  const teeSigner = openTeeSigner(deps.teeSignerSource, assetsWanted.readonly)
  const accountRecord = signIn ? createAccountRecord({ db, now }) : null
  const contacts = signIn ? createContacts({ db, now }) : null
  const backupRotations = signIn ? createBackupRotations({ db }) : null
  const backupNudges = signIn && backupPasskeySettingsEnabled ? createBackupNudges({ db }) : null
  const savingsMoves = createSavingsMoves({ db })
  const receiveCodes = signIn ? createReceiveCodes({ db, legacy: deps.database }) : null
  const xmtpCursors = signIn ? createXmtpCursors({ db }) : null
  const xmtpInbox = signIn ? createXmtpInbox({ db }) : null
  const account: AccountService | null =
    signIn && accountRecord
      ? openAccount({
          wallet,
          contractService,
          accounts: accountRecord,
          auth: signIn.auth,
          handoff: signIn.handoff,
        })
      : null
  const token: Service<TokenService> | null =
    signIn && account
      ? openToken({
          wallet,
          account,
          contractService,
          teeSigner,
          when: assetsWanted.readonly,
          create: (wallet, account) => signIn.createToken(wallet, account),
        })
      : null
  /** The FPCs this session's sponsored flows owe a refuel check, by address. */
  const owedRefuels = memoryStore<ReadonlyMap<string, FpcRefuelTarget>>(new Map())
  return {
    deps,
    ended,
    db,
    wallet,
    contractService,
    transfers,
    operations,
    paylinks: createPaylinks({ db, transfers }),
    withdrawals,
    bridgeIns,
    sipaDeposits,
    registrations,
    nameClaims,
    zkJwtProofs,
    identity,
    unresolvedSends,
    /** Why each deposit waits for its sweep; undefined while L1 cannot be read. */
    sipaProcessingObserver: () => (observer ??= deps.sipaProcessingObserver?.(sipaDeposits.view)),
    notifications: createNotifications({ db, now }),
    savedPreviousAccount: createSavedPreviousAccount(db),
    milestones: createMilestones({ catchUp: deps.catchUp }),
    teeSigner,
    assetsWanted,
    accountRecord,
    contacts,
    backupRotations,
    backupNudges,
    savingsMoves,
    receiveCodes,
    xmtpCursors,
    xmtpInbox,
    owedClaims: createOwedClaims({ db }),
    withdrawFunnel: createWithdrawFunnel({ db }),
    burnDurations: createBurnDurations({ db }),
    rollup: deps.rollup,
    balanceStore,
    account,
    token,
    page: deps.page,
    subscriptionChecks: createSubscriptionChecks(deps.page.query),
    withdrawalTracker: withdrawalTracker({
      wallet,
      store: withdrawals,
      operations,
      rails: () => deps.page.chain.withdrawalRails().ready(),
      now,
    }),
    wake,
    auth: deps.auth,
    owedRefuels,
    /** Owes the FPC that sponsored a flow a refuel check; the refuel task runs it. */
    oweFpcRefuel(fpc: FpcRefuelTarget) {
      owedRefuels.set(new Map(owedRefuels.get()).set(fpc.address.toString(), fpc))
    },
  }
}

/** What `app/sessionTasks.ts` builds a session's features over. */
type Core = ReturnType<typeof openCore>
type Views = ReturnType<SessionFeatures["views"]>

/**
 * An open session: its stores, services and tasks, and the feature services over them, which
 * `app/sessionTasks.ts` declares. Deps a task builds take a `Pick` of it, which the core it is
 * built over satisfies.
 */
export interface Session
  extends Omit<Core, "deps" | "ended" | "rollup" | "sipaProcessingObserver" | "owedRefuels">,
    Pick<SessionDeps, "namespace" | "database" | "device" | "sessionLock" | "leaving"> {
  readonly network: Network
  readonly sipaProcessingObserver: SipaProcessingObserver | undefined
  tasks: Pick<Core, "withdrawalTracker"> & SessionFeatures["named"]
  readonly balances: Balances
  readonly mainToken: ReadonlyStore<Token | null>
  readonly requests: Views["requests"]
  readonly feedBase: Views["base"]
  readonly reads: Views["reads"]
  readonly homeRows: Views["homeRows"]
  readonly feed: Views["feed"]
  readonly contactActivity: Views["contactActivity"]
  readonly bell: Views["bell"]
  readonly accountHistory: Views["accountHistory"]
  close(): void
}

/** Builds a session from its deps; `switchSession` makes one current. */
export function openSession(deps: SessionDeps): Session {
  const { namespace, wallet, contractService } = deps
  const core = openCore(
    deps,
    (task) => runtime.wake(task),
    () => void runtime.wake(tasks.registrationDetection),
  )
  const { db, transfers, paylinks, withdrawals, sipaDeposits, notifications, milestones } = core
  const { teeSigner, accountRecord, account, token, withdrawalTracker: tracker } = core
  const activeToken = token
    ? derived([token], (s) =>
        s.status === "ready" ? s.value.tokenAddressOrNull?.toString() ?? null : null,
      )
    : memoryStore(null).readonly
  let balances: Balances | undefined
  const features = deps.features(core)
  const tasks = { withdrawalTracker: tracker, ...features.named }
  const runtime = startRuntime([tracker, ...features.tasks], {
    db,
    milestones,
    visible: deps.visible,
    pace: deps.page.pace,
    now: deps.page.now,
  })
  features.started()
  return {
    namespace,
    page: deps.page,
    /** The page's database, every namespace's. */
    database: deps.database,
    auth: deps.auth,
    device: deps.device,
    sessionLock: deps.sessionLock,
    leaving: deps.leaving,
    get network() {
      return deps.page.config.network
    },
    /** The account's database: a scan cursor kept here saves with the rows. */
    db,
    transfers,
    /** This namespace's user transactions. */
    operations: core.operations,
    subscriptionChecks: core.subscriptionChecks,
    /** The links this account made. */
    paylinks,
    /** A visitor's withdrawals stay in the anonymous namespace when it signs in. */
    withdrawals,
    /** Bridge-ins from other chains; the tracker follows them in every session. */
    bridgeIns: core.bridgeIns,
    /** The account's SIPA deposits; a page with no account files none. */
    sipaDeposits,
    /** The account's registrations, live and replaced; a page with no account files none. */
    registrations: core.registrations,
    /** The account's NameClaim artifacts. */
    nameClaims: core.nameClaims,
    /** The account's sealed zkJWT proofs for email-locked links. */
    zkJwtProofs: core.zkJwtProofs,
    /** The account's desktop deposit approved with no known hash, if one is held. */
    unresolvedSends: core.unresolvedSends,
    /** The account this namespace entered; the first render reads it loaded. */
    identity: core.identity,
    /** A rotated wallet's previous account as last found; the watcher saves it. */
    savedPreviousAccount: core.savedPreviousAccount,
    oweFpcRefuel: core.oweFpcRefuel,
    ...features.services,
    /** Why each deposit waits for its sweep; undefined while L1 cannot be read. */
    get sipaProcessingObserver() {
      return core.sipaProcessingObserver()
    },
    notifications,
    milestones,
    wallet,
    contractService,
    /** The withdrawal tracker and the reorg pass run in every session, a visitor's too; the scan in an account's. */
    tasks,
    withdrawalTracker: tracker,
    wake: (task: Task) => runtime.wake(task),
    /** The signed-in account's record; null for a visitor. */
    accountRecord,
    /** The account's contact book; a visitor has none. */
    contacts: core.contacts,
    /** The account's pending backup passkey rotations; a visitor has none. */
    backupRotations: core.backupRotations,
    /** When the account's nudges to add a backup passkey were put off; none without the add. */
    backupNudges: core.backupNudges,
    /** The account's Savings moves; a visitor's stays empty. */
    savingsMoves: core.savingsMoves,
    /** The account's Receive codes; a visitor has none. */
    receiveCodes: core.receiveCodes,
    /** The account's inbox cursors; a visitor has none. */
    xmtpCursors: core.xmtpCursors,
    /** The account's XMTP inboxes on this device; a visitor has none. */
    xmtpInbox: core.xmtpInbox,
    /** Link claims' `claimed` events still to send. */
    owedClaims: core.owedClaims,
    /** The withdraw funnel phases already reported. */
    withdrawFunnel: core.withdrawFunnel,
    /** How long this device's recent burns took to mine. */
    burnDurations: core.burnDurations,
    /** The account's last balance reads; a visitor has none. */
    balanceStore: core.balanceStore,
    /** Main's token once it is built; null before, and for a visitor. */
    mainToken: token
      ? derived([token], (s): Token | null => (s.status === "ready" ? s.value.metadata : null))
      : memoryStore<Token | null>(null).readonly,
    /** Null for a visitor. */
    account,
    /** Null for a visitor; built once a route that needs assets sets `assetsWanted`. */
    token,
    teeSigner,
    assetsWanted: core.assetsWanted,
    /** Main's balance: cached until the token is built, then live. */
    get balances() {
      return (balances ??= createBalances(
        core.balanceStore?.view ?? NO_RECORDS,
        {
          network: deps.page.config.network,
          account: accountRecord?.view ?? NOTHING_STORED,
          activeToken,
        },
        milestones.sync,
        deps.page.now,
      ))
    },
    get requests() {
      return features.views().requests
    },
    /** What every activity feed reads beside its rows. */
    get feedBase() {
      return features.views().base
    },
    /** Home's reads beside its window. */
    get reads() {
      return features.views().reads
    },
    /** Home's rows. */
    get homeRows() {
      return features.views().homeRows
    },
    /** Home's feed: the newest rows. */
    get feed() {
      return features.views().feed
    },
    get contactActivity() {
      return features.views().contactActivity
    },
    get bell() {
      return features.views().bell
    },
    /** Settings → Account history. */
    get accountHistory() {
      return features.views().accountHistory
    },
    /** Stops the session's tasks, watchers and services; its namespace stops hearing commits. */
    close: () => {
      runtime.stop()
      milestones.stop()
      features.close()
      token?.close()
      account?.close()
      teeSigner.close()
      core.ended.abort()
    },
  }
}

// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
const current = memoryStore<Session | null>(null)
/** The first account this page served: no other account's stores open before it reloads. */
// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
let pageAccount: string | undefined

/** The open session: null before boot opens one and once sign-out closes it. */
export const openedSession: ReadonlyStore<Session | null> = current.readonly

/** Whether the committed account is not the one this page served, so the page must reload. */
export function servesAnotherAccount(device: ReadonlyStore<DeviceState>): boolean {
  const id = device.get().storageId
  return id !== null && pageAccount !== undefined && id !== pageAccount
}

/** The session a switch makes current, and the open one it replaces when it opens one. */
type Switch = { next: Session; replaces?: Session | null }

function nextSession(
  namespace: Namespace,
  sessions: PageSessionDeps,
  handoff?: ObsidionAccount,
): Switch {
  const open = current.get()
  if (namespace.id !== null && (pageAccount ??= namespace.id) !== namespace.id) {
    console.error("[session] another account signed in on this page; it serves the first one")
    return open ? { next: open } : nextSession(namespaceOf(null), sessions)
  }
  // A hand-off over a record that failed to open gets a new session, which reads the save.
  const failed =
    handoff && open?.accountRecord?.view.get().failed && open.namespace.id === namespace.id
  if (open && !failed && (open.namespace.id === namespace.id || open.namespace.id !== null)) {
    if (handoff) open.account?.handOff(handoff)
    return { next: open }
  }
  return { next: openSession(sessions(namespace, handoff)), replaces: open }
}

/**
 * Makes the namespace's session current: at boot and from the demo seed. The same namespace keeps
 * the open session, which takes `handoff` as its account, unless its account record failed to
 * open; an open account's session stays until it closes. Another account's never opens on this
 * page: its sign-in reloads first, and reaching here instead is a bug. `sessions` builds the deps
 * of a session this opens.
 */
export function switchSession(
  namespace: Namespace,
  sessions: PageSessionDeps,
  handoff?: ObsidionAccount,
): Session {
  const { next, replaces } = nextSession(namespace, sessions, handoff)
  if (replaces === undefined) return next
  replaces?.close()
  current.set(next)
  return next
}

/**
 * Gives the account a sign-in built to the committed account's session, which it returns: a flow
 * that started in `session` carries on in that one.
 */
export const handOffAccount = (session: Session, account: ObsidionAccount): Session =>
  session.page.switchTo(activeNamespace(session.device), account)

/** Stops the open session's work for a page that is leaving; it stays current for the last render. */
export function stopSession(): void {
  current.get()?.close()
}

export function closeSession(): void {
  current.get()?.close()
  current.set(null)
}

/** Resolves once each store the first render reads has loaded or failed. */
export const sessionLoaded = async (open: Session): Promise<void> =>
  void (await Promise.allSettled([open.registrations.ready, open.identity.ready]))

/**
 * Follows each saved change of the session pointers: a sign-in, or a rejected key's removal. A
 * session it opens becomes current once its registrations and identity have loaded, so no reader
 * sees them unloaded; the replaced session's work stops at once.
 */
export async function followSavedSession(
  device: ReadonlyStore<DeviceState>,
  sessions: PageSessionDeps,
): Promise<void> {
  const namespace = activeNamespace(device)
  const open = current.get()
  const { next, replaces } =
    namespace.id === null && open && open.namespace.id !== null
      ? { next: openSession(sessions(namespace)), replaces: open }
      : nextSession(namespace, sessions)
  replaces?.close()
  await sessionLoaded(next)
  if (replaces === undefined) return
  // A switch that landed while this one loaded stands.
  if (current.get() !== replaces) return next.close()
  current.set(next)
}

/** What a commit takes from the session it starts in: the page's auth, pointers and switch. */
export type CommitScope = Pick<Session, "auth" | "device"> & { page: PageSessions }

/**
 * Commits a sign-in's secret, and hands back the committed namespace's session: the commit waits
 * for the page to follow its pointers, so that is the session it made current.
 */
export async function commitSecret(
  session: CommitScope,
  input: CommitSecretInput,
  stillOwns: () => boolean,
): Promise<{ generation: number; session: Session } | false> {
  const generation = await session.auth.commitSecret(input, stillOwns)
  if (generation === false) return false
  return { generation, session: session.page.switchTo(activeNamespace(session.device)) }
}

/** The open session's account record; none for a visitor or before a session opens. */
export const accountsOfSession = () => current.get()?.accountRecord ?? null

/**
 * The committed account's record. A sign-in commits before the page switches to it, so a commit
 * of another account than `session`'s writes to that account's own namespace.
 */
export function signedInAccount(
  session: Pick<Session, "device" | "namespace" | "accountRecord" | "database" | "page">,
): AccountRecord {
  const committed = activeNamespace(session.device)
  const record =
    session.namespace.prefix === committed.prefix
      ? session.accountRecord
      : committed.id === null
      ? null
      : createAccountRecord({
          db: session.database.scoped(committed.prefix),
          now: session.page.now,
        })
  if (!record) throw new WalletError("wallet.notReady", "no account session")
  return record
}

/** The open session; a view renders only once boot opens one. */
export function useSession(): Session {
  const open = useStore(current.readonly)
  if (!open) throw new WalletError("unknown", "no session is open")
  return open
}

export type ChainSession = Pick<Session, "wallet" | "contractService">

/** The page's wallet and contracts, once both are ready. */
export const chainOf = async (session: ChainSession, signal?: AbortSignal) => ({
  wallet: await session.wallet.ready(signal),
  contractService: await session.contractService.ready(signal),
})
export type Chain = Awaited<ReturnType<typeof chainOf>>

/** An account session's wallet, contracts and account, once each is ready. */
export async function signerKitOf(
  session: ChainSession & Pick<Session, "account">,
  signal?: AbortSignal,
) {
  if (!session.account) throw new WalletError("wallet.notReady", "no account session")
  return { ...(await chainOf(session, signal)), account: await session.account.ready(signal) }
}

/** An account session's wallet, contracts, account and token, once each is ready. */
export async function accountKitOf(session: ChainSession & Pick<Session, "account" | "token">) {
  if (!session.token) throw new WalletError("wallet.notReady", "no account session")
  return { ...(await signerKitOf(session)), tokenService: await session.token.ready() }
}
export type AccountKit = Awaited<ReturnType<typeof accountKitOf>>

/** Builds the session's token and TEE signer once `ready`; they stay up for the session. */
export function useStartAssets(ready: boolean): void {
  const { assetsWanted } = useSession()
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    if (ready) assetsWanted.set(true)
  }, [ready, assetsWanted])
}
