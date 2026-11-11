/**
 * Whether a one-key record's wallet moved to a two-key account on this rollup (a backup passkey
 * added on another device): the check a cached session and a record-pinned sign-in run once the
 * tag's user record names another address than the record's.
 */
import type { Fr } from "@aztec-labs/aztec.js/fields"
import {
  MAX_PASSKEY_CANDIDATES,
  authKeyPubkeyHex,
  resolveOxideIdentity,
  type BoundedAuthKeys,
  type OxideIdentityDeps,
  type VerifiedOxideIdentity,
} from "@obsidion/front-core"
import { bestEffortSync } from "@obsidion/core/errors"
import { normalizePubkeyHex } from "@obsidion/sdk"
import type { Address } from "viem"
import { tabStash } from "../../platform/storage/tabStash"

export interface MovedAccountCheck {
  generations: OxideIdentityDeps
  /** This key's bootstrap address, which the generations' factories predict the account from. */
  bootstrap: Address
  /** The L1 account the unverified identity named. */
  accounts: readonly Address[]
  /** The record's key and set, as the sign-in anchored on them. */
  record: { pubkey: string; passkeySet?: readonly string[] }
  msk: Fr
  /** At most {@link MAX_PASSKEY_CANDIDATES} of the account's installed keys, with its total count. */
  readAuthKeys: (account: Address) => Promise<BoundedAuthKeys>
  /** The address `msk` derives under a key set, in the string form the anchors compare. */
  derive: (msk: Fr, passkeys: readonly string[]) => Promise<string>
}

/** The two-key account the wallet moved to: its verified identity, its key set and its address. */
export interface MovedAccount {
  identity: VerifiedOxideIdentity
  passkeys: readonly string[]
  address: string
}

export const sameAddress = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

/**
 * The move, or undefined for every other shape: a record set that is not its key alone, a list that
 * is not exactly two distinct keys holding that key, a read short of the account's count or with a
 * key that is not 64 bytes, or a derived address the user record does not name on this rollup.
 * Read failures propagate.
 */
export async function movedAccount(check: MovedAccountCheck): Promise<MovedAccount | undefined> {
  const own = normalizePubkeyHex(check.record.pubkey)
  const set = (check.record.passkeySet ?? [own]).map(normalizePubkeyHex)
  if (check.accounts.length !== 1 || set.length !== 1 || set[0] !== own) return undefined
  const [account] = check.accounts
  const { entries, authKeyCount } = await check.readAuthKeys(account)
  const listed = entries.slice(0, MAX_PASSKEY_CANDIDATES)
  if (authKeyCount > listed.length) return undefined
  const keys: string[] = []
  for (const entry of listed) {
    const key = authKeyPubkeyHex(entry)
    if (!key) return undefined
    if (!keys.includes(key)) keys.push(key)
  }
  if (keys.length !== 2 || !keys.includes(own)) return undefined
  const address = await check.derive(check.msk, keys)
  // The current rollup alone: a retired rollup's record derives another address from the same keys.
  const outcome = await resolveOxideIdentity(
    { ...check.generations, admissibleRollupVersions: new Set([check.generations.rollupVersion]) },
    check.bootstrap,
    address,
  )
  if (outcome.kind !== "verified" || !sameAddress(outcome.identity.account, account))
    return undefined
  return { identity: outcome.identity, passkeys: keys, address }
}

const MARK = "zkm.once.movedAccount"

/** Leaves the reloaded page the account the wallet moved to; a tab without storage shows no line. */
export function markMovedAccount(address: string): void {
  bestEffortSync(() => tabStash.set(MARK, address), undefined)
}

/** The account the mark names; undefined without one, or without storage. */
export function movedAccountMark(): string | undefined {
  return bestEffortSync(() => tabStash.get(MARK) ?? undefined, undefined)
}

export function clearMovedAccountMark(): void {
  bestEffortSync(() => tabStash.remove(MARK), undefined)
}
