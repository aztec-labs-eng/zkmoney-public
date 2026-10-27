import { AccountState, Transaction, WebAuthnData } from "src/types"
import { assert } from "ts-essentials"
import { ACCOUNT_STORAGE_KEY } from "./constants"
import { globalEventEmitter } from "../services"
import { AUTH_TYPE } from "@obsidion/sdk"
import type { IStorageAdapter } from "./adapter"

/**
 * Single-account wallet storage.
 *
 * The wallet runs against a single account on a single network. The persisted
 * value is the raw `AccountState` JSON (or absent). Both prior layers — a
 * tuple-map of multi-account state and a per-network outer map — were
 * collapsed once the corresponding switch flows were retired.
 */
export class AccountStorage {
  private static instance: AccountStorage | null = null
  private storage: IStorageAdapter

  private constructor(storage: IStorageAdapter) {
    this.storage = storage
  }

  static get(storage?: IStorageAdapter): AccountStorage {
    if (!AccountStorage.instance) {
      if (!storage) {
        throw new Error("First call to getInstance requires parameter")
      }

      AccountStorage.instance = new AccountStorage(storage)
    }
    return AccountStorage.instance
  }

  private async loadAccount(): Promise<AccountState | undefined> {
    const raw = await this.storage.getItem(ACCOUNT_STORAGE_KEY)
    if (raw === null) return undefined

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.storage.removeItem(ACCOUNT_STORAGE_KEY)
      return undefined
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      await this.storage.removeItem(ACCOUNT_STORAGE_KEY)
      return undefined
    }

    const candidate = parsed as Record<string, unknown>
    if (
      typeof candidate.completeAddress !== "string" ||
      typeof candidate.name !== "string"
    ) {
      await this.storage.removeItem(ACCOUNT_STORAGE_KEY)
      return undefined
    }

    const skc = candidate.signKeyConfig
    if (
      skc === null ||
      typeof skc !== "object" ||
      typeof (skc as Record<string, unknown>).type !== "number" ||
      !Object.values(AUTH_TYPE).includes((skc as Record<string, unknown>).type as AUTH_TYPE)
    ) {
      await this.storage.removeItem(ACCOUNT_STORAGE_KEY)
      return undefined
    }

    const skcType = (skc as Record<string, unknown>).type as AUTH_TYPE
    if (skcType === AUTH_TYPE.WEB_AUTHN) {
      const wd = (skc as Record<string, unknown>).webauthnData
      if (
        wd === null ||
        typeof wd !== "object" ||
        typeof (wd as Record<string, unknown>).credentialId !== "string" ||
        typeof (wd as Record<string, unknown>).pubkey !== "string"
      ) {
        await this.storage.removeItem(ACCOUNT_STORAGE_KEY)
        return undefined
      }
    }

    delete (candidate as Record<string, unknown>).transactions
    return candidate as unknown as AccountState
  }

  /**
   * One-time migration helper: read the legacy `transactions[]` field off
   * the persisted account blob NON-DESTRUCTIVELY. Returns the array, or
   * `undefined` if there is nothing to migrate. The caller is expected to
   * persist these rows into the new transaction storage key first, then
   * call `stripLegacyTransactions()` to remove the field from the account
   * blob.
   *
   * Called by `TransactionStorage` on first load when its own key is empty.
   * Repeated calls return the same legacy rows until `stripLegacyTransactions`
   * runs.
   */
  public async consumeLegacyTransactions(): Promise<Transaction[] | undefined> {
    const raw = await this.storage.getItem(ACCOUNT_STORAGE_KEY)
    if (raw === null) return undefined

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined
    }

    const candidate = parsed as Record<string, unknown>
    if (!Array.isArray(candidate.transactions)) return undefined

    const legacy = candidate.transactions as Transaction[]
    return legacy
  }

  /**
   * Strip the legacy `transactions` field from the persisted account blob.
   * Caller must have already persisted the legacy rows into the new
   * transaction storage key. Splitting this from `consumeLegacyTransactions`
   * makes the migration atomic: the new key is written first, the old
   * field is stripped second.
   *
   * Failure semantics:
   * - If `consumeLegacyTransactions` rejects, no data has moved — the next
   *   load retries from the still-readable account blob.
   * - If the new-key write rejects, the migration gate clears and the next
   *   load retries from the still-readable account blob.
   * - If THIS strip rejects after the new-key write succeeded, the
   *   migration result is durable (new key has the rows). Later loads
   *   short-circuit on the now-non-null new key and do NOT retry strip;
   *   the legacy field on the account blob is harmless residue.
   */
  public async stripLegacyTransactions(): Promise<void> {
    const raw = await this.storage.getItem(ACCOUNT_STORAGE_KEY)
    if (raw === null) return

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return
    }

    const candidate = parsed as Record<string, unknown>
    if (!Array.isArray(candidate.transactions)) return

    delete candidate.transactions
    await this.storage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(candidate))
  }

  /** Returns the stored account, or `undefined` if none exists yet. */
  public async getAccount(): Promise<AccountState | undefined> {
    return this.loadAccount()
  }

  /** Returns whether an account is currently stored. */
  public async hasAccount(): Promise<boolean> {
    return (await this.getAccount()) !== undefined
  }

  /** Overwrite the stored account. */
  public async setAccount(accountState: AccountState): Promise<void> {
    await this.storage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountState))
  }

  /** Persist an update to the current account. Emits `emitAccountUpdated`. */
  public async updateAccount(accountState: AccountState): Promise<void> {
    const existing = await this.getAccount()
    assert(existing, "No account to update")
    assert(
      existing.completeAddress === accountState.completeAddress,
      "updateAccount cannot change completeAddress",
    )
    await this.setAccount(accountState)
    globalEventEmitter.emitAccountUpdated({ accountId: accountState.completeAddress })
  }

  /** Convenience: add a WebAuthn-backed account. */
  public async addWebauthnAccount(
    name: string,
    completeAddress: string,
    webauthnData: WebAuthnData,
  ): Promise<void> {
    await this.setAccount({
      name,
      completeAddress,
      signKeyConfig: {
        type: AUTH_TYPE.WEB_AUTHN,
        webauthnData,
      },
    })
  }

  public async getWebAuthnDataForCurrentAccount(): Promise<WebAuthnData | undefined> {
    const account = await this.getAccount()
    return account?.signKeyConfig.webauthnData
  }

  public async getAccountName(): Promise<string> {
    const account = await this.getAccount()
    assert(account, "No account selected")
    return account.name
  }
}
