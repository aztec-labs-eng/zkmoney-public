import { Fr } from "@aztec/aztec.js/fields"
import {
  APPLE_ICLOUD_AAGUID,
  GPM_AAGUID,
  ONEPASSWORD_AAGUID,
  SECURITY_KEY_AAGUIDS,
  ZERO_AAGUID,
} from "@obsidion/core/constants"
import type { PrfSlot } from "@obsidion/core/types"

export type { PrfSlot }

export { MSK_PRF_SALT, MSK_PRF_SALT_LABEL } from "@obsidion/core/constants"
export { APPLE_ICLOUD_AAGUID, GPM_AAGUID, ONEPASSWORD_AAGUID, SECURITY_KEY_AAGUIDS, ZERO_AAGUID }

/**
 * Derive the MSK from a PRF output. The PRF output is 32 uniformly random
 * bytes; `fromBufferReduce` maps them into the field (the modulo bias is
 * cryptographically negligible).
 *
 * Requires EXACTLY 32 bytes: a shorter value is not a valid PRF output, and a
 * longer one means the decoder accepted a malformed/garbage shape — both must
 * be rejected on the MSK path rather than silently reduced, so a corrupt slot
 * never yields a derivable-but-wrong key.
 */
export function deriveMskFromPrfOutput(prfOutput: Uint8Array): Fr {
  if (prfOutput.length !== 32) {
    throw new Error(`PRF output must be exactly 32 bytes, got ${prfOutput.length}`)
  }
  return Fr.fromBufferReduce(Buffer.from(prfOutput))
}

/**
 * WebAuthn PRF contextualization `K(x) = SHA-256("WebAuthn PRF" ‖ 0x00 ‖ x)`.
 *
 * This is the transform a browser applies to a PRF salt before the
 * authenticator sees it. We compute it client-side for `eval.second` so that
 * on iOS native (where the OS does NOT contextualize) a provider that passes
 * the salt through unchanged (Google Password Manager) still produces the same
 * value a browser would. `canonical` is the already-hashed 32-byte `C`.
 */
export async function contextualize(canonical: Uint8Array): Promise<Uint8Array> {
  const prefix = new TextEncoder().encode("WebAuthn PRF") // 12 ASCII bytes
  const buf = new Uint8Array(prefix.length + 1 + canonical.length)
  buf.set(prefix, 0)
  buf[prefix.length] = 0x00
  buf.set(canonical, prefix.length + 1)
  const digest = await crypto.subtle.digest("SHA-256", buf.buffer as ArrayBuffer)
  return new Uint8Array(digest)
}

// ── AAGUID → PRF slot (the unrecoverable-wallet decision; fail closed) ──────
//
// The accepted providers are the AAGUID constants in @obsidion/core. Empirically verified
// (prf-compat): iCloud Keychain and Apple's security-key path (2026-06-10), and 1Password (live
// telemetry 2026-06-16), land the browser-reproducible value in `first`; Google Password Manager
// lands it in `second`. 1Password contextualizes `K` internally on iOS native like iCloud, and our
// recovery is iOS-native-only, so the cross-platform `second` case never applies to us. Every
// recognized security key maps to `first` here (`attestation: "none"` may zero the AAGUID). Every
// other provider's contextualization behavior is UNMEASURED, so it must fail closed — binding an
// MSK to an unverified slot risks a wallet no browser can ever recover.
//
// NOTE: Apple "managed" AAGUID dd4ec289-e01d-41c9-bb89-70fa845d4bf2 is
// deliberately NOT trusted here. Its contextualization is unverified, so it
// must fall through to the fail-closed throw until measured. Do not add it to
// the trusted set without empirical confirmation.

/**
 * Normalize an AAGUID to its canonical lowercase `8-4-4-4-12` form. Accepts
 * input with or without hyphens and in any case; throws if it does not contain
 * exactly 32 hex digits (a malformed AAGUID must not be silently coerced).
 */
export function normalizeAaguid(aaguid: string): string {
  const hex = aaguid.toLowerCase().replace(/[^0-9a-f]/g, "")
  if (hex.length !== 32) {
    throw new Error(`Malformed AAGUID: expected 32 hex digits, got ${hex.length}`)
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Pick the PRF slot the MSK must be derived from, by the credential's provider
 * AAGUID. FAIL CLOSED on anything unrecognized: binding the MSK for an
 * unverified provider would risk an unrecoverable wallet.
 *
 * Only valid at CREATE (an assertion has no AAGUID — the chosen slot is then
 * persisted and reused at every login; see `PasskeyIdentityMapStore`).
 */
export function pickPrfSlot(aaguidHex: string): PrfSlot {
  const aaguid = normalizeAaguid(aaguidHex)
  if (aaguid === ZERO_AAGUID) return "first" // iCloud Keychain (zeros on iOS)
  if (aaguid === APPLE_ICLOUD_AAGUID) return "first"
  if (SECURITY_KEY_AAGUIDS.has(aaguid)) return "first" // Apple security-key path blends
  if (aaguid === ONEPASSWORD_AAGUID) return "first" // 1Password contextualizes K internally on iOS native (like iCloud)
  if (aaguid === GPM_AAGUID) return "second" // GPM does NOT blend
  throw new Error(
    `Refusing to create wallet: unrecognized passkey provider AAGUID ${aaguid}. ` +
      `PRF contextualization behavior is unverified for this provider; binding the ` +
      `MSK would risk an unrecoverable wallet.`,
  )
}

/**
 * Decode a `clientExtensionResults.prf.results.first` OR `.second` value
 * returned by react-native-passkey into raw bytes. Slot-agnostic — pass
 * whichever slot you want decoded.
 *
 * The library types it as `Uint8Array | ArrayBuffer | number[] | string`;
 * on iOS the native side JSON-encodes Swift `Data`, which arrives as a
 * standard-base64 string. The indexed-object shape covers a `Uint8Array`
 * that went through `JSON.stringify` (`{"0":n,"1":n,...}`).
 *
 * Returns `undefined` for absent/empty/garbage values (including `{}` and an
 * empty string) so callers can treat "no PRF output for this slot" uniformly;
 * the MSK path additionally requires exactly 32 bytes (`deriveMskFromPrfOutput`).
 */
export function decodePrfOutput(value: unknown): Uint8Array | undefined {
  if (value == null) return undefined
  if (value instanceof Uint8Array) return value.length ? value : undefined
  if (value instanceof ArrayBuffer) {
    return value.byteLength ? new Uint8Array(value) : undefined
  }
  if (Array.isArray(value)) {
    return value.length ? Uint8Array.from(value as number[]) : undefined
  }
  if (typeof value === "string") {
    if (!value) return undefined
    // Tolerate both base64url and standard base64, padded or not.
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
    const bytes = new Uint8Array(Buffer.from(padded, "base64"))
    return bytes.length ? bytes : undefined
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const indices = Object.keys(record)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b))
    if (!indices.length) return undefined
    return Uint8Array.from(indices.map((key) => Number(record[key])))
  }
  return undefined
}
