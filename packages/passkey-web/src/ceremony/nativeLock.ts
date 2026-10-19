/**
 * The page-start lock on the browser's own passkey functions: `nativeLockScript()` is the inline
 * script the wallet puts at the top of `<head>`, `nativeLockFor()` reads what it recorded.
 */

import {
  PASSKEY_NATIVE_LOCKS,
  type PasskeyNativeLock,
} from "../policy/passkeyTelemetryVocabulary.js"

/** The browser's own method prints `function NAME() { [native code] }`, whitespace aside. */
export const NATIVE_PRINT_PATTERN = "^function NAME\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}$"

export function printsNative(name: string, source: string): boolean {
  return new RegExp(NATIVE_PRINT_PATTERN.replace("NAME", name)).test(source.trim())
}

/** The `globalThis` slot the inline script writes its per-function record to. */
export const NATIVE_LOCK_KEY = "__zkMoneyNativeLock"

export type NativeLockCall = "create" | "get"

export type NativeLockScope = {
  navigator?: { credentials?: object }
  PublicKeyCredential?: object
  [key: string]: unknown
}

export type NativeLockRecord = Partial<Record<string, PasskeyNativeLock>>

/**
 * Freezes `create`, `get` and the `PublicKeyCredential` probes in place while they are still the
 * browser's own, so a wrapper assigned later cannot replace them. A wrapper already assigned over
 * the prototype's method (Bitwarden's and Proton Pass's page scripts run before any page script on
 * Chromium) is replaced by that method, frozen, when it is still the browser's own and the wrapper
 * is configurable. Stringified into the page by `nativeLockScript()`: nothing from this module, no
 * helper, nothing that needs strict mode, and the names are a literal here for that reason.
 */
export function lockNativePasskeyApi(
  scope: NativeLockScope,
  pattern: string,
  key: string,
): NativeLockRecord {
  const record: NativeLockRecord = {}
  try {
    const credentials = scope.navigator && scope.navigator.credentials
    // The instance never owns create or get, so an own value there is a script's. The constructor
    // owns its probes, and its parent Credential carries some of the same names.
    const targets: [object | undefined, string[], boolean][] = [
      [credentials, ["create", "get"], false],
      [
        scope.PublicKeyCredential,
        [
          "isUserVerifyingPlatformAuthenticatorAvailable",
          "isConditionalMediationAvailable",
          "getClientCapabilities",
        ],
        true,
      ],
    ]
    const supported = !!credentials && !!scope.PublicKeyCredential
    const native = (name: string, value: unknown) =>
      typeof value === "function" &&
      new RegExp(pattern.replace("NAME", name)).test(Function.prototype.toString.call(value).trim())
    for (const target of targets) {
      const container = target[0]
      const ownIsTheirs = target[2]
      for (const name of target[1]) {
        if (!supported || !container) {
          record[name] = "unsupported"
          continue
        }
        try {
          const own = Object.getOwnPropertyDescriptor(container, name)
          let accessor = own !== undefined && !("value" in own)
          let inherited: PropertyDescriptor | undefined
          let proto = Object.getPrototypeOf(container)
          while (proto) {
            const found = Object.getOwnPropertyDescriptor(proto, name)
            if (found) {
              if (!("value" in found)) accessor = true
              if (!inherited) inherited = found
            }
            proto = Object.getPrototypeOf(proto)
          }
          // An accessor anywhere on the chain is another script's (1Password's) and stays.
          if (accessor) {
            record[name] = "skipped_accessor"
            continue
          }
          const desc = own || inherited
          if (!desc) continue
          // An own value that is not the prototype's is a script's, whatever it prints (Firefox's
          // exportFunction prints as a named native). The prototype's method goes back over it
          // where it still can.
          if (!ownIsTheirs && own && inherited && inherited.value !== own.value) {
            if (own.configurable && native(name, inherited.value)) {
              Object.defineProperty(container, name, {
                value: inherited.value,
                writable: false,
                configurable: false,
                enumerable: inherited.enumerable,
              })
              record[name] = "restored"
            } else {
              record[name] = "lost_race"
            }
            continue
          }
          if (typeof desc.value !== "function") continue
          if (!native(name, desc.value)) {
            record[name] = "lost_race"
            continue
          }
          Object.defineProperty(container, name, {
            value: desc.value,
            writable: false,
            configurable: false,
            enumerable: desc.enumerable,
          })
          record[name] = "applied"
        } catch (_error) {
          record[name] = "lost_race"
        }
      }
    }
    Object.defineProperty(scope, key, {
      value: Object.freeze(record),
      writable: false,
      configurable: false,
      enumerable: false,
    })
  } catch (_error) {
    // The lock never breaks page load.
  }
  return record
}

/** The inline script: the lock function's own source, run against the page's globals. */
export function nativeLockScript(): string {
  const pattern = JSON.stringify(NATIVE_PRINT_PATTERN)
  const key = JSON.stringify(NATIVE_LOCK_KEY)
  return `(${lockNativePasskeyApi.toString()})(globalThis, ${pattern}, ${key})`
}

/** What the inline script recorded for `create` or `get`; nothing where the page has no record. */
export function nativeLockFor(call: NativeLockCall): PasskeyNativeLock | undefined {
  try {
    const record = (globalThis as Record<string, unknown>)[NATIVE_LOCK_KEY]
    const value =
      record && typeof record === "object" ? (record as Record<string, unknown>)[call] : undefined
    return (PASSKEY_NATIVE_LOCKS as readonly unknown[]).includes(value)
      ? (value as PasskeyNativeLock)
      : undefined
  } catch {
    return undefined
  }
}
