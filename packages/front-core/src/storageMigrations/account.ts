/**
 * Storage migration: the account blob and entry mark older builds kept. Remove when no supported
 * build older than the one that writes `acct/account` v1 remains.
 */
import { AUTH_TYPE } from "@obsidion/sdk"
import { ACCOUNT_STORAGE_KEY } from "../core/storages/constants"
import type { AccountState } from "../types"
import type { Database, Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { encodeRecord } from "../engine/persistentStore"

/** One per address, written by older builds on the wallet's first entry. */
const ENTERED_PREFIX = "onboarding.walletEntered:"

/**
 * Version 1 carries the legacy blob, minus the `name` it no longer reads, and an older build's
 * entry mark. A blob that is not an account fails the open and keeps its bytes: an empty store
 * would send its user to onboarding.
 */
export async function migrateAccount(
  from: number | undefined,
  w: Write,
  { db, key }: { db: Database; key: string },
): Promise<void> {
  if (from !== undefined) throw new WalletError("invariant", `account: unknown version ${from}`)
  const raw = await w.get(ACCOUNT_STORAGE_KEY)
  if (raw === undefined || (await w.get(key)) !== undefined) return
  const legacy = parseAccountState(raw)
  if (!legacy) throw new WalletError("unknown", "account: the saved account is not one")
  const entered = (await db.range(ENTERED_PREFIX, { limit: 1 })).length > 0
  w.put(key, encodeRecord(entered ? { ...legacy, enteredAt: 0 } : legacy))
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
