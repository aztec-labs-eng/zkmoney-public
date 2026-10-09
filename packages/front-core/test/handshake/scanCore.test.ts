import { describe, expect, it, vi } from "vitest"
import {
  ContactStorage,
  runQRHandshakeScan,
  withReentrancyGuard,
  buildScannedContact,
  navigateIdFor,
  isSupportedConnectVersion,
  matchesRegistry,
  ERR_INVALID,
  ERR_TAG_MISMATCH,
  ERR_SCAN_IN_FLIGHT,
  type HandshakeInlinePacket,
  type QRHandshakeScanDeps,
  type ReentrancyGuard,
} from "../../src/index.js"

/**
 * Serverless scanner-flow test. The pure `runQRHandshakeScan` core composes the
 * injected decodeInline + add + connect-back collaborators and emits a
 * discriminated result the React layer navigates on. `decodeInline` is mocked
 * here, so the fake (non-canonical) addresses below never hit the real codec.
 */

const CONNECT_BACK_VERSION = 1
const FIXED_UUID = "deadbeef-cafe-400d-8011-223344556677"
const SHARER_XMTP = "0xSHARER0000000000000000000000000000000001"
const SHARER_L2 = "0xL2SHARER"
const PKT = "Zm9vYmFyYmF6cXV4" // an opaque base64url packet token (mock ignores it)

// A well-formed handshake link the scanner emits as the raw QR string. The host carries no
// identity, so the tagged / tag-less distinction lives in the decoded packet, not here.
const CONNECT_LINK = `https://wallet.staging.zk.money/connect#${PKT}`
// A legacy bare-tag link the OLD `openTag` path handles.
const BARE_TAG_LINK = "https://bob.zk.money"

function packet(overrides: Partial<HandshakeInlinePacket> = {}): HandshakeInlinePacket {
  return {
    version: "1.0:testnet",
    kind: "handshake",
    xmtpHandle: SHARER_XMTP,
    uuid: FIXED_UUID,
    l2Address: SHARER_L2,
    tag: "alice",
    ...overrides,
  }
}

function makeDeps(overrides: Partial<QRHandshakeScanDeps> = {}): {
  deps: QRHandshakeScanDeps
  decodeInline: ReturnType<typeof vi.fn>
  addOrMergeContact: ReturnType<typeof vi.fn>
  sendConnectBack: ReturnType<typeof vi.fn>
} {
  const decodeInline = vi.fn(() => packet())
  const addOrMergeContact = vi.fn(async (entry) => entry)
  const sendConnectBack = vi.fn(async () => ({ ok: true, messageId: "m1" }))

  const deps: QRHandshakeScanDeps = {
    decodeInline: decodeInline as unknown as QRHandshakeScanDeps["decodeInline"],
    addOrMergeContact: addOrMergeContact as unknown as QRHandshakeScanDeps["addOrMergeContact"],
    sendConnectBack: sendConnectBack as unknown as QRHandshakeScanDeps["sendConnectBack"],
    connectBackVersion: CONNECT_BACK_VERSION,
    ownXmtpHandle: "0xME0000000000000000000000000000000000aaaa",
    ownL2Address: "0xL2ME",
    log: () => {},
    ...overrides,
  }
  return { deps, decodeInline, addOrMergeContact, sendConnectBack }
}

// `sendConnectBack` is fire-and-forget (kicked off with `void` inside the
// core), so a microtask flush lets its mock settle before we assert on it.
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("runQRHandshakeScan (serverless scanner flow)", () => {
  it("happy: scan → decode packet → add sharer → exactly one connect-back with the UUID → navigate", async () => {
    const { deps, decodeInline, addOrMergeContact, sendConnectBack } = makeDeps()

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    // Decoded locally from the fragment packet — no server fetch.
    expect(decodeInline).toHaveBeenCalledTimes(1)
    expect(decodeInline).toHaveBeenCalledWith(PKT)

    expect(addOrMergeContact).toHaveBeenCalledTimes(1)
    expect(addOrMergeContact).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "alice",
        tag: "alice",
        address: SHARER_L2,
        addressKind: "aztec-l2",
        provenance: "qr-scan",
      }),
    )

    expect(sendConnectBack).toHaveBeenCalledTimes(1)
    expect(sendConnectBack).toHaveBeenCalledWith(SHARER_XMTP, {
      version: CONNECT_BACK_VERSION,
      uuid: FIXED_UUID,
    })

    expect(result.kind).toBe("handshake")
    if (result.kind === "handshake") {
      expect(result.navigateId).toBe("alice")
    }
  })

  it("stamps a valid ownTag onto the connect-back and omits an invalid one", async () => {
    const { deps, sendConnectBack } = makeDeps({ ownTag: "@Bob" })
    await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()
    expect(sendConnectBack).toHaveBeenCalledWith(SHARER_XMTP, {
      version: CONNECT_BACK_VERSION,
      uuid: FIXED_UUID,
      tag: "bob",
    })

    const invalid = makeDeps({ ownTag: "-nope" })
    await runQRHandshakeScan(CONNECT_LINK, invalid.deps)
    await flush()
    expect(invalid.sendConnectBack).toHaveBeenCalledWith(SHARER_XMTP, {
      version: CONNECT_BACK_VERSION,
      uuid: FIXED_UUID,
    })
  })

  it("logs the added contact's info on a successful scan", async () => {
    const log = vi.fn()
    const { deps } = makeDeps({ log })

    await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(log).toHaveBeenCalledWith(
      "[useQRHandshakeScan] added contact from QR scan",
      expect.objectContaining({
        name: "alice",
        tag: "alice",
        address: SHARER_L2,
        addressKind: "aztec-l2",
        provenance: "qr-scan",
        sharerXmtpHandle: SHARER_XMTP,
        uuid: FIXED_UUID,
      }),
    )
  })

  it("registry: tag resolves and claims MATCH → contact verified:true, connect-back sent", async () => {
    const verifyTag = vi.fn(async () => ({ l2Address: SHARER_L2, xmtpAddress: SHARER_XMTP }))
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({ verifyTag })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(verifyTag).toHaveBeenCalledWith("alice")
    expect(addOrMergeContact).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "alice", verified: true }),
    )
    expect(sendConnectBack).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe("handshake")
  })

  it("registry: packet omits L2 but tag resolves → stores registry L2, not XMTP handle", async () => {
    const verifyTag = vi.fn(async () => ({ l2Address: SHARER_L2, xmtpAddress: SHARER_XMTP }))
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({
      decodeInline: (() =>
        packet({ l2Address: undefined })) as unknown as QRHandshakeScanDeps["decodeInline"],
      verifyTag,
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(addOrMergeContact).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "alice",
        tag: "alice",
        address: SHARER_L2,
        addressKind: "aztec-l2",
        verified: true,
      }),
    )
    expect(sendConnectBack).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe("handshake")
  })

  it("registry: tag resolves but L2 address MISMATCHES → reject, no add, no connect-back", async () => {
    const verifyTag = vi.fn(async () => ({ l2Address: "0xNOTTHESHARER", xmtpAddress: SHARER_XMTP }))
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({ verifyTag })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(result).toEqual({ kind: "error", message: ERR_TAG_MISMATCH })
    expect(addOrMergeContact).not.toHaveBeenCalled()
    expect(sendConnectBack).not.toHaveBeenCalled()
  })

  it("registry: tag resolves but XMTP handle MISMATCHES → reject, no add, no connect-back", async () => {
    const verifyTag = vi.fn(async () => ({ l2Address: SHARER_L2, xmtpAddress: "0ximposter" }))
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({ verifyTag })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(result).toEqual({ kind: "error", message: ERR_TAG_MISMATCH })
    expect(addOrMergeContact).not.toHaveBeenCalled()
    expect(sendConnectBack).not.toHaveBeenCalled()
  })

  it("registry: tag NOT registered (null = non-discoverable) → add verified:false, connect-back sent", async () => {
    const verifyTag = vi.fn(async () => null)
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({ verifyTag })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(verifyTag).toHaveBeenCalledWith("alice")
    expect(addOrMergeContact).toHaveBeenCalledWith(expect.objectContaining({ verified: false }))
    expect(sendConnectBack).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe("handshake")
  })

  it("registry: transient failure (verifyTag throws) → FAIL OPEN, add verified:false, connect-back sent", async () => {
    const verifyTag = vi.fn(async () => {
      throw new Error("ens-gateway /resolve-l2 failed (503)")
    })
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({ verifyTag })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(addOrMergeContact).toHaveBeenCalledWith(expect.objectContaining({ verified: false }))
    expect(sendConnectBack).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe("handshake")
  })

  it("registry: tag-less packet → verify skipped (verifyTag not called), add verified:false (lower-trust path)", async () => {
    const verifyTag = vi.fn(async () => ({ l2Address: SHARER_L2, xmtpAddress: SHARER_XMTP }))
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({
      verifyTag,
      decodeInline: (() =>
        packet({ tag: undefined })) as unknown as QRHandshakeScanDeps["decodeInline"],
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    // No registry integrity guard for a tag-less packet — accepted, documented.
    expect(verifyTag).not.toHaveBeenCalled()
    expect(addOrMergeContact).toHaveBeenCalledWith(expect.objectContaining({ verified: false }))
    expect(sendConnectBack).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe("handshake")
  })

  it("matchesRegistry: agreeing l2 + xmtp → match; either contradiction → mismatch; no overlap → indeterminate", () => {
    expect(matchesRegistry(packet(), { l2Address: SHARER_L2, xmtpAddress: SHARER_XMTP })).toBe(
      "match",
    )
    expect(
      matchesRegistry(packet(), {
        l2Address: SHARER_L2.toUpperCase(),
        xmtpAddress: SHARER_XMTP.toUpperCase(),
      }),
    ).toBe("match")
    expect(matchesRegistry(packet(), { l2Address: "0xwrong" })).toBe("mismatch")
    expect(matchesRegistry(packet(), { xmtpAddress: "0xwrong" })).toBe("mismatch")
    expect(matchesRegistry(packet(), {})).toBe("indeterminate")
  })

  it("edge: sharer already a contact → no-op add, connect-back still sent", async () => {
    const existing = buildScannedContact(packet())!
    const addOrMergeContact = vi.fn(async () => existing)
    const { deps, sendConnectBack } = makeDeps({
      addOrMergeContact: addOrMergeContact as unknown as QRHandshakeScanDeps["addOrMergeContact"],
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(addOrMergeContact).toHaveBeenCalledTimes(1)
    expect(sendConnectBack).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe("handshake")
  })

  it.each([
    ["another tag", { name: "Alice", tag: "alice2", address: SHARER_L2 }],
    ["no tag", { name: "alice", address: SHARER_L2 }],
  ])(
    "conflict: the stored row that matched has %s → conflict, no connect-back, nothing queued",
    async (_, existing) => {
      const enqueueFailedConnectBack = vi.fn(async () => {})
      const { deps, sendConnectBack } = makeDeps({
        addOrMergeContact: (async () => existing) as QRHandshakeScanDeps["addOrMergeContact"],
        enqueueFailedConnectBack,
      })

      const result = await runQRHandshakeScan(CONNECT_LINK, deps)
      await flush()

      expect(result).toEqual({ kind: "conflict", contact: existing })
      expect(sendConnectBack).not.toHaveBeenCalled()
      expect(enqueueFailedConnectBack).not.toHaveBeenCalled()
    },
  )

  it("edge: self-scan (own xmtp handle) → ignored (no add, no connect-back)", async () => {
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({
      decodeInline: (() =>
        packet({
          xmtpHandle: "0xME0000000000000000000000000000000000AAAA",
        })) as unknown as QRHandshakeScanDeps["decodeInline"],
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(result.kind).toBe("self-scan")
    expect(addOrMergeContact).not.toHaveBeenCalled()
    expect(sendConnectBack).not.toHaveBeenCalled()
  })

  it("edge: self-scan (own L2 address) → ignored", async () => {
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({
      decodeInline: (() =>
        packet({
          xmtpHandle: SHARER_XMTP,
          l2Address: "0xL2ME",
        })) as unknown as QRHandshakeScanDeps["decodeInline"],
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(result.kind).toBe("self-scan")
    expect(addOrMergeContact).not.toHaveBeenCalled()
    expect(sendConnectBack).not.toHaveBeenCalled()
  })

  it("error: a tampered / garbage packet → decode throws → Invalid QR, no add, no connect-back", async () => {
    const decodeInline = vi.fn(() => {
      throw new Error("Invalid handshake packet")
    })
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({
      decodeInline: decodeInline as unknown as QRHandshakeScanDeps["decodeInline"],
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(result).toEqual({ kind: "error", message: ERR_INVALID })
    expect(addOrMergeContact).not.toHaveBeenCalled()
    expect(sendConnectBack).not.toHaveBeenCalled()
  })

  it("error: an unsupported kind (future privacy) → Invalid QR, no add, no connect-back", async () => {
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({
      // A kind the codec might one day emit but the scanner doesn't yet handle.
      decodeInline: (() =>
        packet({
          kind: "privacy" as unknown as HandshakeInlinePacket["kind"],
        })) as unknown as QRHandshakeScanDeps["decodeInline"],
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(result).toEqual({ kind: "error", message: ERR_INVALID })
    expect(addOrMergeContact).not.toHaveBeenCalled()
    expect(sendConnectBack).not.toHaveBeenCalled()
  })

  it("error: unknown connect version → rejected as Invalid QR, no add, no connect-back (R2/R11)", async () => {
    const { deps, addOrMergeContact, sendConnectBack } = makeDeps({
      decodeInline: (() =>
        packet({ version: "9.9:testnet" })) as unknown as QRHandshakeScanDeps["decodeInline"],
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(result).toEqual({ kind: "error", message: ERR_INVALID })
    expect(addOrMergeContact).not.toHaveBeenCalled()
    expect(sendConnectBack).not.toHaveBeenCalled()
  })

  it("integration: a /connect# scan does NOT trigger the bare-tag path (exactly one decode/add, no double-fire)", async () => {
    const { deps, decodeInline, addOrMergeContact } = makeDeps()

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(decodeInline).toHaveBeenCalledTimes(1)
    expect(addOrMergeContact).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe("handshake")
    expect(result.kind).not.toBe("not-a-connect")
  })

  it("fallback: a bare-tag link is NOT a connect → falls back to the legacy openTag path (no decode)", async () => {
    const { deps, decodeInline, addOrMergeContact, sendConnectBack } = makeDeps()

    const result = await runQRHandshakeScan(BARE_TAG_LINK, deps)
    await flush()

    expect(decodeInline).not.toHaveBeenCalled()
    expect(addOrMergeContact).not.toHaveBeenCalled()
    expect(sendConnectBack).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: "not-a-connect", bareTag: "bob" })
  })

  it("fire-and-forget: a recipient-not-reachable connect-back still yields a handshake result", async () => {
    const sendConnectBack = vi.fn(async () => ({
      ok: false,
      reason: "recipient-not-reachable",
    }))
    const { deps } = makeDeps({
      sendConnectBack: sendConnectBack as unknown as QRHandshakeScanDeps["sendConnectBack"],
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(sendConnectBack).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe("handshake")
  })

  it("fire-and-forget: a rejected connect-back does NOT error the flow", async () => {
    const sendConnectBack = vi.fn(async () => {
      throw new Error("network blip mid-send")
    })
    const { deps } = makeDeps({
      sendConnectBack: sendConnectBack as unknown as QRHandshakeScanDeps["sendConnectBack"],
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(result.kind).toBe("handshake")
  })

  it("outbox: a successful (ok:true) send does NOT enqueue", async () => {
    const enqueueFailedConnectBack = vi.fn(async () => {})
    const { deps } = makeDeps({ enqueueFailedConnectBack })

    await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(enqueueFailedConnectBack).not.toHaveBeenCalled()
  })

  it("outbox: a recipient-not-reachable send enqueues {peerXmtp, content}", async () => {
    const sendConnectBack = vi.fn(async () => ({ ok: false, reason: "recipient-not-reachable" }))
    const enqueueFailedConnectBack = vi.fn(async () => {})
    const { deps } = makeDeps({
      sendConnectBack: sendConnectBack as unknown as QRHandshakeScanDeps["sendConnectBack"],
      enqueueFailedConnectBack,
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(result.kind).toBe("handshake") // scan still succeeds
    expect(enqueueFailedConnectBack).toHaveBeenCalledTimes(1)
    expect(enqueueFailedConnectBack).toHaveBeenCalledWith({
      peerXmtp: SHARER_XMTP,
      content: { version: CONNECT_BACK_VERSION, uuid: FIXED_UUID },
    })
  })

  it("outbox: a throwing send enqueues for retry", async () => {
    const sendConnectBack = vi.fn(async () => {
      throw new Error("dm.send blew up")
    })
    const enqueueFailedConnectBack = vi.fn(async () => {})
    const { deps } = makeDeps({
      sendConnectBack: sendConnectBack as unknown as QRHandshakeScanDeps["sendConnectBack"],
      enqueueFailedConnectBack,
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(result.kind).toBe("handshake")
    expect(enqueueFailedConnectBack).toHaveBeenCalledWith({
      peerXmtp: SHARER_XMTP,
      content: { version: CONNECT_BACK_VERSION, uuid: FIXED_UUID },
    })
  })

  it("tag-less packet without L2: stores a pending handshake row, no tag", async () => {
    const { deps, addOrMergeContact } = makeDeps({
      decodeInline: (() =>
        packet({
          l2Address: undefined,
          tag: undefined,
        })) as unknown as QRHandshakeScanDeps["decodeInline"],
    })

    const result = await runQRHandshakeScan(CONNECT_LINK, deps)
    await flush()

    expect(addOrMergeContact).toHaveBeenCalledWith(
      expect.objectContaining({
        name: SHARER_XMTP,
        address: SHARER_XMTP,
        addressKind: "pending-handshake",
        provenance: "qr-scan",
      }),
    )
    expect(result.kind).toBe("handshake-pending")
    if (result.kind === "handshake-pending") {
      expect(result.contact.addressKind).toBe("pending-handshake")
    }
  })
})

describe("withReentrancyGuard (synchronous same-tick double-fire guard)", () => {
  it("two concurrent scans in the same tick → only ONE handshake runs", async () => {
    const { deps, decodeInline, addOrMergeContact, sendConnectBack } = makeDeps()
    const guard: ReentrancyGuard = { inFlight: false }

    const body = () => runQRHandshakeScan(CONNECT_LINK, deps)

    const [a, b] = await Promise.all([
      withReentrancyGuard(guard, body),
      withReentrancyGuard(guard, body),
    ])
    await flush()

    expect(decodeInline).toHaveBeenCalledTimes(1)
    expect(addOrMergeContact).toHaveBeenCalledTimes(1)
    expect(sendConnectBack).toHaveBeenCalledTimes(1)

    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(["error", "handshake"])
    const shorted = [a, b].find((r) => r.kind === "error")!
    expect(shorted).toEqual({ kind: "error", message: ERR_SCAN_IN_FLIGHT })

    expect(guard.inFlight).toBe(false)
  })

  it("sequential scans (guard reset between) both run", async () => {
    const { deps, decodeInline } = makeDeps()
    const guard: ReentrancyGuard = { inFlight: false }
    const body = () => runQRHandshakeScan(CONNECT_LINK, deps)

    await withReentrancyGuard(guard, body)
    await withReentrancyGuard(guard, body)
    await flush()

    expect(decodeInline).toHaveBeenCalledTimes(2)
  })
})

describe("isSupportedConnectVersion", () => {
  it("accepts the current format part regardless of chain", () => {
    expect(isSupportedConnectVersion("1.0:testnet")).toBe(true)
    expect(isSupportedConnectVersion("1.0:sandbox")).toBe(true)
  })
  it("rejects an unknown format, empty, or non-string", () => {
    expect(isSupportedConnectVersion("9.9:testnet")).toBe(false)
    expect(isSupportedConnectVersion("")).toBe(false)
    expect(isSupportedConnectVersion(undefined as unknown as string)).toBe(false)
  })
})

describe("buildScannedContact / navigateIdFor", () => {
  it("uses the packet tag as both display name and tag", () => {
    const c = buildScannedContact(packet())
    expect(c.name).toBe("alice")
    expect(c.tag).toBe("alice")
    expect(c.address).toBe(SHARER_L2)
    expect(c.provenance).toBe("qr-scan")
    expect(navigateIdFor(c)).toBe("alice")
  })

  it("without a packet tag the contact is tag-less — and therefore inert for payments", () => {
    const c = buildScannedContact(packet({ tag: undefined }))
    expect(c.name).toBe(SHARER_XMTP)
    expect(c.tag).toBeUndefined()
    expect(navigateIdFor(c)).toBe(SHARER_L2)
  })
})

describe("runQRHandshakeScan over ContactStorage: a sender the wallet added from a transfer", () => {
  const store = () => {
    ContactStorage.resetForTests()
    const data = new Map<string, string>()
    return ContactStorage.get({
      getItem: async (k) => data.get(k) ?? null,
      setItem: async (k, v) => {
        data.set(k, v)
      },
      removeItem: async (k) => {
        data.delete(k)
      },
      clear: async () => data.clear(),
    })
  }

  it("is approved by scanning their QR", async () => {
    const contacts = store()
    await contacts.addEntry({ name: "alice", tag: "alice", address: SHARER_L2, autoAdded: true })
    const { deps } = makeDeps({ addOrMergeContact: (entry) => contacts.addOrMergeContact(entry) })
    expect((await runQRHandshakeScan(CONNECT_LINK, deps)).kind).toBe("handshake")
    expect(await contacts.getEntries()).toEqual([
      { name: "alice", tag: "alice", address: SHARER_L2 },
    ])
  })

  it.each([
    ["an unverified", null],
    ["a verified", { l2Address: SHARER_L2, xmtpAddress: SHARER_XMTP }],
  ])(
    "stays unapproved, and the scan reports a conflict, when %s QR at their address carries another tag",
    async (_, record) => {
      const contacts = store()
      const fromTransfer = { name: "old-tag", tag: "old-tag", address: SHARER_L2, autoAdded: true }
      await contacts.addEntry(fromTransfer)
      const { deps, sendConnectBack } = makeDeps({
        verifyTag: async () => record,
        addOrMergeContact: (entry) => contacts.addOrMergeContact(entry),
      })
      expect(await runQRHandshakeScan(CONNECT_LINK, deps)).toEqual({
        kind: "conflict",
        contact: fromTransfer,
      })
      await flush()
      expect(sendConnectBack).not.toHaveBeenCalled()
      expect(await contacts.getEntries()).toEqual([fromTransfer])
    },
  )
})
