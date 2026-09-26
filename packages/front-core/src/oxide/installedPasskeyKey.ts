import type { Address } from "viem"

import { deriveBootstrapKey, type FieldLike } from "./oxideAccountKeys"
import type { OxideL1Reader } from "./oxideRegistration"
import { MAX_PASSKEY_CANDIDATES, authKeyPubkeyHex } from "./passkeyCredentialByTag"

const normalized = (hex: string) => hex.replace(/^0x/i, "").toLowerCase()

/**
 * Which of a sign-in signature's two possible public keys is the passkey's, read from the L1
 * accounts its master-key candidates predict: registration installs the passkey's key there. The
 * key is returned only when exactly one possible key is among the inspected keys. It only picks
 * between keys the signature already produced; the anchors still decide the account. `stop` ends
 * the read before its next step. RPC failures propagate.
 */
export async function readInstalledPasskeyKey(
  masterKeys: readonly FieldLike[],
  pubkeyCandidates: readonly string[],
  deps: {
    reader: Pick<OxideL1Reader, "predictAccountAddress" | "getCode" | "readAuthKeys">
    accountFactories: readonly Address[]
    stop?: AbortSignal
  },
): Promise<string | undefined> {
  const wanted = new Set(pubkeyCandidates.map(normalized))
  const throwIfStopped = () => {
    if (deps.stop?.aborted) throw new Error("installed passkey key read stopped")
  }
  const installedAt = async (accountFactory: Address, msk: FieldLike): Promise<string[]> => {
    throwIfStopped()
    const account = await deps.reader.predictAccountAddress(
      accountFactory,
      deriveBootstrapKey(msk).address,
    )
    throwIfStopped()
    const code = await deps.reader.getCode(account)
    if (!code || code === "0x") return []
    throwIfStopped()
    const keys = await deps.reader.readAuthKeys(account, MAX_PASSKEY_CANDIDATES)
    return keys
      .slice(0, MAX_PASSKEY_CANDIDATES)
      .map(authKeyPubkeyHex)
      .filter((hex): hex is string => hex !== undefined && wanted.has(hex))
  }
  const reads = deps.accountFactories.flatMap((accountFactory) =>
    masterKeys.map((msk) => installedAt(accountFactory, msk)),
  )
  const matched = new Set((await Promise.all(reads)).flat())
  return matched.size === 1 ? [...matched][0] : undefined
}
