import { installedCredentials } from "@obsidion/front-core"
import { type AccountKey, type SignInKeyChoice, signInKeyChoices } from "@obsidion/passkey-web"
import type { AccountPasskeys } from "../../platform/auth/WebAlphaAuthService"
import { type RememberedAccount, authenticatorFor } from "../../platform/auth/WebPasskeyIdentityMap"
import type { SignInHints } from "./oxideOnboarding"

/** What a tap pins the sign-in to: the tag's account and keys as L1 lists them, or a remembered credential. */
export type Found = {
  tag: string
  l2Address: string
  hints: SignInHints
  /** The L1 read found keys beyond the first; unset on a remembered account, which had no read. */
  moreKeys?: boolean
  /** The account's keys to choose between before any prompt; unset for a one-key account. */
  keys?: KeyOption[]
}

/** One key a sign-in may be pinned to, and the sign-in that names it alone. */
export type KeyOption = SignInKeyChoice & { target: Found }

/** A tag's account as its L1 read found it. */
export type AccountFound = Found & { hints: AccountPasskeys }

/** A sign-in pinned to a credential this browser holds an opening record for. */
export const recordTarget = (
  { tag, l2Address }: Pick<Found, "tag" | "l2Address">,
  credentialId: string,
): Found => ({ tag, l2Address, hints: { credentialId, chosen: true } })

/**
 * The choice among the keys a tag's read lists; none for a one-key account. Each option names only
 * its own credential, still matched against every key; on a remembered row, a key this browser
 * holds an opening record for is pinned by that record instead.
 */
export function keyOptions(
  map: string | null,
  found: AccountFound,
  recorded?: readonly AccountKey[],
): KeyOption[] | undefined {
  const installed = installedCredentials(found.hints.keys)
  const choices = signInKeyChoices(
    installed.map(({ credentialId, backup, key }) => {
      const known = authenticatorFor(map, key.pubkeyHex)
      return { credentialId, backup, aaguid: known?.prfAaguid, usedAt: known?.usedAt }
    }),
  )
  return choices?.map((choice) => {
    const { credentialId } = choice
    const target = recorded?.some((r) => r.credentialId === credentialId)
      ? recordTarget(found, credentialId)
      : { ...found, keys: undefined, hints: { ...found.hints, chosen: credentialId } }
    return { ...choice, target }
  })
}

/**
 * One row per wallet: records of one address list once, by the record naming the most keys and,
 * on a tie, the sign-up key's, so the row offers every key this browser knows for it.
 */
export function oneRowPerWallet(
  rows: RememberedAccount[],
  keyCount: (row: RememberedAccount) => number,
): RememberedAccount[] {
  const kept = new Map<string, { row: RememberedAccount; keys: number }>()
  for (const row of rows) {
    const address = row.l2Address.toLowerCase()
    const keys = keyCount(row)
    const held = kept.get(address)
    if (!held || keys > held.keys || (keys === held.keys && held.row.backup && !row.backup)) {
      kept.set(address, { row, keys })
    }
  }
  return rows.filter((row) => kept.get(row.l2Address.toLowerCase())?.row === row)
}
