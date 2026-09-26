import { describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import type { AuthKeyEntry } from "@oxide/l1-contracts"

import { credentialIdToMetadata } from "../../src/oxide/oxideWebAuthn"
import {
  authKeyToCandidate,
  metadataToCredentialId,
  readPasskeyCredentialsByTag,
} from "../../src/oxide/passkeyCredentialByTag"
import {
  TagValidationError,
  type RegistryTagResolution,
} from "../../src/core/services/RegistryTagResolver"

const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address
const L2 = `0x${"11".repeat(32)}`
const QX = `0x${"ab".repeat(32)}` as Hex
const QY = `0x${"cd".repeat(32)}` as Hex

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function bytesOf(len: number, seed = 7): Uint8Array {
  return new Uint8Array(len).map((_, i) => (i * 131 + seed) & 0xff)
}

function key(metadata: Hex, over: Partial<AuthKeyEntry["key"]> = {}): AuthKeyEntry {
  return { key: { qx: QX, qy: QY, ...over }, metadata }
}

const resolved: RegistryTagResolution = {
  status: "resolved",
  account: ACCOUNT,
  l2Address: L2,
  rollupId: "1",
  sipaStealthPublicKey: { x: 1n, y: 2n },
  xmtpAddress: "0x00000000000000000000000000000000000000b0",
}

function reader(opts: {
  resolve?: RegistryTagResolution | Error
  keys?: readonly AuthKeyEntry[] | Error
  /** The account's total key count, when the read is truncated (defaults to the entries' length). */
  authKeyCount?: number
}) {
  const resolveTag = vi.fn(async () => {
    if (opts.resolve instanceof Error) throw opts.resolve
    return opts.resolve ?? resolved
  })
  const readAuthKeys = vi.fn(async () => {
    if (opts.keys instanceof Error) throw opts.keys
    const entries = opts.keys ?? []
    return { entries, authKeyCount: opts.authKeyCount ?? entries.length }
  })
  return { resolveTag, readAuthKeys }
}

describe("metadataToCredentialId", () => {
  it("is the byte inverse of credentialIdToMetadata on the encoder's own vectors", () => {
    const eleven = toBase64Url(new TextEncoder().encode("cred-id-001"))
    expect(metadataToCredentialId(credentialIdToMetadata(eleven))).toBe(eleven)
    for (let len = 1; len <= 64; len++) {
      const id = toBase64Url(bytesOf(len))
      expect(metadataToCredentialId(credentialIdToMetadata(id))).toBe(id)
    }
  })

  it("round-trips a 64-byte id and one whose alphabet needs - and _", () => {
    const wide = toBase64Url(bytesOf(64, 3))
    expect(metadataToCredentialId(credentialIdToMetadata(wide))).toBe(wide)
    const url = toBase64Url(Uint8Array.from([0xfb, 0xff, 0xbf]))
    expect(url).toContain("-")
    expect(url).toContain("_")
    expect(metadataToCredentialId(credentialIdToMetadata(url))).toBe(url)
  })

  it("throws on empty, unprefixed or malformed hex", () => {
    expect(() => metadataToCredentialId("0x")).toThrow(/hex/)
    expect(() => metadataToCredentialId("0xabc")).toThrow(/hex/)
    expect(() => metadataToCredentialId("abcd" as Hex)).toThrow(/hex/)
    expect(() => metadataToCredentialId("zz" as Hex)).toThrow(/hex/)
  })
})

describe("authKeyToCandidate", () => {
  it("yields the credential id and the key as 128 lowercase hex chars without 0x", () => {
    const id = toBase64Url(bytesOf(16))
    const candidate = authKeyToCandidate(key(credentialIdToMetadata(id)))
    expect(candidate).toEqual({
      credentialId: id,
      pubkeyHex: `${"ab".repeat(32)}${"cd".repeat(32)}`,
    })
    expect(candidate!.pubkeyHex).toHaveLength(128)
  })

  it("drops empty, too-short and too-long ids", () => {
    expect(authKeyToCandidate(key("0x"))).toBeUndefined()
    expect(
      authKeyToCandidate(key(credentialIdToMetadata(toBase64Url(bytesOf(11))))),
    ).toBeUndefined()
    expect(
      authKeyToCandidate(key(credentialIdToMetadata(toBase64Url(bytesOf(1024))))),
    ).toBeUndefined()
    expect(
      authKeyToCandidate(key(credentialIdToMetadata(toBase64Url(bytesOf(1023))))),
    ).toBeDefined()
  })
})

describe("readPasskeyCredentialsByTag", () => {
  const eligible = (seed: number) => key(credentialIdToMetadata(toBase64Url(bytesOf(16, seed))))

  it("one eligible key → resolved with the candidate, account and L2 address", async () => {
    const deps = reader({ keys: [eligible(1)] })
    const out = await readPasskeyCredentialsByTag("Alice", deps)
    expect(out).toEqual({
      kind: "resolved",
      account: ACCOUNT,
      l2Address: L2,
      candidates: [{ credentialId: toBase64Url(bytesOf(16, 1)), pubkeyHex: expect.any(String) }],
      complete: true,
      authKeyCount: 1,
    })
    expect(deps.resolveTag).toHaveBeenCalledWith("Alice")
    expect(deps.readAuthKeys).toHaveBeenCalledWith(ACCOUNT)
  })

  it("two keys → two candidates in on-chain order", async () => {
    const out = await readPasskeyCredentialsByTag(
      "alice",
      reader({ keys: [eligible(1), eligible(2)] }),
    )
    expect(out.kind).toBe("resolved")
    if (out.kind !== "resolved") return
    expect(out.candidates.map((c) => c.credentialId)).toEqual([
      toBase64Url(bytesOf(16, 1)),
      toBase64Url(bytesOf(16, 2)),
    ])
  })

  it("drops ineligible entries and keeps the eligible one", async () => {
    const out = await readPasskeyCredentialsByTag(
      "alice",
      reader({ keys: [key("0x"), eligible(1)] }),
    )
    expect(out.kind).toBe("resolved")
    if (out.kind !== "resolved") return
    expect(out.candidates).toHaveLength(1)
    // The dropped entry is still one of the account's keys.
    expect(out.authKeyCount).toBe(2)
  })

  it("only ineligible entries → unreadable", async () => {
    const short = key(credentialIdToMetadata(toBase64Url(bytesOf(11))))
    const out = await readPasskeyCredentialsByTag("alice", reader({ keys: [key("0x"), short] }))
    expect(out).toEqual({ kind: "unreadable", account: ACCOUNT, complete: true })
  })

  it("a read the account's count outruns is marked incomplete", async () => {
    // Eight ineligible entries read, but nine keys installed: the ninth went unread.
    const eight = Array.from({ length: 8 }, () => key("0x"))
    const out = await readPasskeyCredentialsByTag("alice", reader({ keys: eight, authKeyCount: 9 }))
    expect(out).toEqual({ kind: "unreadable", account: ACCOUNT, complete: false })

    // One eligible key read but more installed than fit: resolved, but not the full set.
    const resolvedOut = await readPasskeyCredentialsByTag(
      "alice",
      reader({ keys: [eligible(1)], authKeyCount: 9 }),
    )
    expect(resolvedOut.kind).toBe("resolved")
    if (resolvedOut.kind === "resolved") expect(resolvedOut.complete).toBe(false)
  })

  it("caps at eight candidates but scans past ineligible entries to find them", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => eligible(i + 1))
    const capped = await readPasskeyCredentialsByTag("alice", reader({ keys: nine }))
    expect(capped.kind).toBe("resolved")
    if (capped.kind === "resolved") {
      expect(capped.candidates.map((c) => c.credentialId)).toEqual(
        nine.slice(0, 8).map((k) => metadataToCredentialId(k.metadata)),
      )
    }
    const late = [...Array.from({ length: 8 }, () => key("0x")), eligible(1)]
    const found = await readPasskeyCredentialsByTag("alice", reader({ keys: late }))
    expect(found.kind).toBe("resolved")
    if (found.kind === "resolved") expect(found.candidates).toHaveLength(1)
  })

  it("no keys → noKeyInstalled", async () => {
    expect(await readPasskeyCredentialsByTag("alice", reader({ keys: [] }))).toEqual({
      kind: "noKeyInstalled",
      account: ACCOUNT,
    })
  })

  it("notFound and staleRollup pass through; an invalid tag is notFound", async () => {
    expect(
      await readPasskeyCredentialsByTag("alice", reader({ resolve: { status: "notFound" } })),
    ).toEqual({ kind: "notFound" })
    expect(
      await readPasskeyCredentialsByTag("alice", reader({ resolve: { status: "staleRollup" } })),
    ).toEqual({ kind: "staleRollup" })
    const deps = reader({ resolve: new TagValidationError("Invalid tag: !!") })
    expect(await readPasskeyCredentialsByTag("!!", deps)).toEqual({ kind: "notFound" })
    expect(deps.readAuthKeys).not.toHaveBeenCalled()
  })

  it("transport failures from either read propagate", async () => {
    await expect(
      readPasskeyCredentialsByTag("alice", reader({ resolve: new Error("RPC down") })),
    ).rejects.toThrow(/RPC down/)
    await expect(
      readPasskeyCredentialsByTag("alice", reader({ keys: new Error("RPC down") })),
    ).rejects.toThrow(/RPC down/)
  })
})
