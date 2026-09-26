import { p256 } from "@noble/curves/p256"
import { hmac } from "@noble/hashes/hmac"
import { sha256 as nobleSha256 } from "@noble/hashes/sha256"
import { MSK_PRF_SALT } from "@obsidion/core/constants"
import { bytesToBase64Url } from "../../src/ceremony/bytes.js"
import type {
  PasskeyAssertRequest,
  PasskeyAssertResult,
  PasskeyAttachment,
  PasskeyCeremony,
  PasskeyCreateRequest,
  PasskeyCreateResult,
  PasskeyRequestHook,
  PasskeyRequestSignal,
} from "../../src/ceremony/passkeyCeremony.js"

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource))
}

/**
 * Which PRF a fake provider returns, by manager and by the route the request took. Mirrors the
 * measured table: the requesting browser applies K once; iCloud and GPM apply K again inside the
 * provider on the local route (GPM also over cross-device), 1Password never does, and a security
 * key never does on any route. K is computed here independently of the package's `contextualize`
 * so a defect there cannot cancel out.
 */
export type FakeManager = "icloud" | "1password" | "gpm" | "security-key"
export type FakeRoute = "local" | "cross-device"

const K_PREFIX = new TextEncoder().encode("WebAuthn PRF")
export function contextualiseLocal(x: Uint8Array): Uint8Array {
  const buf = new Uint8Array(K_PREFIX.length + 1 + x.length)
  buf.set(K_PREFIX, 0)
  buf[K_PREFIX.length] = 0
  buf.set(x, K_PREFIX.length + 1)
  return nobleSha256(buf)
}

/** How many times K is applied to the salt the caller sent before the provider's HMAC sees it. */
function hashesFor(manager: FakeManager, route: FakeRoute): number {
  if (manager === "1password") return route === "local" ? 0 : 1
  if (manager === "gpm") return route === "local" ? 1 : 2
  // iCloud and a security key: only the browser's own K, whichever route asked.
  return 1
}

export function fakePrf(
  secret: Uint8Array,
  salt: Uint8Array,
  manager: FakeManager,
  route: FakeRoute,
): Uint8Array {
  let input = salt
  for (let i = 0; i < hashesFor(manager, route); i++) input = contextualiseLocal(input)
  return hmac(nobleSha256, secret, input)
}

export type FakeCeremonyOptions = {
  prfAtCreate?: boolean
  prfAtAssert?: boolean
  manager?: FakeManager
  route?: FakeRoute
  /**
   * When set, each assertion answers over the route its own request implies — a `client-device`
   * hint (the this-device steering) is a local answer, anything else a cross-device one — instead of
   * the instance's fixed `route`. Lets one authenticator answer a laptop over different routes as
   * the user picks them. Creation still uses the fixed `route`.
   */
  routeFromRequest?: boolean
  /**
   * On the local route, HMAC a third value into both slots — the Apple divergence bug, where a
   * Mac reading an iOS-minted credential returns a PRF neither slot's cross-device read reproduces.
   */
  divergent?: boolean
  /** Overrides the attachment the route implies; `null` reports none. */
  attachment?: PasskeyAttachment | null
  /** Overrides the attachment reported on assertions only. */
  assertAttachment?: PasskeyAttachment | null
  /** `"unknown"` makes the flags unreadable on every response. */
  backupEligible?: boolean | "unknown"
  /** When false the provider returns only `first`, as a one-salt provider would. */
  secondSlot?: boolean
  /** When false the create response carries no readable authenticator data. */
  createAuthData?: boolean
  /** The provider id the create response reports; absent by default. */
  aaguid?: string
  /** The transports the create response reports; absent by default, and never on an assertion. */
  transports?: readonly string[]
  /**
   * Bytes of signed extension output appended to the authenticator-data header, as an authenticator
   * that answers a PRF request with `hmac-secret` would. They go in before the signature is made,
   * so the response really is signed over the longer buffer — appending them afterwards would
   * describe a signature no authenticator produces. Only a request carrying PRF salts gets them,
   * which is the condition a real authenticator applies.
   */
  extensionBytes?: number
  /** Append them to every assertion, salts or not — an authenticator no witness format can carry. */
  extensionsAlways?: boolean
  /**
   * Hears each call as the browser ceremony's hook would: `issued`, then `answered` with evidence
   * from the result, or `issued` alone when the call rejects.
   */
  onRequest?: PasskeyRequestHook
  /**
   * Fixed authenticator data with a zero counter. With deterministic ECDSA, signing the same message
   * twice then yields the identical signature — what a zero-counter authenticator can do.
   */
  stableAuthenticator?: boolean
  /**
   * Answers the next assertion only, then is cleared: returns the credential that answers (any
   * created one, whatever the request pinned), or throws to end the sheet the way the browser would
   * (`new DOMException("Dismissed", "NotAllowedError")`).
   */
  assertOverride?: (request: PasskeyAssertRequest) => string
}

/** Deterministic authenticator: real P-256 signatures, PRF from a per-credential secret. */
export class FakePasskeyCeremony implements PasskeyCeremony {
  creds = new Map<string, { priv: Uint8Array; secret: Uint8Array }>()
  creates: PasskeyCreateRequest[] = []
  assertRequests: PasskeyAssertRequest[] = []
  /** Every assertion's `credentialIds`, in order: what the browser would show a picker for. */
  asserts: (string[] | undefined)[] = []

  constructor(public opts: FakeCeremonyOptions = {}) {}

  get manager(): FakeManager {
    return this.opts.manager ?? "icloud"
  }
  get route(): FakeRoute {
    return this.opts.route ?? "local"
  }

  /** The route an assertion answers over: its own request when `routeFromRequest`, else the fixed one. */
  private routeFor(request?: PasskeyAssertRequest): FakeRoute {
    if (!this.opts.routeFromRequest || !request) return this.route
    return request.hints?.includes("client-device") ? "local" : "cross-device"
  }

  private attachment(forAssert: boolean, route: FakeRoute): PasskeyAttachment | undefined {
    const override =
      forAssert && this.opts.assertAttachment !== undefined
        ? this.opts.assertAttachment
        : this.opts.attachment
    if (override === null) return undefined
    if (override) return override
    return route === "local" ? "platform" : "cross-platform"
  }

  private backupEligible(): boolean | undefined {
    const be = this.opts.backupEligible ?? true
    return be === "unknown" ? undefined : be
  }

  /** The PRF this fake returns for `slot` on `route` (what the caller's salt for that slot yields). */
  prfFor(
    credentialId: string,
    slot: "first" | "second",
    route: FakeRoute = this.route,
  ): Uint8Array {
    const cred = this.creds.get(credentialId)
    if (!cred) throw new Error(`unknown credential ${credentialId}`)
    const salt = slot === "first" ? MSK_PRF_SALT : contextualiseLocal(MSK_PRF_SALT)
    return fakePrf(cred.secret, salt, this.manager, route)
  }

  private prfOutputs(
    credentialId: string,
    request: { prfFirstSalt?: Uint8Array; prfSecondSalt?: Uint8Array },
    route: FakeRoute = this.route,
  ) {
    const cred = this.creds.get(credentialId)!
    // On the local route a diverged authenticator returns a third value, matching nothing a
    // cross-device read reproduces, so an anchor refuses it.
    const diverge = this.opts.divergent && route === "local"
    const prf = (salt: Uint8Array) => {
      const value = fakePrf(cred.secret, salt, this.manager, route)
      return diverge ? contextualiseLocal(value) : value
    }
    const out: { prfFirst?: Uint8Array; prfSecond?: Uint8Array } = {}
    if (request.prfFirstSalt) out.prfFirst = prf(request.prfFirstSalt)
    if (request.prfSecondSalt && (this.opts.secondSlot ?? true)) {
      out.prfSecond = prf(request.prfSecondSalt)
    }
    return out
  }

  private authData(prfRequested = true): Uint8Array {
    const be = this.backupEligible()
    if (be === undefined) return new Uint8Array(20)
    const extra = prfRequested || this.opts.extensionsAlways ? this.opts.extensionBytes ?? 0 : 0
    const buf = this.opts.stableAuthenticator
      ? new Uint8Array(37 + extra)
      : crypto.getRandomValues(new Uint8Array(37 + extra))
    // Flags: bit 7 marks extension data present, which is what makes the trailing bytes signed
    // content rather than padding.
    buf[32] = (be ? 0x1d : 0x05) | (extra > 0 ? 0x80 : 0)
    return buf
  }

  /** A hook that throws is ignored, as the browser ceremony ignores it. */
  private notify(signal: PasskeyRequestSignal): void {
    try {
      this.opts.onRequest?.(signal)
    } catch {
      // Ignored.
    }
  }

  async create(request: PasskeyCreateRequest): Promise<PasskeyCreateResult> {
    this.creates.push(request)
    this.notify({ phase: "issued", kind: "create", request })
    const priv = p256.utils.randomPrivateKey()
    const credentialId = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)))
    this.creds.set(credentialId, { priv, secret: crypto.getRandomValues(new Uint8Array(32)) })
    const result: PasskeyCreateResult = {
      credentialId,
      pubkey: p256.getPublicKey(priv, false).slice(1),
      ...(this.opts.prfAtCreate ?? true ? this.prfOutputs(credentialId, request, this.route) : {}),
      authenticatorAttachment: this.attachment(false, this.route),
      backupEligible: this.opts.createAuthData ?? true ? this.backupEligible() : undefined,
      ...(this.opts.aaguid ? { aaguid: this.opts.aaguid } : {}),
      transports: this.opts.transports,
    }
    this.notify({
      phase: "answered",
      kind: "create",
      request,
      evidence: {
        authenticatorAttachment: result.authenticatorAttachment,
        backupEligible: result.backupEligible,
        aaguid: result.aaguid,
        transports: result.transports,
      },
    })
    return result
  }

  async assert(request: PasskeyAssertRequest): Promise<PasskeyAssertResult> {
    request.signal?.throwIfAborted()
    this.asserts.push(request.credentialIds)
    this.assertRequests.push(request)
    this.notify({ phase: "issued", kind: "assert", request })
    const override = this.opts.assertOverride
    this.opts.assertOverride = undefined
    const credentialId = override
      ? override(request)
      : request.credentialIds?.[0] ?? [...this.creds.keys()][0]!
    const cred = this.creds.get(credentialId)
    if (!cred) throw new Error(`unknown credential ${credentialId}`)
    const route = this.routeFor(request)
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.get", challenge: bytesToBase64Url(request.challenge) }),
    )
    const authenticatorData = this.authData(
      request.prfFirstSalt !== undefined || request.prfSecondSalt !== undefined,
    )
    const cdjHash = await sha256(clientDataJSON)
    const payload = new Uint8Array(authenticatorData.length + 32)
    payload.set(authenticatorData, 0)
    payload.set(cdjHash, authenticatorData.length)
    const signature = p256.sign(await sha256(payload), cred.priv)
    const result: PasskeyAssertResult = {
      credentialId,
      ...(this.opts.prfAtAssert ?? true ? this.prfOutputs(credentialId, request, route) : {}),
      authenticatorAttachment: this.attachment(true, route),
      backupEligible: this.backupEligible(),
      signatureDer: signature.toDERRawBytes(),
      authenticatorData,
      clientDataJSON,
    }
    this.notify({
      phase: "answered",
      kind: "assert",
      request,
      evidence: {
        authenticatorAttachment: result.authenticatorAttachment,
        backupEligible: result.backupEligible,
      },
    })
    return result
  }
}
