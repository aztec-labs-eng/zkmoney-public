import { OxideManifestValidationError, requirePattern } from "./validation.js"

// L1 (EVM) addresses are 20 bytes; L2 (Aztec field) addresses are 32.
export const L1_ADDRESS = /^0x[0-9a-fA-F]{40}$/
export const L2_ADDRESS = /^0x[0-9a-fA-F]{64}$/

/** True for `0x0`, `0x00…0` — any all-zero hex string. */
export function isAllZeroHex(value: string): boolean {
  return /^0x0+$/i.test(value)
}

/** A well-formed, non-zero L1 address, for a field a caller skips rather than rejects. */
export function isWellFormedNonZeroL1Address(value: unknown): value is string {
  return typeof value === "string" && L1_ADDRESS.test(value) && !isAllZeroHex(value)
}

/** L1 address that is well-formed AND not the zero address (a zero address is truthy). */
export function requireNonZeroL1Address(value: unknown, field: string): string {
  const v = requirePattern(value, L1_ADDRESS, field)
  if (isAllZeroHex(v))
    throw new OxideManifestValidationError(`oxide env registry: ${field} is the zero address`)
  return v
}

/** L2 address that is well-formed AND not the zero address. */
export function requireNonZeroL2Address(value: unknown, field: string): string {
  const v = requirePattern(value, L2_ADDRESS, field)
  if (isAllZeroHex(v))
    throw new OxideManifestValidationError(`oxide env registry: ${field} is the zero address`)
  return v
}
