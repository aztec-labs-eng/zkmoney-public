/**
 * What a passkey's user handle carries. The chain and the claim server hold only a tag's hash, so
 * a browser whose data was wiped has no other front-end source for the tag itself: the handle
 * names the account the passkey was created under, and every assertion, on any device, hands it
 * back. A random tail follows, so each creation is its own user to the authenticator; the same
 * handle twice would replace the earlier credential. The name is what the passkey already shows in
 * every picker, and nothing here is secret.
 */

const SEPARATOR = 0x00
const TAIL_BYTES = 16
/** WebAuthn caps the handle at 64 bytes. */
const MAX_HANDLE_BYTES = 64
export const MAX_USER_HANDLE_NAME_BYTES = MAX_HANDLE_BYTES - 1 - TAIL_BYTES

export function encodeUserHandle(name: string): Uint8Array {
  const encoded = new TextEncoder().encode(name)
  if (encoded.length === 0 || encoded.length > MAX_USER_HANDLE_NAME_BYTES) {
    throw new Error(`passkey user name must be 1 to ${MAX_USER_HANDLE_NAME_BYTES} bytes`)
  }
  const handle = new Uint8Array(encoded.length + 1 + TAIL_BYTES)
  handle.set(encoded, 0)
  handle[encoded.length] = SEPARATOR
  crypto.getRandomValues(handle.subarray(encoded.length + 1))
  return handle
}

/**
 * The name a handle carries, or undefined: no handle, no separator, an empty name, or bytes that
 * are not UTF-8. A handle from before names were carried is random, and reads as undefined or as
 * a string no tag hashes to; the caller only ever trusts a name that hashes to what it found.
 */
export function decodeUserHandle(handle: Uint8Array | undefined): string | undefined {
  if (!handle) return undefined
  const end = handle.indexOf(SEPARATOR)
  if (end <= 0) return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(handle.subarray(0, end))
  } catch {
    return undefined
  }
}
