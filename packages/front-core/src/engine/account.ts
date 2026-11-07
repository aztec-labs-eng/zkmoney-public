import { CompleteAddress } from "@aztec-labs/stdlib/contract"
import type {
  AlphaAuthService,
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
} from "@obsidion/sdk"
import { AUTH_TYPE } from "@obsidion/sdk"
import { ACCOUNT_STORAGE_KEY } from "../core/storages/constants"
import type { AccountState } from "../types"
import type { Database, Write } from "./database"
import type { Sourced } from "./legacyStore"
import { encodeRecord, persistentStore } from "./persistentStore"
import { WalletError } from "./errors"
import { resource, type Resource, type ResourceState } from "./resource"
import { derived, memoryStore, type ReadonlyStore } from "./store"

export interface AccountDeps {
  wallet: Resource<ObsidionWallet>
  /** The unlock derives the account's address through it. */
  contractService: Resource<ContractService>
  accounts: Pick<AccountRecord, "get">
  auth(wallet: ObsidionWallet): AlphaAuthService
  /** The account a sign-in just built: the unlock returns it. */
  handoff?: ObsidionAccount
}

export interface AccountResource extends Resource<ObsidionAccount> {
  /** Installs the account a sign-in built in place of the unlocked one. */
  handOff(account: ObsidionAccount): void
}

/**
 * The unlocked account: the stored account over the cached master key, with no prompt. It stays
 * pending with no stored account; a missing key or a failed unlock waits for `retry`.
 */
export function accountResource(deps: AccountDeps): AccountResource {
  const handed = memoryStore(deps.handoff)
  const unlocked = resource(
    "account",
    { from: [deps.wallet, deps.contractService], backoff: "manual" },
    ([wallet]) => Promise.resolve(handed.get() ?? unlock(wallet, deps)),
  )
  const state = derived(
    [unlocked, handed],
    (s, account): ResourceState<ObsidionAccount> =>
      account ? { status: "ready", value: account } : s,
  )
  return {
    ...state,
    name: unlocked.name,
    demand: unlocked.demand,
    retry: unlocked.retry,
    close: unlocked.close,
    handOff: (account) => handed.set(account),
  }
}

async function unlock(wallet: ObsidionWallet, deps: AccountDeps) {
  const stored = await deps.accounts.get()
  if (!stored) return undefined
  const service = deps.auth(wallet)
  const authProvider = await service.getAuthProvider()
  if (!authProvider) return undefined
  const secretKey = await service.getSecretKey()
  if (!secretKey) throw new WalletError("account.unlockFailed")

  return wallet.getObsidionAccountWallet(secretKey, authProvider, {
    completeAddress: await CompleteAddress.fromString(stored.completeAddress),
    register: true,
  })
}

/** The account this namespace signed in to, at `acct/account/current`. */
export interface AccountRecord {
  /** `failed` while the store cannot be read: the account is unknown, never absent. */
  readonly view: ReadonlyStore<Sourced<AccountState | undefined> & { failed: boolean }>
  get(w?: Write): Promise<AccountState | undefined>
  save(state: AccountState): Promise<void>
  /** Marks the account entered, in one write: true for the call that marked it. */
  firstEntry(): Promise<boolean>
}

const CURRENT = "current"
const KEY = `acct/account/${CURRENT}`
/** One per address, written by older builds on the wallet's first entry. */
const ENTERED_PREFIX = "onboarding.walletEntered:"

/**
 * Version 1 carries the legacy blob, minus the `name` it no longer reads, and an older build's
 * entry mark. A blob that is not an account fails the open and keeps its bytes: an empty store
 * would send its user to onboarding. A sign-in's save writes a replacement, which the next open
 * keeps.
 */
export function createAccountRecord({ db }: { db: Database }): AccountRecord {
  const open = () => {
    const store = persistentStore<AccountState>(db, {
      prefix: "acct/account",
      version: 1,
      id: () => CURRENT,
      load: "all",
      async migrate(from, w) {
        if (from !== undefined)
          throw new WalletError("invariant", `account: unknown version ${from}`)
        const raw = await w.get(ACCOUNT_STORAGE_KEY)
        if (raw === undefined || (await w.get(KEY)) !== undefined) return
        const legacy = parseAccountState(raw)
        if (!legacy) throw new WalletError("unknown", "account: the saved account is not one")
        const entered = (await db.range(ENTERED_PREFIX, { limit: 1 })).length > 0
        w.put(KEY, encodeRecord(entered ? { ...legacy, enteredAt: 0 } : legacy))
      },
    })
    const view = derived([store.view], ({ records, loaded, failed }) => ({
      value: records[0],
      loaded,
      failed,
    }))
    return { store, view }
  }
  // A replacement saved over a failed open opens the store again, so its reads and view load.
  const opened = memoryStore(open())
  const store = () => opened.get().store
  return {
    view: {
      get: () => opened.get().view.get(),
      subscribe(listener) {
        let off = opened.get().view.subscribe(listener)
        const offOpened = opened.subscribe(() => {
          off()
          off = opened.get().view.subscribe(listener)
          listener()
        })
        return () => {
          offOpened()
          off()
        }
      },
    },
    get: (w) => store().get(CURRENT, w),
    // One namespace holds one account, so a save keeps its entry mark.
    save: async (state) => {
      const failed = await store().ready.then(
        () => undefined,
        (error: unknown) => ({ error }),
      )
      if (!failed)
        return void (await store().apply(CURRENT, (s) => ({ enteredAt: s?.enteredAt, ...state })))
      // Only an unreadable blob leaves no record; a newer build's record stays.
      await db.write(async (w) => {
        if ((await w.get(KEY)) !== undefined) throw failed.error
        w.put(KEY, encodeRecord(state))
      })
      opened.set(open())
      await store().ready
    },
    firstEntry: async () => {
      await store().ready
      return db.write(async (w) => {
        const current = await store().get(CURRENT, w)
        if (!current || current.enteredAt !== undefined) return false
        await store().put({ ...current, enteredAt: Date.now() }, w)
        return true
      })
    },
  }
}

/** A saved account blob, or undefined when it is not one. */
function parseAccountState(raw: string): AccountState | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return undefined
    const { completeAddress, signKeyConfig } = parsed as Record<string, unknown>
    const config = signKeyConfig as Record<string, unknown> | null | undefined
    if (typeof completeAddress !== "string" || !config || typeof config !== "object")
      return undefined
    if (!Object.values(AUTH_TYPE).includes(config.type as AUTH_TYPE)) return undefined
    const webauthn = config.webauthnData as Record<string, unknown> | null | undefined
    if (
      config.type === AUTH_TYPE.WEB_AUTHN &&
      (typeof webauthn?.credentialId !== "string" || typeof webauthn.pubkey !== "string")
    )
      return undefined
    return { completeAddress, signKeyConfig } as AccountState
  } catch {
    return undefined
  }
}
