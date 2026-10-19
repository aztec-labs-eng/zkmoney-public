/**
 * The page-start lock, driven through the script text the wallet ships. A `node:vm` realm stands
 * in for the page: its `navigator.credentials` prototype carries the realm's real `Object.create`
 * and `Reflect.get` as `create` and `get` (named natives print as the browser's own), and its
 * `PublicKeyCredential` carries the three probes as functions the realm's
 * `Function.prototype.toString` prints as native, since no real native carries those names.
 */
import { createContext, runInContext } from "node:vm"
import { afterEach, describe, expect, it } from "vitest"
import {
  NATIVE_LOCK_KEY,
  NATIVE_PRINT_PATTERN,
  lockNativePasskeyApi,
  nativeLockFor,
  nativeLockScript,
  printsNative,
} from "../src/ceremony/nativeLock.js"
import { PASSKEY_NATIVE_LOCKS } from "../src/policy/passkeyTelemetryVocabulary.js"
import { BITWARDEN_CREATE, wrapperFrom } from "./support/extensionWrappers.js"

const STATICS = [
  "isUserVerifyingPlatformAuthenticatorAvailable",
  "isConditionalMediationAvailable",
  "getClientCapabilities",
] as const
const NAMES = ["create", "get", ...STATICS] as const

const ALL_APPLIED = Object.fromEntries(NAMES.map((name) => [name, "applied"]))

type Realm = {
  context: Record<string, any>
  credentials: Record<string, any>
  proto: Record<string, any>
  pkc: Record<string, any>
  /** A function the realm prints as `function <name>() { [native code] }`. */
  native: (name: string) => (...args: unknown[]) => unknown
  run: () => Record<string, string>
  record: () => unknown
  descriptor: (container: object, name: string) => PropertyDescriptor | undefined
}

/**
 * A page-like realm. `setup` edits the scope before the script runs; with `webauthn: false` the
 * realm has no `PublicKeyCredential`.
 */
function realm(setup?: (r: Realm) => void, options: { webauthn?: boolean } = {}): Realm {
  const context = createContext({})
  const boot = runInContext(
    `(function () {
      var original = Function.prototype.toString
      var prints = new Map()
      Function.prototype.toString = function () {
        return prints.has(this) ? prints.get(this) : original.call(this)
      }
      var proto = { create: Object.create, get: Reflect.get }
      var credentials = Object.create(proto)
      var pkc = function PublicKeyCredential() {}
      return {
        proto: proto,
        credentials: credentials,
        pkc: pkc,
        native: function (name) {
          var fn = function () {}
          prints.set(fn, "function " + name + "() { [native code] }")
          return fn
        },
      }
    })()`,
    context,
  )
  for (const name of STATICS) boot.pkc[name] = boot.native(name)
  context.navigator = { credentials: boot.credentials }
  if (options.webauthn !== false) context.PublicKeyCredential = boot.pkc
  const r: Realm = {
    context,
    credentials: boot.credentials,
    proto: boot.proto,
    pkc: boot.pkc,
    native: boot.native,
    run: () => runInContext(nativeLockScript(), context),
    record: () => context[NATIVE_LOCK_KEY],
    descriptor: (container, name) => Object.getOwnPropertyDescriptor(container, name),
  }
  setup?.(r)
  return r
}

const locked = (r: Realm, container: object, name: string) => {
  const desc = r.descriptor(container, name)
  expect(desc).toBeDefined()
  expect(desc!.writable).toBe(false)
  expect(desc!.configurable).toBe(false)
  expect(typeof desc!.value).toBe("function")
}

/** A wrapper as an extension's page script assigns it: a plain function from the page's realm. */
const wrapper = () => runInContext("(function create(e) { return e })", realm().context)

describe("the native print", () => {
  it("accepts the browser's print for the given name, whatever the whitespace, and nothing else", () => {
    expect(printsNative("create", "function create() { [native code] }")).toBe(true)
    expect(printsNative("create", "function create() {\n    [native code]\n}")).toBe(true)
    expect(printsNative("get", Function.prototype.toString.call(Reflect.get))).toBe(true)
    expect(printsNative("get", "function create() { [native code] }")).toBe(false)
    expect(printsNative("create", "function () { [native code] }")).toBe(false)
    expect(printsNative("create", "function create(e) { return e }")).toBe(false)
    expect(
      printsNative("create", 'function create(){ return "function create() { [native code] }" }'),
    ).toBe(false)
  })
})

describe("the lock script", () => {
  it("freezes every native in place and records it", () => {
    const r = realm()
    r.run()
    expect(r.record()).toEqual(ALL_APPLIED)
    for (const name of ["create", "get"]) {
      locked(r, r.credentials, name)
      expect(r.descriptor(r.credentials, name)!.value).toBe(r.proto[name])
      expect(r.descriptor(r.credentials, name)!.enumerable).toBe(true)
    }
    for (const name of STATICS) locked(r, r.pkc, name)
  })

  it("keeps a frozen value against assignment, deletion and a later prototype patch", () => {
    const r = realm()
    r.run()
    const late = () => "mine"
    runInContext("(function (w) { navigator.credentials.create = w })", r.context)(late)
    expect(r.credentials.create).toBe(r.proto.create)
    expect(() => {
      "use strict"
      r.credentials.create = late
    }).toThrow(TypeError)
    expect(runInContext("delete navigator.credentials.create", r.context)).toBe(false)
    r.proto.create = late
    expect(r.credentials.create).toBe(
      Object.getOwnPropertyDescriptor(r.credentials, "create")!.value,
    )
    expect(r.credentials.create).not.toBe(late)
  })

  it("publishes the record as a frozen, non-writable slot no later script can replace", () => {
    const r = realm()
    r.run()
    const slot = Object.getOwnPropertyDescriptor(r.context, NATIVE_LOCK_KEY)!
    expect(slot.writable).toBe(false)
    expect(slot.configurable).toBe(false)
    expect(Object.isFrozen(r.record())).toBe(true)
    runInContext(
      `globalThis[${JSON.stringify(NATIVE_LOCK_KEY)}] = { create: "lost_race" }`,
      r.context,
    )
    expect(r.record()).toEqual(ALL_APPLIED)
  })

  it("runs twice without a throw and records applied both times", () => {
    const r = realm()
    r.run()
    r.run()
    expect(r.record()).toEqual(ALL_APPLIED)
  })

  it("leaves a locked accessor on the instance alone", () => {
    const value = () => null
    const r = realm((r) => {
      Object.defineProperty(r.credentials, "create", {
        get: () => value,
        set: () => {},
        configurable: false,
      })
    })
    r.run()
    expect(r.record()).toEqual({ ...ALL_APPLIED, create: "skipped_accessor" })
    expect(r.credentials.create).toBe(value)
    locked(r, r.credentials, "get")
  })

  it("leaves an accessor on the prototype alone too", () => {
    const value = () => null
    const r = realm((r) => {
      Object.defineProperty(r.proto, "get", { get: () => value, configurable: false })
    })
    r.run()
    expect(r.record()).toEqual({ ...ALL_APPLIED, get: "skipped_accessor" })
    expect(r.descriptor(r.credentials, "get")).toBeUndefined()
    expect(r.credentials.get).toBe(value)
  })

  it("skips a configurable accessor as well", () => {
    const r = realm((r) => {
      Object.defineProperty(r.credentials, "create", {
        get: () => Object.create,
        configurable: true,
      })
    })
    r.run()
    expect(r.record()).toMatchObject({ create: "skipped_accessor" })
  })

  it("skips an accessor anywhere on the chain, under an own or a nearer native value too", () => {
    const underOwn = realm((r) => {
      Object.defineProperty(r.proto, "create", { get: () => () => null, configurable: false })
      Object.defineProperty(r.credentials, "create", {
        value: Object.create,
        writable: true,
        configurable: true,
      })
    })
    underOwn.run()
    expect(underOwn.record()).toEqual({ ...ALL_APPLIED, create: "skipped_accessor" })
    expect(underOwn.descriptor(underOwn.credentials, "create")!.writable).toBe(true)

    const deeper = realm((r) => {
      const base = { get: () => null }
      Object.defineProperty(base, "get", { get: () => () => null, configurable: false })
      Object.setPrototypeOf(r.proto, base)
    })
    deeper.run()
    expect(deeper.record()).toEqual({ ...ALL_APPLIED, get: "skipped_accessor" })
    expect(deeper.descriptor(deeper.credentials, "get")).toBeUndefined()

    const empty = realm((r) => {
      Object.defineProperty(r.credentials, "create", {
        get: undefined,
        set: undefined,
        configurable: true,
      })
    })
    empty.run()
    expect(empty.record()).toEqual({ ...ALL_APPLIED, create: "skipped_accessor" })

    const onStatic = realm((r) => {
      Object.defineProperty(r.pkc, "getClientCapabilities", {
        get: () => () => null,
        configurable: true,
      })
    })
    onStatic.run()
    expect(onStatic.record()).toEqual({
      ...ALL_APPLIED,
      getClientCapabilities: "skipped_accessor",
    })
  })

  describe("a wrapper assigned on the instance before the page's scripts", () => {
    it("is replaced by the prototype's own method, frozen, and recorded as restored", () => {
      const w = wrapper()
      const r = realm((r) => {
        r.credentials.create = w
        r.credentials.get = w
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, create: "restored", get: "restored" })
      for (const name of ["create", "get"]) {
        locked(r, r.credentials, name)
        expect(r.descriptor(r.credentials, name)!.value).toBe(r.proto[name])
        expect(r.descriptor(r.credentials, name)!.enumerable).toBe(true)
      }
      runInContext("(function (w) { navigator.credentials.create = w })", r.context)(w)
      expect(r.credentials.create).toBe(r.proto.create)
    })

    it("restores only the calls that were overridden", () => {
      const r = realm((r) => {
        r.credentials.get = wrapper()
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, get: "restored" })
      expect(r.descriptor(r.credentials, "create")!.value).toBe(r.proto.create)
    })

    it("restores a native-printing own value too, since the browser never puts one there", () => {
      // Firefox's exportFunction yields a forwarder that prints as a named native.
      const r = realm((r) => {
        r.credentials.create = r.native("create")
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, create: "restored" })
      expect(r.descriptor(r.credentials, "create")!.value).toBe(r.proto.create)
    })

    it("leaves a non-configurable override alone, recorded as lost_race", () => {
      const w = wrapper()
      const r = realm((r) => {
        Object.defineProperty(r.credentials, "create", { value: w, writable: true })
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race" })
      expect(r.credentials.create).toBe(w)
      locked(r, r.credentials, "get")
    })

    it("leaves the override alone when the prototype's method is no longer the browser's", () => {
      const w = wrapper()
      const r = realm((r) => {
        r.proto.create = new Proxy(r.proto.create, {})
        r.credentials.create = w
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race" })
      expect(r.credentials.create).toBe(w)
      expect(r.descriptor(r.credentials, "create")!.writable).toBe(true)
    })
  })

  it("accepts an own copy of the prototype's own method, as another freeze would leave it", () => {
    const r = realm((r) => {
      Object.defineProperty(r.credentials, "get", {
        value: r.proto.get,
        writable: false,
        configurable: false,
        enumerable: false,
      })
    })
    r.run()
    expect(r.record()).toEqual(ALL_APPLIED)
    expect(r.descriptor(r.credentials, "get")!.enumerable).toBe(false)
  })

  it("leaves a nameless native print alone: a bound function or a Proxy over the native", () => {
    const r = realm((r) => {
      r.proto.create = r.proto.create.bind(Object)
      r.proto.get = new Proxy(r.proto.get, {})
    })
    r.run()
    expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race", get: "lost_race" })
    expect(r.descriptor(r.credentials, "create")).toBeUndefined()
    expect(r.descriptor(r.credentials, "get")).toBeUndefined()
  })

  it("keeps a constructor's own probe when its parent carries one of the same name, as Chromium's Credential does", () => {
    const r = realm((r) => {
      const parent = function Credential() {}
      ;(parent as unknown as Record<string, unknown>).isConditionalMediationAvailable = r.native(
        "isConditionalMediationAvailable",
      )
      Object.setPrototypeOf(r.pkc, parent)
    })
    const own = r.pkc.isConditionalMediationAvailable
    r.run()
    expect(r.record()).toEqual(ALL_APPLIED)
    expect(r.descriptor(r.pkc, "isConditionalMediationAvailable")!.value).toBe(own)
    locked(r, r.pkc, "isConditionalMediationAvailable")
  })

  it("leaves a scripted wrapper alone wherever it sits: on the prototype or on a static", () => {
    const onProto = realm((r) => {
      r.proto.create = wrapperFrom(BITWARDEN_CREATE)
    })
    onProto.run()
    expect(onProto.record()).toEqual({ ...ALL_APPLIED, create: "lost_race" })
    expect(onProto.descriptor(onProto.credentials, "create")).toBeUndefined()

    const onStatic = realm((r) => {
      r.pkc.isConditionalMediationAvailable = () => true
    })
    onStatic.run()
    expect(onStatic.record()).toEqual({
      ...ALL_APPLIED,
      isConditionalMediationAvailable: "lost_race",
    })
    expect(onStatic.descriptor(onStatic.pkc, "isConditionalMediationAvailable")!.writable).toBe(
      true,
    )
  })

  it("skips a probe the browser does not have", () => {
    const r = realm((r) => {
      delete r.pkc.getClientCapabilities
    })
    r.run()
    const { getClientCapabilities: _absent, ...rest } = ALL_APPLIED
    expect(r.record()).toEqual(rest)
  })

  it("records lost_race when the container refuses the definition, and goes on", () => {
    const r = realm((r) => {
      Object.preventExtensions(r.credentials)
    })
    r.run()
    expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race", get: "lost_race" })
    for (const name of STATICS) locked(r, r.pkc, name)
  })

  it("records unsupported for every name without WebAuthn, and defines nothing", () => {
    const r = realm(undefined, { webauthn: false })
    r.run()
    expect(r.record()).toEqual(Object.fromEntries(NAMES.map((name) => [name, "unsupported"])))
    expect(r.descriptor(r.credentials, "create")).toBeUndefined()
    const bare = realm((r) => {
      delete r.context.navigator.credentials
    })
    bare.run()
    expect(bare.record()).toEqual(Object.fromEntries(NAMES.map((name) => [name, "unsupported"])))
  })

  it("records lost_race for a value whose print cannot be read", () => {
    const r = realm((r) => {
      const fn = r.native("create")
      r.proto.create = fn
      runInContext(
        `(function (fn) {
          var original = Function.prototype.toString
          Function.prototype.toString = function () {
            if (this === fn) throw new Error("blocked")
            return original.call(this)
          }
        })`,
        r.context,
      )(fn)
    })
    r.run()
    expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race" })
  })

  it("still locks when the record cannot be written", () => {
    const throwing = realm((r) => {
      Object.defineProperty(r.context, NATIVE_LOCK_KEY, {
        get: () => undefined,
        set: () => {
          throw new Error("no")
        },
      })
    })
    expect(() => throwing.run()).not.toThrow()
    locked(throwing, throwing.credentials, "create")
    expect(throwing.record()).toBeUndefined()
    const frozen = realm((r) => {
      Object.defineProperty(r.context, NATIVE_LOCK_KEY, { value: "held", writable: false })
    })
    expect(() => frozen.run()).not.toThrow()
    locked(frozen, frozen.credentials, "get")
    expect(frozen.record()).toBe("held")
  })

  it("ships as one self-contained classic script", () => {
    const text = nativeLockScript()
    expect(text).toMatch(/^\(function lockNativePasskeyApi\(/)
    expect(text).toMatch(/\)\(globalThis, "[^"]+", "__zkMoneyNativeLock"\)$/)
    expect(text).not.toMatch(/\b(import|require|export)\b/)
    expect(text).not.toMatch(
      /nativeLockFor|printsNative|NATIVE_PRINT_PATTERN|NATIVE_LOCK_KEY|PASSKEY_NATIVE_LOCKS/,
    )
    expect(text).not.toMatch(/<\/script|<!--/i)
    expect(text).toContain(JSON.stringify(NATIVE_PRINT_PATTERN))
    for (const name of NAMES) expect(text).toContain(`"${name}"`)
    for (const outcome of PASSKEY_NATIVE_LOCKS) expect(text).toContain(`"${outcome}"`)
  })

  it("gives the direct call the same answers as the script for create and get", () => {
    const proto = { create: Object.create, get: Reflect.get }
    const credentials = Object.create(proto)
    const scope: Record<string, unknown> = { navigator: { credentials }, PublicKeyCredential: {} }
    const record = lockNativePasskeyApi(scope, NATIVE_PRINT_PATTERN, NATIVE_LOCK_KEY)
    expect(record).toEqual({ create: "applied", get: "applied" })
    expect(scope[NATIVE_LOCK_KEY]).toBe(record)
    expect(Object.getOwnPropertyDescriptor(credentials, "create")!.writable).toBe(false)
  })
})

describe("nativeLockFor", () => {
  const scope = globalThis as Record<string, unknown>
  afterEach(() => {
    delete scope[NATIVE_LOCK_KEY]
  })

  it("reads the entry for the call, and nothing where there is none or it is off the list", () => {
    expect(nativeLockFor("create")).toBeUndefined()
    scope[NATIVE_LOCK_KEY] = { create: "lost_race", get: "applied" }
    expect(nativeLockFor("create")).toBe("lost_race")
    expect(nativeLockFor("get")).toBe("applied")
    scope[NATIVE_LOCK_KEY] = { get: "restored" }
    expect(nativeLockFor("create")).toBeUndefined()
    expect(nativeLockFor("get")).toBe("restored")
    scope[NATIVE_LOCK_KEY] = { create: "frozen" }
    expect(nativeLockFor("create")).toBeUndefined()
    scope[NATIVE_LOCK_KEY] = "applied"
    expect(nativeLockFor("create")).toBeUndefined()
    scope[NATIVE_LOCK_KEY] = null
    expect(nativeLockFor("get")).toBeUndefined()
  })
})
