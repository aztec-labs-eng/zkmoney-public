import type { PrfSlot } from "@obsidion/core/types"
import type { PasskeyAttachment } from "../ceremony/passkeyCeremony.js"
import { DeviceBoundPasskeyError, NoPrfError, SingleSaltProviderError } from "./passkeyErrors.js"
import { slotForAttachment } from "./slotRule.js"

/** What one ceremony attested. Fields are never mixed across two ceremonies. */
export type Evidence = {
  backupEligible?: boolean
  prfFirst?: Uint8Array
  prfSecond?: Uint8Array
  /** The class the browser reported. On an assertion it is all the backup gate has to go on. */
  authenticatorAttachment?: PasskeyAttachment
}

export const evidenceOf = (r: Evidence): Evidence => ({
  backupEligible: r.backupEligible,
  prfFirst: r.prfFirst,
  prfSecond: r.prfSecond,
  authenticatorAttachment: r.authenticatorAttachment,
})

export const prfOf = (e: Evidence, slot: PrfSlot): Uint8Array | undefined =>
  slot === "first" ? e.prfFirst : e.prfSecond

/** Readable flags and the slot this route binds to; anything less and an assertion has to stand in. */
export const isComplete = (e: Evidence, slot: PrfSlot): boolean =>
  e.backupEligible !== undefined && prfOf(e, slot) !== undefined

/**
 * The backup gate. A passkey no other device can read protects nothing, so it is refused — unless
 * it is exempt: a security key holds the only copy by design. A flag that could not be read is
 * never exempt, since nothing was attested to excuse.
 */
function checkBackup(evidence: Evidence, exempt: boolean): void {
  if (evidence.backupEligible === true) return
  if (evidence.backupEligible === false && exempt) return
  throw new DeviceBoundPasskeyError()
}

/**
 * The PRF output the account binds to: the backup gate first, then the slot. A value in the other
 * slot only is a provider that evaluated one salt, and it is not the one this route binds to.
 * `securityKey` exempts a hardware key from the backup gate; creation decides it from transports.
 */
export function prfOutputFor(evidence: Evidence, slot: PrfSlot, securityKey = false): Uint8Array {
  checkBackup(evidence, securityKey)
  const prfOutput = prfOf(evidence, slot)
  if (!prfOutput) {
    const other = slot === "first" ? evidence.prfSecond : evidence.prfFirst
    throw other ? new SingleSaltProviderError() : new NoPrfError()
  }
  return prfOutput
}

/** The PRF outputs an assertion yielded, one per slot the provider answered. */
export type PrfCandidates = { first?: Uint8Array; second?: Uint8Array }

/** An injected ceremony may return any length; only a 32-byte slot is a candidate. */
const validSlot = (out: Uint8Array | undefined): Uint8Array | undefined =>
  out && out.length === 32 ? out : undefined

/**
 * Both candidate keys' PRF outputs from one assertion, each slot judged on its own: a malformed
 * slot is dropped and a valid sibling kept. Refuses what no anchor could rescue.
 *
 * An assertion carries no transports, so a security key cannot be told from a phone here. Another
 * device's answer is exempt from the backup gate on that account: creation only ever admits a
 * synced passkey or a security key, and the caller's anchors decide which account, if any, the
 * candidates open. The device's own answer gets no such benefit.
 */
export function candidatesFrom(assertion: Evidence): PrfCandidates {
  checkBackup(assertion, assertion.authenticatorAttachment === "cross-platform")
  const candidates: PrfCandidates = {}
  const first = validSlot(assertion.prfFirst)
  if (first) candidates.first = first
  const second = validSlot(assertion.prfSecond)
  if (second) candidates.second = second
  if (!candidates.first && !candidates.second) throw new NoPrfError()
  return candidates
}

/** The slot an anchor tries first: the record's, else the route's, else `first`. */
export const preferredSlot = (
  attachment: PasskeyAttachment | undefined,
  recordSlot?: PrfSlot,
): PrfSlot => recordSlot ?? (attachment ? slotForAttachment(attachment) : "first")
