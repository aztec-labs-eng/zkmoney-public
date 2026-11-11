/** Validation failure ⇒ `manifest-incompatible` (vs network `fetch-failed`). */
export class OxideManifestValidationError extends Error {}

export function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new OxideManifestValidationError(
      `oxide env registry: ${field} is missing or malformed (got ${JSON.stringify(value)})`,
    )
  }
  return value
}
