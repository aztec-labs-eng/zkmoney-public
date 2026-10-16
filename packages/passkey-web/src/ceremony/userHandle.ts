/**
 * What a passkey's user handle carries. The chain and the claim server hold only a tag's hash, so
 * a browser whose data was wiped has no other front-end source for the tag itself: the handle
 * names the account the passkey was created under, and a discoverable-credential assertion, on any
 * device, hands it back. A 22-byte tail follows the name: where the creating page ran and what it
 * asked for (a format version, the creation context, the OS version and the chip the browser
 * claimed), then 16 random bytes so each creation is its own user to the authenticator; the same
 * handle twice would replace the earlier credential. Every tail field is a claim the page wrote
 * before the prompt opened, never a fact about which authenticator answered. The name is what the
 * passkey already shows in every picker, nothing here is secret, and nothing is signed.
 */

const SEPARATOR = 0x00
const RANDOM_BYTES = 16
const TAIL_VERSION = 0x01
/** Version, context, OS major, minor, patch, chip, then the random bytes. */
const TAIL_BYTES = 6 + RANDOM_BYTES
/** A version component the page did not know. */
const UNKNOWN_BYTE = 0xff
/** The largest version component a byte can carry. */
export const MAX_VERSION_COMPONENT = UNKNOWN_BYTE - 1
/** WebAuthn caps the handle at 64 bytes. */
const MAX_HANDLE_BYTES = 64
export const MAX_USER_HANDLE_NAME_BYTES = MAX_HANDLE_BYTES - 1 - TAIL_BYTES

/**
 * Which kind of device the creating page ran on and which route it asked for. A phone's sheet
 * offers its own manager and a security key together, and a laptop's local route may admit a key
 * too, so no value says which authenticator answered; the QR and key routes say another device was
 * asked. `ios_app` is reserved for the native app.
 */
export type CreationContext =
  | "unknown"
  | "ios_app"
  | "ios_browser"
  | "android_browser"
  | "phone_other"
  | "mac_local"
  | "mac_qr"
  | "mac_key"
  | "windows_local"
  | "windows_qr"
  | "windows_key"
  | "laptop_other_local"
  | "laptop_other_qr"
  | "laptop_other_key"

/**
 * High nibble: 0 phone, 1 Mac, 2 Windows, 3 other laptop. Low nibble: on a phone the app or browser
 * (1 to 4), on a laptop the route (0 local, 1 QR, 2 key).
 */
const CONTEXT_BYTES: Readonly<Record<CreationContext, number>> = {
  unknown: 0x00,
  ios_app: 0x01,
  ios_browser: 0x02,
  android_browser: 0x03,
  phone_other: 0x04,
  mac_local: 0x10,
  mac_qr: 0x11,
  mac_key: 0x12,
  windows_local: 0x20,
  windows_qr: 0x21,
  windows_key: 0x22,
  laptop_other_local: 0x30,
  laptop_other_qr: 0x31,
  laptop_other_key: 0x32,
}

export type Chip = "unknown" | "arm" | "x86"

const CHIP_BYTES: Readonly<Record<Chip, number>> = { unknown: 0x00, arm: 0x01, x86: 0x02 }

const byValue = <T extends string>(table: Readonly<Record<T, number>>): ReadonlyMap<number, T> =>
  new Map((Object.entries(table) as [T, number][]).map(([name, byte]) => [byte, name]))

const CONTEXT_NAMES = byValue(CONTEXT_BYTES)
const CHIP_NAMES = byValue(CHIP_BYTES)

/** An OS version as the handle carries it; a component the page did not know is absent. */
export type HandleOsVersion = { major?: number; minor?: number; patch?: number }

export type UserHandleProvenance = {
  context: CreationContext
  osVersion: HandleOsVersion
  chip: Chip
}

/** What a creation that knows nothing about itself writes. */
export const UNKNOWN_PROVENANCE: UserHandleProvenance = Object.freeze({
  context: "unknown",
  osVersion: Object.freeze({}),
  chip: "unknown",
})

/** A component is written only as a whole number in 0–254; anything else is unknown. */
const componentByte = (value: number | undefined): number =>
  value !== undefined && Number.isInteger(value) && value >= 0 && value <= MAX_VERSION_COMPONENT
    ? value
    : UNKNOWN_BYTE

export function encodeUserHandle(
  name: string,
  provenance: UserHandleProvenance = UNKNOWN_PROVENANCE,
): Uint8Array {
  const encoded = new TextEncoder().encode(name)
  if (encoded.length === 0 || encoded.length > MAX_USER_HANDLE_NAME_BYTES) {
    throw new Error(`passkey user name must be 1 to ${MAX_USER_HANDLE_NAME_BYTES} bytes`)
  }
  const handle = new Uint8Array(encoded.length + 1 + TAIL_BYTES)
  handle.set(encoded, 0)
  let at = encoded.length
  handle[at++] = SEPARATOR
  handle[at++] = TAIL_VERSION
  handle[at++] = CONTEXT_BYTES[provenance.context] ?? CONTEXT_BYTES.unknown
  handle[at++] = componentByte(provenance.osVersion.major)
  handle[at++] = componentByte(provenance.osVersion.minor)
  handle[at++] = componentByte(provenance.osVersion.patch)
  handle[at++] = CHIP_BYTES[provenance.chip] ?? CHIP_BYTES.unknown
  crypto.getRandomValues(handle.subarray(at))
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

/**
 * The provenance a handle carries, or undefined where it carries none: a handle this encoder would
 * not have written (a name over the budget or not UTF-8), an older shape (a name and 16 random
 * bytes, or 32 random bytes), another version, or an unlisted context or chip. A handle
 * written with no provenance reads as `UNKNOWN_PROVENANCE`. Recognition is by shape alone, so an
 * older random handle can, about once in a hundred million, read as a provenance; a reader treats
 * the result as the creating page's claim and never as proof.
 */
export function decodeUserHandleProvenance(
  handle: Uint8Array | undefined,
): UserHandleProvenance | undefined {
  if (!handle) return undefined
  const end = handle.indexOf(SEPARATOR)
  if (end <= 0 || end > MAX_USER_HANDLE_NAME_BYTES) return undefined
  if (decodeUserHandle(handle) === undefined) return undefined
  const tail = handle.subarray(end + 1)
  if (tail.length !== TAIL_BYTES || tail[0] !== TAIL_VERSION) return undefined
  const context = CONTEXT_NAMES.get(tail[1]!)
  const chip = CHIP_NAMES.get(tail[5]!)
  if (!context || !chip) return undefined
  const osVersion: HandleOsVersion = {}
  if (tail[2] !== UNKNOWN_BYTE) osVersion.major = tail[2]
  if (tail[3] !== UNKNOWN_BYTE) osVersion.minor = tail[3]
  if (tail[4] !== UNKNOWN_BYTE) osVersion.patch = tail[4]
  return { context, osVersion, chip }
}
