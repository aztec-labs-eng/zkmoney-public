/** The one-key account a rotated wallet left. */
import { normalizePubkeyHex, type RecoveryMetadata } from "@obsidion/sdk"

function normalKey(hex: string): string | undefined {
  try {
    return normalizePubkeyHex(hex)
  } catch {
    return undefined
  }
}

/**
 * The root key of the one-key account, as x‖y hex with no prefix, from a record of the account that
 * replaced it. A set of exactly two distinct keys holding the record's own is the root and one
 * backup: the record's key on the root's record, the other one on the backup's. Any other record
 * names none.
 */
export function previousRootKey(
  record: Pick<RecoveryMetadata, "pubkey" | "isMskRoot" | "passkeySet">,
): string | undefined {
  const own = normalKey(record.pubkey)
  const [a, b, ...rest] = record.passkeySet?.map(normalKey) ?? []
  if (!own || !a || !b || rest.length > 0 || a === b) return undefined
  if (own !== a && own !== b) return undefined
  if (record.isMskRoot) return own
  return own === a ? b : a
}

/** Whether `amount` is below the dust floor, the smallest amount Home shows. */
export const isDust = (amount: bigint, dust: bigint): boolean => amount < dust
