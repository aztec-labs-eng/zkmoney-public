// @vitest-environment node
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type Address, type Hex, bytesToHex, concat, hexToBytes, keccak256 } from "viem"
import { passkeyMetadata } from "@oxide/oxide-client/passkey_rotation.js"
import { MSK_PRF_SALT } from "@obsidion/core/constants"
import type { PrfSlot } from "@obsidion/core/types"

import {
  PASSKEY_ENVELOPE_BYTES,
  PASSKEY_ENVELOPE_VERSION,
  PasskeyEnvelopeError,
  credentialIdHash,
  envelopeSlot,
  matchKind,
  openMasterKey,
  parseKeyMetadata,
  sealMasterKey,
} from "../../src/oxide/passkeyEnvelope"
import { credentialIdToMetadata } from "../../src/oxide/oxideWebAuthn"

const ACCOUNT: Address = "0x2222222222222222222222222222222222222222"
const OTHER_ACCOUNT: Address = "0x3333333333333333333333333333333333333333"
const MASTER_KEY = hexToBytes(`0x${"ab".repeat(32)}`)
const PRF = hexToBytes(`0x${"c1".repeat(32)}`)
const OTHER_PRF = hexToBytes(`0x${"c2".repeat(32)}`)

const toBase64Url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const patterned = (len: number, seed: number) =>
  new Uint8Array(len).map((_, i) => (i * seed + 3) & 0xff)
const CRED = toBase64Url(patterned(20, 41))
const OTHER_CRED = toBase64Url(patterned(20, 43))

const seal = (overrides: Partial<Parameters<typeof sealMasterKey>[0]> = {}) =>
  sealMasterKey({
    masterKey: MASTER_KEY,
    prfOutput: PRF,
    slot: "first",
    account: ACCOUNT,
    credentialId: CRED,
    ...overrides,
  })

const open = (envelope: Uint8Array, overrides: Partial<Parameters<typeof openMasterKey>[0]> = {}) =>
  openMasterKey({
    envelope,
    prf: { first: PRF },
    account: ACCOUNT,
    credentialId: CRED,
    ...overrides,
  })

async function expectFailure(promise: Promise<unknown>, reason: "version" | "decrypt") {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(PasskeyEnvelopeError)
  expect((error as PasskeyEnvelopeError).reason).toBe(reason)
}

describe("sealMasterKey / openMasterKey", () => {
  it("round trips, with the version and the sealing slot in the header", async () => {
    for (const slot of ["first", "second"] as const) {
      const envelope = await seal({ slot })
      expect(envelope.length).toBe(PASSKEY_ENVELOPE_BYTES)
      expect(envelope[0]).toBe(PASSKEY_ENVELOPE_VERSION)
      expect(envelope[1]).toBe(slot === "first" ? 0 : 1)
      expect(envelopeSlot(envelope)).toBe(slot)
      expect(await open(envelope, { prf: { [slot]: PRF } })).toEqual(MASTER_KEY)
    }
  })

  it("uses a fresh nonce per seal, and both open", async () => {
    const a = await seal()
    const b = await seal()
    expect(bytesToHex(a)).not.toBe(bytesToHex(b))
    expect(bytesToHex(a.subarray(2, 14))).not.toBe(bytesToHex(b.subarray(2, 14)))
    expect(await open(a)).toEqual(MASTER_KEY)
    expect(await open(b)).toEqual(MASTER_KEY)
  })

  it("opens from the other slot when the header's slot is absent, and fails with no output", async () => {
    const envelope = await seal({ slot: "second" })
    expect(await open(envelope, { prf: { first: PRF } })).toEqual(MASTER_KEY)
    expect(await open(envelope, { prf: { first: OTHER_PRF, second: PRF } })).toEqual(MASTER_KEY)
    await expectFailure(open(envelope, { prf: {} }), "decrypt")
  })

  it("refuses a wrong PRF, account or credential id with `decrypt`", async () => {
    const envelope = await seal()
    await expectFailure(open(envelope, { prf: { first: OTHER_PRF, second: OTHER_PRF } }), "decrypt")
    await expectFailure(open(envelope, { account: OTHER_ACCOUNT }), "decrypt")
    await expectFailure(open(envelope, { credentialId: OTHER_CRED }), "decrypt")
  })

  it("refuses a flipped byte anywhere in nonce, ciphertext or tag with `decrypt`", async () => {
    const envelope = await seal()
    for (const i of [2, 13, 14, 45, 46, 61]) {
      const tampered = Uint8Array.from(envelope)
      tampered[i] ^= 0x01
      await expectFailure(open(tampered), "decrypt")
    }
  })

  it("refuses an unknown version, slot byte or length with `version`", async () => {
    const envelope = await seal()
    const version = Uint8Array.from(envelope)
    version[0] = 0x02
    const slot = Uint8Array.from(envelope)
    slot[1] = 0x02
    for (const bad of [
      version,
      slot,
      envelope.subarray(0, 61),
      concatBytes(envelope, new Uint8Array(1)),
    ]) {
      expect(() => envelopeSlot(bad)).toThrow(PasskeyEnvelopeError)
      expect(() => envelopeSlot(bad)).toThrow(/version/)
      await expectFailure(open(bad), "version")
    }
  })

  it("rejects a PRF or master key that is not 32 bytes before any crypto", async () => {
    const subtle = vi.spyOn(crypto.subtle, "importKey")
    await expect(seal({ masterKey: new Uint8Array(31) })).rejects.toThrow(
      /masterKey must be 32 bytes/,
    )
    await expect(seal({ prfOutput: new Uint8Array(33) })).rejects.toThrow(
      /prfOutput must be 32 bytes/,
    )
    const envelope = new Uint8Array(PASSKEY_ENVELOPE_BYTES)
    envelope[0] = PASSKEY_ENVELOPE_VERSION
    await expect(open(envelope, { prf: { first: new Uint8Array(16) } })).rejects.toThrow(
      /prf must be 32 bytes/,
    )
    expect(subtle).not.toHaveBeenCalled()
    subtle.mockRestore()
  })
})

describe("fixed vector", () => {
  afterEach(() => vi.restoreAllMocks())

  const fixture = JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/passkeyEnvelope.vector.json"),
      "utf8",
    ),
  ) as {
    prfHex: Hex
    slot: PrfSlot
    masterKeyHex: Hex
    account: Address
    credentialId: string
    nonceHex: Hex
    envelopeHex: Hex
  }

  it("seals to the exact bytes node:crypto produced, and opens them", async () => {
    const nonce = hexToBytes(fixture.nonceHex)
    vi.spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T) => {
        ;(array as unknown as Uint8Array).set(nonce)
        return array
      },
    )
    const envelope = await sealMasterKey({
      masterKey: hexToBytes(fixture.masterKeyHex),
      prfOutput: hexToBytes(fixture.prfHex),
      slot: fixture.slot,
      account: fixture.account,
      credentialId: fixture.credentialId,
    })
    expect(bytesToHex(envelope)).toBe(fixture.envelopeHex)
    vi.restoreAllMocks()
    const opened = await openMasterKey({
      envelope: hexToBytes(fixture.envelopeHex),
      prf: { [fixture.slot]: hexToBytes(fixture.prfHex) },
      account: fixture.account,
      credentialId: fixture.credentialId,
    })
    expect(bytesToHex(opened)).toBe(fixture.masterKeyHex)
  })
})

/**
 * The PRF a provider returns by manager and route, as the fake ceremony models it: the browser
 * applies K to the salt once, iCloud and GPM apply it again on the local route (GPM also over
 * cross-device), 1Password never does, a security key never does.
 */
type Manager = "icloud" | "1password" | "gpm" | "security-key"
type Route = "local" | "cross-device"
const MANAGERS: Manager[] = ["icloud", "1password", "gpm", "security-key"]
const ROUTES: Route[] = ["local", "cross-device"]

function hashesFor(manager: Manager, route: Route): number {
  if (manager === "1password") return route === "local" ? 0 : 1
  if (manager === "gpm") return route === "local" ? 1 : 2
  return 1
}

async function contextualise(x: Uint8Array): Promise<Uint8Array> {
  const prefix = new TextEncoder().encode("WebAuthn PRF")
  const buf = concatBytes(prefix, new Uint8Array([0]), x)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf))
}

async function providerPrf(secret: Uint8Array, salt: Uint8Array, manager: Manager, route: Route) {
  let input = salt
  for (let i = 0; i < hashesFor(manager, route); i++) input = await contextualise(input)
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, input))
}

async function prfPair(secret: Uint8Array, manager: Manager, route: Route) {
  return {
    first: await providerPrf(secret, MSK_PRF_SALT, manager, route),
    second: await providerPrf(secret, await contextualise(MSK_PRF_SALT), manager, route),
  }
}

describe("slot vs. route", () => {
  const SECRET = hexToBytes(`0x${"77".repeat(32)}`)

  it("opens whenever the recovery pair carries the sealing output in either slot", async () => {
    let opened = 0
    let crossSlot = 0
    for (const manager of MANAGERS) {
      for (const createRoute of ROUTES) {
        for (const recoverRoute of ROUTES) {
          for (const slot of ["first", "second"] as const) {
            const created = await prfPair(SECRET, manager, createRoute)
            const recovered = await prfPair(SECRET, manager, recoverRoute)
            const envelope = await seal({ prfOutput: created[slot], slot })
            const sealing = bytesToHex(created[slot])
            const expectOpen =
              bytesToHex(recovered.first) === sealing || bytesToHex(recovered.second) === sealing
            const result = open(envelope, { prf: recovered })
            if (expectOpen) {
              expect(await result, `${manager} ${createRoute}→${recoverRoute} ${slot}`).toEqual(
                MASTER_KEY,
              )
              opened++
              if (bytesToHex(recovered[slot]) !== sealing) crossSlot++
            } else {
              await expectFailure(result, "decrypt")
            }
          }
        }
      }
    }
    // iCloud and a security key open on every route (8 each). 1Password and GPM open on the same
    // route (4 each) and across routes only through the other slot (platform `second` returned as
    // cross-device `first`, one case per direction: 2 each).
    expect(opened).toBe(16 + 6 + 6)
    expect(crossSlot).toBe(4)
  })
})

describe("metadata readers", () => {
  const envelopeHex = `0x${"ee".repeat(PASSKEY_ENVELOPE_BYTES)}` as Hex
  const tag = bytesToHex(new TextEncoder().encode("oxide.passkey.credential-id.v1"))

  it("reads oxide's own passkeyMetadata as envelope-prefixed with the credential id's hash", () => {
    for (const id of [
      CRED,
      toBase64Url(
        Uint8Array.from([0xfb, 0xff, 0xbf, 0xfb, 0xff, 0xbf, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      ),
    ]) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
      const metadata = passkeyMetadata(credentialIdToMetadata(id), envelopeHex)
      expect(metadata.length).toBe(2 + 95 * 2)
      const parsed = parseKeyMetadata(metadata)
      expect(parsed.kind).toBe("envelope-prefixed")
      if (parsed.kind !== "envelope-prefixed") return
      expect(parsed.credentialIdHash).toBe(credentialIdHash(id))
      expect(parsed.credentialIdHash).toBe(keccak256(concat([tag, credentialIdToMetadata(id)])))
      expect(bytesToHex(parsed.envelope)).toBe(envelopeHex)
      expect(parsed.credentialId).toBeUndefined()
    }
    expect(
      toBase64Url(
        Uint8Array.from([0xfb, 0xff, 0xbf, 0xfb, 0xff, 0xbf, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      ),
    ).toMatch(/[-_]/)
  })

  it("reads the credential id appended behind the envelope when it hashes to the prefix", () => {
    for (const len of [16, 64, 1023]) {
      const id = toBase64Url(patterned(len, 71))
      const idHex = credentialIdToMetadata(id)
      const metadata = passkeyMetadata(idHex, concat([envelopeHex, idHex]))
      expect(hexToBytes(metadata).length).toBe(95 + len)
      expect(parseKeyMetadata(metadata)).toEqual({
        kind: "envelope-prefixed",
        credentialIdHash: credentialIdHash(id),
        envelope: hexToBytes(envelopeHex),
        credentialId: id,
      })
      expect(matchKind(metadata, id)).toBe("hash")
    }
    const dropped = (id: string, tail: Hex) =>
      parseKeyMetadata(passkeyMetadata(credentialIdToMetadata(id), concat([envelopeHex, tail])))
    const noId = {
      kind: "envelope-prefixed",
      credentialIdHash: credentialIdHash(CRED),
      envelope: hexToBytes(envelopeHex),
    }
    // Another credential's bytes behind the envelope: the envelope is kept, the tail is not an id.
    expect(dropped(CRED, credentialIdToMetadata(OTHER_CRED))).toEqual(noId)
    // A tail too short to be an id, even one that hashes to the prefix.
    const short = toBase64Url(patterned(15, 73))
    expect(dropped(short, credentialIdToMetadata(short))).toEqual({
      ...noId,
      credentialIdHash: credentialIdHash(short),
    })
    expect(dropped(CRED, `0x${"5c".repeat(8)}`)).toEqual(noId)
  })

  it("reads a raw credential id back as credential-id", () => {
    for (const len of [16, 64]) {
      const id = toBase64Url(patterned(len, 59))
      expect(parseKeyMetadata(credentialIdToMetadata(id))).toEqual({
        kind: "credential-id",
        credentialId: id,
      })
    }
  })

  it("judges by length and first byte only", () => {
    const prefixed = (len: number) =>
      bytesToHex(new Uint8Array(len).fill(0x5c).map((b, i) => (i === 0 ? 0x01 : b)))
    const raw20 = patterned(20, 61)
    raw20[0] = 0x01
    expect(parseKeyMetadata(bytesToHex(raw20))).toEqual({
      kind: "credential-id",
      credentialId: toBase64Url(raw20),
    })
    const raw40 = parseKeyMetadata(prefixed(40))
    expect(raw40.kind).toBe("envelope-prefixed")
    if (raw40.kind === "envelope-prefixed") expect(raw40.envelope.length).toBe(7)
    // A payload shorter than an envelope is kept whole; a longer one is cut at the envelope's length.
    for (const [len, envelopeLen] of [
      [94, 61],
      [96, 62],
      [200, 62],
    ] as const) {
      const parsed = parseKeyMetadata(prefixed(len))
      expect(parsed.kind).toBe("envelope-prefixed")
      if (parsed.kind !== "envelope-prefixed") return
      expect(parsed.envelope.length).toBe(envelopeLen)
      expect(parsed.credentialId).toBeUndefined()
      expect(() => envelopeSlot(parsed.envelope)).toThrow(/version/)
    }
    expect(parseKeyMetadata("0x")).toEqual({ kind: "unknown" })
    expect(parseKeyMetadata(bytesToHex(new Uint8Array(8)))).toEqual({ kind: "unknown" })
    expect(parseKeyMetadata(bytesToHex(new Uint8Array(1024)))).toEqual({ kind: "unknown" })
    const v2 = new Uint8Array(95).fill(0x5c)
    v2[0] = 0x02
    expect(parseKeyMetadata(bytesToHex(v2))).toEqual({
      kind: "credential-id",
      credentialId: toBase64Url(v2),
    })
  })

  it("matchKind: raw equality first, then the prefixed hash", () => {
    const raw = credentialIdToMetadata(CRED)
    expect(matchKind(raw, CRED)).toBe("raw")
    expect(matchKind(raw.toUpperCase().replace("0X", "0x") as Hex, CRED)).toBe("raw")
    expect(matchKind(raw, OTHER_CRED)).toBeUndefined()
    const prefixedEntry = passkeyMetadata(credentialIdToMetadata(CRED), envelopeHex)
    expect(matchKind(prefixedEntry, CRED)).toBe("hash")
    expect(matchKind(prefixedEntry, OTHER_CRED)).toBeUndefined()
    const raw40 = patterned(40, 67)
    raw40[0] = 0x01
    expect(matchKind(bytesToHex(raw40), toBase64Url(raw40))).toBe("raw")
    const short = passkeyMetadata(credentialIdToMetadata(CRED), `0x${"ee".repeat(61)}`)
    expect(hexToBytes(short).length).toBe(94)
    expect(matchKind(short, CRED)).toBe("hash")
  })
})

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}
