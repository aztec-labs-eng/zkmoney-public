/**
 * The account's stores, resources and tasks, built once per page and handed down by `useSession`. A
 * page serves one account: another account's sign-in reloads the page (`reloadIfSessionSwitched`),
 * so nothing here follows an account change. A page with no account, such as a link's visitor, runs on
 * the anonymous namespace until its first sign-in replaces it; its views and their watchers start
 * only once something reads them.
 */
import {
  WalletError,
  accountResource,
  createAccountRecord,
  createIdentity,
  type AccountRecord,
  createActivity,
  createBalances,
  createMilestones,
  createNotifications,
  createNameClaims,
  createRegistrations,
  createSipaDeposits,
  createWithdrawals,
  derived,
  memoryStore,
  startRuntime,
  teeSignerResource,
  tokenResource,
  useStore,
  withdrawalTracker,
  type AccountResource,
  type Balances,
  type BalanceSource,
  type BalanceStorage,
  type CatchUp,
  type ContactStorage,
  type Database,
  type OperationStore,
  type PendingRegistrationRecord,
  type RegistrationChange,
  type ReadonlyStore,
  type Store,
  type RecordSet,
  type SipaDeposit,
  type Resource,
  type Runtime,
  type BroadcastExecutors,
  type SipaBroadcastsDeps,
  type SipaProcessingObserver,
  type Task,
  type TeeSignerSource,
  type TokenStorage,
  type TrackerRails,
  type Withdrawals,
} from "@obsidion/front-core"
import type {
  AlphaAuthService,
  CommitSecretInput,
  ContractService,
  Network,
  ObsidionAccount,
  ObsidionWallet,
  TokenService,
} from "@obsidion/sdk"
import { useEffect } from "react"
import { getConfig } from "../config/env"
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

/** What an account's session reads beside what every session does. */
export interface SignInDeps {
  storageId: string
  balances: BalanceStorage
  tokens: TokenStorage
  contacts: ContactStorage
  auth(wallet: ObsidionWallet): AlphaAuthService
  createToken(wallet: ObsidionWallet, account: ObsidionAccount): Promise<TokenService>
  /** The account a sign-in just built: the unlock returns it. */
  handoff?: ObsidionAccount
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
  wallet: Resource<ObsidionWallet>
  /** The page's, over `wallet`. */
  contractService: Resource<ContractService>
  visible: ReadonlyStore<boolean>
  network: Network
  /** Keys the scan's cursor to a non-default node endpoint. */
  endpointScope: string | undefined
  catchUp: CatchUp
  teeSignerSource: TeeSignerSource
  operations: OperationStore
  /** When this tab became the active one: the interrupted-operations sweep ends what started before. */
  readonly activeSince: number
  withdrawalRails(): Promise<TrackerRails | null>
  /** Why the account's deposits wait for their sweeps; undefined while it cannot read L1. */
  sipaProcessingObserver?(
    deposits: ReadonlyStore<RecordSet<SipaDeposit>>,
  ): SipaProcessingObserver | undefined
  broadcasts: BroadcastDeps
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
  /** The feature tasks, services and views over the session's core (`app/sessionTasks.ts`). */
  features(core: SessionCore): SessionFeatures
  /** Builds the deps of the next session this page opens. */
  page: PageSessionDeps
}

/** The deps of this page's session for a namespace: `app/sessionDeps.ts` builds them. */
export type PageSessionDeps = (namespace: Namespace, handoff?: ObsidionAccount) => SessionDeps

/**
 * `app/sessionTasks.ts` adds its builder's result here as `features`, so `session/` names that type
 * without importing `app/`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an augmentation target
export interface SessionParts {}
type SessionFeatures = SessionParts extends { features: infer F } ? F : never

/**
 * The page's side of the broadcasts task: who sends each kind but a registration, which the
 * session sends over its own stores, and the one-proof gate.
 */
export type BroadcastDeps = Pick<
  SipaBroadcastsDeps<ObsidionWallet>,
  "runExclusive" | "busy" | "describe"
> & {
  executors(wallet: ObsidionWallet): Omit<BroadcastExecutors, "registration">
  /** Fires when a proof the task waited on ends. */
  onIdle(listener: () => void): () => void
}

const NO_BALANCES: BalanceSource = {
  load: async () => {},
  list: () => [],
  onListChanged: () => () => {},
}
const NOTHING_STORED = memoryStore({ value: undefined, loaded: true }).readonly
const NO_ROWS = memoryStore({ value: [], loaded: true }).readonly

/**
 * What a session builds before its features: its stores, resources and milestones. `detect` wakes
 * registration detection: a record opened, or its address showed its first funds.
 */
function openCore(deps: SessionDeps, wake: Runtime["wake"], detect: () => void) {
  const { namespace, wallet, contractService, signIn } = deps
  const ended = new AbortController()
  const db = deps.database.scoped(namespace.prefix, ended.signal)
  const withdrawals = createWithdrawals({ db })
  const sipaDeposits = createSipaDeposits({
    db,
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
    legacy: deps.database,
    deposits: sipaDeposits,
    account: namespace.id !== null,
    committed(changes) {
      deps.registrationCommitted?.(changes)
      if (changes.some(({ first }) => first.includes("startTime"))) detect()
    },
  })
  const nameClaims = createNameClaims({ db })
  const identity = createIdentity({
    db,
    legacy: deps.database,
    opened: () => {
      const { storageId, passkeyMap, credentialId } = deps.device.get()
      if (namespace.id === null || storageId !== namespace.id || !credentialId) return undefined
      return recordAddress(passkeyMap, getConfig().rpId, credentialId)
    },
  })
  let observer: SipaProcessingObserver | undefined
  const teeSigner = teeSignerResource(deps.teeSignerSource)
  const accountRecord = signIn ? createAccountRecord({ db }) : null
  const account: AccountResource | null =
    signIn && accountRecord
      ? accountResource({
          wallet,
          contractService,
          accounts: accountRecord,
          auth: signIn.auth,
          handoff: signIn.handoff,
        })
      : null
  const token: Resource<TokenService> | null =
    signIn && account
      ? tokenResource({ wallet, account, contractService, teeSigner, create: signIn.createToken })
      : null
  return {
    deps,
    ended,
    db,
    activity: createActivity({ db }),
    withdrawals,
    sipaDeposits,
    registrations,
    nameClaims,
    identity,
    /** Why each deposit waits for its sweep; undefined while L1 cannot be read. */
    sipaProcessingObserver: () => (observer ??= deps.sipaProcessingObserver?.(sipaDeposits.view)),
    notifications: createNotifications(db),
    milestones: createMilestones({ catchUp: deps.catchUp }),
    teeSigner,
    accountRecord,
    account,
    token,
    withdrawalTracker: withdrawalTracker({
      wallet,
      store: withdrawals,
      rails: deps.withdrawalRails,
    }),
    wake,
  }
}

/** What `app/sessionTasks.ts` builds a session's features over. */
export type SessionCore = ReturnType<typeof openCore>

/** Builds a session from its deps; `switchSession` makes one current. */
export function openSession(deps: SessionDeps) {
  const { namespace, wallet, contractService, signIn } = deps
  const core = openCore(
    deps,
    (task) => runtime.wake(task),
    () => void runtime.wake(tasks.registrationDetection),
  )
  const { db, activity, withdrawals, sipaDeposits, notifications, milestones } = core
  const { teeSigner, accountRecord, account, token, withdrawalTracker: tracker } = core
  let balances: Balances | undefined
  const features = deps.features(core)
  const tasks = { withdrawalTracker: tracker, ...features.named }
  const runtime = startRuntime([tracker, ...features.tasks], {
    db,
    milestones,
    visible: deps.visible,
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
      return deps.network
    },
    /** The account's database: a scan cursor kept here saves with the rows. */
    db,
    activity,
    /** A visitor's withdrawals stay in the anonymous namespace when it signs in. */
    withdrawals,
    /** The account's SIPA deposits; a page with no account files none. */
    sipaDeposits,
    /** The account's registrations, live and replaced; a page with no account files none. */
    registrations: core.registrations,
    /** The account's NameClaim artifacts. */
    nameClaims: core.nameClaims,
    /** The account this namespace entered; the first render reads it loaded. */
    identity: core.identity,
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
    wake: (task: Task) => runtime.wake(task),
    /** The signed-in account's record; null for a visitor. */
    accountRecord,
    /** Null for a visitor. */
    account,
    /** Null for a visitor; built once a route that needs assets demands it. */
    token,
    teeSigner,
    /** Main's balance: cached until the token is built, then live. */
    get balances() {
      return (balances ??= createBalances(
        signIn?.balances ?? NO_BALANCES,
        {
          network: deps.network,
          account: accountRecord?.view ?? NOTHING_STORED,
          tokens: signIn?.tokens.rows ?? NO_ROWS,
          activeToken: token
            ? derived([token], (s) =>
                s.status === "ready" ? s.value.tokenAddressOrNull?.toString() ?? null : null,
              )
            : memoryStore(null).readonly,
        },
        milestones.sync,
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
    /** Stops the session's tasks, watchers and resources; its namespace stops hearing commits. */
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

export type Session = ReturnType<typeof openSession>

const current = memoryStore<Session | null>(null)
/** The first account this page served: no other account's stores open before it reloads. */
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
  page: PageSessionDeps,
  handoff?: ObsidionAccount,
): Switch {
  const open = current.get()
  if (namespace.id !== null && (pageAccount ??= namespace.id) !== namespace.id) {
    console.error("[session] another account signed in on this page; it serves the first one")
    return open ? { next: open } : nextSession(namespaceOf(null), page)
  }
  if (open && (open.namespace.id === namespace.id || open.namespace.id !== null)) {
    if (handoff) open.account?.handOff(handoff)
    return { next: open }
  }
  return { next: openSession(page(namespace, handoff)), replaces: open }
}

/**
 * Makes the namespace's session current: at boot and from the demo seed. The same namespace keeps
 * the open session, which takes `handoff` as its account; an open account's session stays until
 * it closes. Another account's never opens on this page: its sign-in reloads first, and reaching
 * here instead is a bug. `page` builds the deps of a session this opens.
 */
export function switchSession(
  namespace: Namespace,
  page: PageSessionDeps,
  handoff?: ObsidionAccount,
): Session {
  const { next, replaces } = nextSession(namespace, page, handoff)
  if (replaces === undefined) return next
  replaces?.close()
  current.set(next)
  return next
}

/** Gives the account a sign-in built to the committed account's session, which it returns. */
export function handOffAccount(account: ObsidionAccount): Session {
  const open = session()
  return switchSession(activeNamespace(open.device), open.page, account)
}

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
  page: PageSessionDeps,
): Promise<void> {
  const namespace = activeNamespace(device)
  const open = current.get()
  const { next, replaces } =
    namespace.id === null && open && open.namespace.id !== null
      ? { next: openSession(page(namespace)), replaces: open }
      : nextSession(namespace, page)
  replaces?.close()
  await sessionLoaded(next)
  if (replaces === undefined) return
  // A switch that landed while this one loaded stands.
  if (current.get() !== replaces) return next.close()
  current.set(next)
}

function opened(open: Session | null): Session {
  if (!open) throw new WalletError("unknown", "no session is open")
  return open
}

export const session = (): Session => opened(current.get())

/** Commits a sign-in's secret, and hands back the session the commit made current. */
export async function commitSecret(
  auth: WebAlphaAuthService,
  input: CommitSecretInput,
  stillOwns: () => boolean,
): Promise<{ generation: number; own: Session } | false> {
  const generation = await auth.commitSecret(input, stillOwns)
  return generation === false ? false : { generation, own: opened(current.get()) }
}

/** The open session's account record; none for a visitor or before a session opens. */
export const accountsOfSession = () => current.get()?.accountRecord ?? null

/**
 * The committed account's record. A sign-in commits before the page switches to it, so a commit
 * of another account than the open session's writes to that account's own namespace.
 */
export function signedInAccount(): AccountRecord {
  const open = session()
  const committed = activeNamespace(open.device)
  const record =
    open.namespace.prefix === committed.prefix
      ? open.accountRecord
      : committed.id === null
      ? null
      : createAccountRecord({ db: open.database.scoped(committed.prefix) })
  if (!record) throw new WalletError("wallet.notReady", "no account session")
  return record
}

export const useSession = (): Session => opened(useStore(current.readonly))

/** Starts the session's token and TEE signer once `ready`; they stay up for the session. */
export function useAssetDemand(ready: boolean): void {
  const { token, teeSigner } = useSession()
  useEffect(() => {
    if (!ready) return
    token?.demand()
    teeSigner.demand()
  }, [ready, token, teeSigner])
}
