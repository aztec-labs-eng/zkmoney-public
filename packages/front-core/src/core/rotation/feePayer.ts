/**
 * Which account pays for a sponsored batch. A ClaimFPC subscription note lives in one deployed
 * instance's storage under the account that subscribed, so a rotated wallet keeps paying through its
 * previous account on every instance that account subscribed on. The fact is persisted per instance
 * on the root record and never derived from the live key set.
 */
import type { FeePayerEntry, RecoveryMetadata } from "@obsidion/sdk"

export type { FeePayerEntry }

export type FeePayerRecord = Pick<RecoveryMetadata, "l2Address" | "pubkey" | "feePayer">

/** The map key of a ClaimFPC instance. */
export const feePayerKey = (fpc: string): string => fpc.toLowerCase()

/** The record's entry for `fpc`, if one was written. */
export function feePayerEntry(record: FeePayerRecord, fpc: string): FeePayerEntry | undefined {
  return record.feePayer?.[feePayerKey(fpc)]
}

/** The record's map with `entry` written for `fpc`; other instances' entries stay. */
export function withFeePayer(
  record: FeePayerRecord,
  fpc: string,
  entry: FeePayerEntry,
): Record<string, FeePayerEntry> {
  return { ...record.feePayer, [feePayerKey(fpc)]: entry }
}

/**
 * The payer a device with no entry for an instance finds: the first single-key account of `keys`,
 * in order, that `probe` reports subscribed there. None when no key's account is.
 */
export async function discoverFeePayer(
  keys: readonly string[],
  probe: (passkey: string) => Promise<{ address: string; subscribed: boolean }>,
): Promise<FeePayerEntry | undefined> {
  for (const passkey of keys) {
    const { address, subscribed } = await probe(passkey)
    if (subscribed) return { address, passkey }
  }
  return undefined
}
