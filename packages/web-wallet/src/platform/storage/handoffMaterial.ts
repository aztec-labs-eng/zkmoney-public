/**
 * Key material the sealed hand-off (`bridge/fragment.ts`) received on this page load: the passkey
 * it derived from, every PRF candidate as 0x-prefixed hex, and the transports its creation
 * reported when the campaign had them. Held in memory only; the hand-off naming its credential
 * takes it, once.
 */
import type { PrfSlot } from "@obsidion/core/types"

export type HandoffMaterial = {
  v: 1
  derivedAt: number
  rpId: string
  credentialId: string
  pubkeyHex: string
  candidates: { first?: string; second?: string }
  slot?: PrfSlot
  transports?: readonly string[]
}

/** Material older than this at the attempt is refused. */
export const HANDOFF_MAX_AGE_MS = 10 * 60_000
/** A stamp further in the future than this is refused: a wrong clock, not a fresh ceremony. */
export const HANDOFF_FUTURE_SKEW_MS = 60_000

let held: HandoffMaterial | undefined

export function holdHandoffMaterial(material: HandoffMaterial): void {
  held = material
}

/**
 * Take the material for `credentialId` under `rpId`. Material for another credential stays for the
 * hand-off it belongs to; material for another RP, or with a stamp that is not a safe integer,
 * older than ten minutes, or more than a minute ahead, is dropped.
 */
export function takeHandoffMaterial(
  credentialId: string,
  rpId: string,
  now: number = Date.now(),
): HandoffMaterial | null {
  const material = held
  if (!material) return null
  const age = now - material.derivedAt
  const live =
    Number.isSafeInteger(material.derivedAt) &&
    age <= HANDOFF_MAX_AGE_MS &&
    age >= -HANDOFF_FUTURE_SKEW_MS
  if (material.rpId !== rpId || !live) {
    held = undefined
    return null
  }
  if (material.credentialId !== credentialId) return null
  held = undefined
  return material
}

export function __resetHandoffMaterialForTests(): void {
  held = undefined
}
