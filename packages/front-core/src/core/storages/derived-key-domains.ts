/**
 * Domain → poseidon2 separator mapping for `AlphaAuthService.getDerivedKey`.
 *
 * Each entry is a 32-bit selector used as the domain-separator argument to
 * `poseidon2HashWithSeparator([msk], separator)`. Add a new entry here when
 * a new derived-key domain is introduced.
 *
 * The numbers are derived once and frozen — changing one rotates every
 * derived key bound to that domain, which would invalidate every existing
 * encrypted record on production users' devices.
 */
export const DOMAIN_SEPARATORS: Readonly<Record<string, number>> = {
  // 4-byte selector for pending-tx-store encryption key derivation.
  // Stable, cryptographically-irrelevant value; only needs to be unique.
  "pending-store": 0x70535443, // ASCII "pSTC"
  // 4-byte selector for the XMTP local-store encryption key derivation.
  // Stable, cryptographically-irrelevant value; only needs to be unique.
  "xmtp-store": 0x584d5453, // ASCII "XMTS"
  // 4-byte selector for the zkJWT proof-cache encryption key derivation.
  // Stable, cryptographically-irrelevant value; only needs to be unique.
  "zkjwt-store": 0x7a4a5753, // ASCII "zJWS"
}

/**
 * String-literal union of valid derived-key domain names. Use this at
 * in-repo call sites that hardcode a known domain so adding a new domain
 * forces a deliberate type-system update.
 *
 * The `AlphaAuthService.getDerivedKey` interface keeps an open `string`
 * parameter so external SDK consumers are not blocked from extending.
 */
export type KnownDerivedKeyDomain = keyof typeof DOMAIN_SEPARATORS
