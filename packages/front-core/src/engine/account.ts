import { CompleteAddress } from "@aztec-labs/stdlib/contract"
import {
  AUTH_TYPE,
  type AlphaAuthService,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import type { AccountState, WebAuthnData } from "../types"
import type { Database, Write } from "./database"
import type { Sourced } from "./legacyStore"
import { encodeRecord, persistentStore } from "./persistentStore"
import { WalletError } from "./errors"
import { readyOf, service, type Service, type ServiceState } from "./service"
import { derived, memoryStore, type ReadonlyStore } from "./store"
import { migrateAccount } from "../storageMigrations/account"

export interface AccountDeps {
  wallet: Service<ObsidionWallet>
  /** The unlock derives the account's address through it. */
  contractService: Service<ContractService>
  accounts: Pick<AccountRecord, "get">
  auth(wallet: ObsidionWallet): AlphaAuthService
  /** The account a sign-in just built: the unlock returns it. */
  handoff?: ObsidionAccount
}

export interface AccountService extends Service<ObsidionAccount> {
  /** Installs the account a sign-in built in place of the unlocked one. */
  handOff(account: ObsidionAccount): void
}

/**
 * The unlocked account: the stored account over the cached master key, with no prompt. It stays
 * pending with no stored account; a missing key or a failed unlock waits for `retry`.
 */
export function openAccount(deps: AccountDeps): AccountService {
  const handed = memoryStore(deps.handoff)
  const unlocked = service(
    "account",
    { from: [deps.wallet, deps.contractService], retry: "manual" },
    async ([wallet]) => handed.get() ?? (await unlock(wallet, deps)) ?? null,
  )
  const state = derived(
    [unlocked, handed],
    (s, account): ServiceState<ObsidionAccount> =>
      account
        ? { status: "ready", value: account }
        : s.status === "ready"
        ? s.value
          ? { status: "ready", value: s.value }
          : { status: "pending" }
        : s,
  )
  return {
    ...state,
    name: unlocked.name,
    ready: (signal) => readyOf(state, unlocked.name, signal),
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

/** What changes the account record. */
export type AccountEvent =
  /** A sign-in or signup saved the passkey account it opened. */
  | { type: "saved"; completeAddress: string; signer: WebAuthnData }
  /** A backup passkey moved the account to `completeAddress`; a stored signer stays. */
  | { type: "moved"; completeAddress: string; signer: WebAuthnData }
  /** Another passkey of the wallet signs for the account. */
  | { type: "signerReplaced"; signer: WebAuthnData }
  /** The wallet was entered; only the first entry marks the record. */
  | { type: "entered" }

/** The record after `event`, or undefined when the event leaves it as it is. */
export function accountTransition(
  record: AccountState | undefined,
  event: AccountEvent,
  now: number,
): AccountState | undefined {
  switch (event.type) {
    // One namespace holds one account, so a save keeps its entry mark.
    case "saved":
    case "moved": {
      const stored = event.type === "moved" ? record?.signKeyConfig.webauthnData : undefined
      return {
        completeAddress: event.completeAddress,
        signKeyConfig: { type: AUTH_TYPE.WEB_AUTHN, webauthnData: stored ?? event.signer },
        enteredAt: record?.enteredAt,
      }
    }
    case "signerReplaced":
      if (record?.signKeyConfig.type !== AUTH_TYPE.WEB_AUTHN) return undefined
      return { ...record, signKeyConfig: { ...record.signKeyConfig, webauthnData: event.signer } }
    case "entered":
      if (!record || record.enteredAt !== undefined) return undefined
      return { ...record, enteredAt: now }
  }
}

/** The account this namespace signed in to, at `acct/account/current`. */
export interface AccountRecord {
  /** `failed` while the store cannot be read: the account is unknown, never absent. */
  readonly view: ReadonlyStore<Sourced<AccountState | undefined> & { failed: boolean }>
  /** Settles once the store opened; a caller's write joins the record only after it. */
  readonly ready: Promise<void>
  get(w?: Write): Promise<AccountState | undefined>
  /**
   * The record `event` changed, in one write, or in `w` when the caller opened one on this
   * record's database; undefined when it changed nothing.
   */
  apply(event: AccountEvent, w?: Write): Promise<AccountState | undefined>
}

const CURRENT = "current"
const KEY = `acct/account/${CURRENT}`

/**
 * A failed open stays failed. A sign-in's save over an unreadable blob writes a replacement, which
 * the next session's open reads.
 */
export function createAccountRecord({
  db,
  now,
}: {
  db: Database
  now: () => number
}): AccountRecord {
  const store = persistentStore<AccountState>(db, {
    prefix: "acct/account",
    version: 1,
    id: () => CURRENT,
    load: "all",
    migrate: (from, w) => migrateAccount(from, w, { db, key: KEY }),
  })
  return {
    view: derived([store.view], ({ records, loaded, failed }) => ({
      value: records[0],
      loaded,
      failed,
    })),
    ready: store.ready,
    get: (w) => store.get(CURRENT, w),
    apply: async (event, w) => {
      const change = (s: AccountState | undefined) => accountTransition(s, event, now())
      if (w) return store.apply(CURRENT, change, w)
      const failed = await store.ready.then(
        () => undefined,
        (error: unknown) => ({ error }),
      )
      if (!failed) return store.apply(CURRENT, change)
      if (event.type !== "saved") throw failed.error
      const replacement = accountTransition(undefined, event, now())
      // Only an unreadable blob leaves no record; a newer build's record stays.
      await db.write(async (at) => {
        if ((await at.get(KEY)) !== undefined) throw failed.error
        at.put(KEY, encodeRecord(replacement))
      })
      return replacement
    },
  }
}
