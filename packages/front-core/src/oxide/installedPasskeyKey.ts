import type { Address } from "viem"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"

import { deriveBootstrapKey, type FieldLike } from "./oxideAccountKeys"
import { isZeroHash } from "./oxideIdentityGeneration"
import type { OxideL1Reader } from "./oxideRegistration"
import { MAX_PASSKEY_CANDIDATES, authKeyPubkeyHex } from "./passkeyCredentialByTag"

const normalized = (hex: string) => hex.replace(/^0x/i, "").toLowerCase()

export type InstalledKeyOutcome =
  /** Exactly one key, on one account: the key and every key that account installed, in L1 order. */
  | { kind: "found"; pubkeyHex: string; passkeys: readonly string[] }
  /** No inspected account holds a possible key. */
  | { kind: "none" }
  /** Several accounts, or both possible keys on one, so no single set can be derived with. */
  | { kind: "ambiguous" }
  /** The holding account has more keys than were read, or a key that is not 64 bytes. */
  | { kind: "incomplete" }

/**
 * Which of a sign-in signature's two possible public keys is the passkey's, read from the L1
 * accounts its master-key candidates predict: registration installs the passkey's key there. Only
 * an account the trusted registry names is read, since anyone can put code at a predicted address.
 * The key comes back with the account's whole key set, which derives the address. It only picks
 * between keys the signature already produced; the anchors still decide the account. `stop` ends
 * the read before its next step. RPC failures propagate.
 */
export async function readInstalledPasskeyKey(
  masterKeys: readonly FieldLike[],
  pubkeyCandidates: readonly string[],
  deps: {
    reader: Pick<OxideL1Reader, "readNameOf" | "getCode" | "readAuthKeysCounted">
    registry: Address
    accountFactories: readonly Address[]
    stop?: AbortSignal
  },
): Promise<InstalledKeyOutcome> {
  const wanted = new Set(pubkeyCandidates.map(normalized))
  const throwIfStopped = () => {
    if (deps.stop?.aborted) throw new Error("installed passkey key read stopped")
  }
  type Holding = { matched: string[]; passkeys: string[]; incomplete: boolean }
  const installedAt = async (
    accountFactory: Address,
    msk: FieldLike,
  ): Promise<Holding | undefined> => {
    throwIfStopped()
    const account = predictAccountAddressLocally(accountFactory, deriveBootstrapKey(msk).address)
    const nameHash = await deps.reader.readNameOf(deps.registry, account)
    if (isZeroHash(nameHash)) return undefined
    throwIfStopped()
    const code = await deps.reader.getCode(account)
    if (!code || code === "0x") return undefined
    throwIfStopped()
    const { entries, authKeyCount } = await deps.reader.readAuthKeysCounted(
      account,
      MAX_PASSKEY_CANDIDATES,
    )
    const read = entries.slice(0, MAX_PASSKEY_CANDIDATES)
    const keyed = read.map(authKeyPubkeyHex).filter((hex): hex is string => hex !== undefined)
    // L1 may list a key twice; the set holds it once.
    const passkeys = [...new Set(keyed)]
    const matched = passkeys.filter((hex) => wanted.has(hex))
    if (matched.length === 0) return undefined
    return {
      matched,
      passkeys,
      incomplete: authKeyCount > read.length || keyed.length < read.length,
    }
  }
  const reads = deps.accountFactories.flatMap((accountFactory) =>
    masterKeys.map((msk) => installedAt(accountFactory, msk)),
  )
  const holdings = (await Promise.all(reads)).filter((h): h is Holding => h !== undefined)
  if (holdings.length === 0) return { kind: "none" }
  // Two accounts naming the same key with the same set are one answer; any other pair is two.
  const distinct = new Set(
    holdings.map((h) => `${h.matched.join(",")}|${[...h.passkeys].sort().join(",")}`),
  )
  if (distinct.size > 1 || holdings[0]!.matched.length > 1) return { kind: "ambiguous" }
  if (holdings.some((h) => h.incomplete)) return { kind: "incomplete" }
  return { kind: "found", pubkeyHex: holdings[0]!.matched[0]!, passkeys: holdings[0]!.passkeys }
}
