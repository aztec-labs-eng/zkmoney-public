import { WalletError, type ErrorCode } from "@obsidion/core/errors"
import { isPasskeyPolicyError } from "@obsidion/passkey-web"
import copy from "./catalog.copy"

const words: Partial<Record<ErrorCode, string>> = copy

/**
 * What a surface shows for a failure: a `WalletError`'s words, a passkey refusal's own copy, else
 * the generic words. Raw error text never renders.
 */
export function errorMessage(e: unknown): string {
  return errorCopy(e) ?? (isPasskeyPolicyError(e) ? e.message : copy.unknown)
}

/** A `WalletError`'s words, its data filled in; undefined for any other error and a code with none. */
export function errorCopy(e: unknown): string | undefined {
  if (!(e instanceof WalletError)) return undefined
  const data = e.data ?? {}
  return words[e.code]?.replace(/\{(\w+)\}/g, (slot, name: string) => data[name] ?? slot)
}
