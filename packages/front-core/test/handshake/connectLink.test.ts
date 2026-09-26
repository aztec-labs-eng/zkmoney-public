import { describe, expect, it } from "vitest"
import { Network } from "@obsidion/core/constants"
import {
  HANDSHAKE_LINK_HOST,
  buildHandshakeLink,
  mintableOrigin,
  parseConnectLink,
  parseUserTagFromQRPayload,
  walletBaseUrl,
} from "../../src/index.js"

// A base64url(CBOR) packet fragment as produced by the inline codec: one
// dot-free, `#`-free token drawn from the base64url alphabet.
const PACKET = "owEBAgEDAEQ1quYFT3vqdQ-Quux42AAA-_BBB"

// The origin the mint path actually uses — `walletBaseUrl(Network.TESTNET)`.
const PAYLINK = "https://wallet.staging.zk.money"

describe("buildHandshakeLink", () => {
  it("puts the packet in the fragment under the given landing origin", () => {
    expect(buildHandshakeLink(PAYLINK, PACKET)).toBe(`${PAYLINK}/connect#${PACKET}`)
  })

  it("tolerates a trailing slash on the base url", () => {
    expect(buildHandshakeLink(`${PAYLINK}/`, PACKET)).toBe(`${PAYLINK}/connect#${PACKET}`)
  })

  it("uses the given origin verbatim — but parseConnectLink keeps the zk.money anchor", () => {
    const foreign = buildHandshakeLink("https://example.test", PACKET)
    expect(foreign).toBe(`https://example.test/connect#${PACKET}`)
    expect(parseConnectLink(foreign)).toBeNull()
  })
})

describe("parseConnectLink", () => {
  it("round-trips the packet through build → parse on both wallet origins", () => {
    for (const origin of ["https://wallet.zk.money", PAYLINK]) {
      expect(parseConnectLink(buildHandshakeLink(origin, PACKET))).toBe(PACKET)
    }
  })

  it("accepts the bare anchor host and the paylink origin", () => {
    expect(parseConnectLink(`zk.money/connect#${PACKET}`)).toBe(PACKET)
    expect(parseConnectLink(`https://paylink.test.zk.money/connect#${PACKET}`)).toBe(PACKET)
  })

  it("still yields the packet from a link an older build minted on the tag host", () => {
    expect(parseConnectLink(`alice.zk.money/connect#${PACKET}`)).toBe(PACKET)
  })

  it("never reads a host label as identity — every host yields the same packet", () => {
    const hosts = [
      "zk.money",
      "alice.zk.money",
      "wallet.staging.zk.money",
      "wallet-pr-1220.zk.money",
    ]
    const parsed = hosts.map((h) => parseConnectLink(`https://${h}/connect#${PACKET}`))
    expect(parsed).toEqual(hosts.map(() => PACKET))
  })

  it("rejects unknown handshake-style paths", () => {
    expect(parseConnectLink(`${PAYLINK}/legacy#${PACKET}`)).toBeNull()
  })

  it("returns null for an empty payload", () => {
    expect(parseConnectLink("")).toBeNull()
  })

  it("returns null for a foreign host", () => {
    expect(parseConnectLink(`https://evil.com/connect#${PACKET}`)).toBeNull()
    // A lookalike that merely ENDS in the anchor's characters is not the anchor.
    expect(parseConnectLink(`https://notzk.money/connect#${PACKET}`)).toBeNull()
  })

  it("returns null when the fragment (packet) is missing", () => {
    expect(parseConnectLink(`${PAYLINK}/connect`)).toBeNull()
    expect(parseConnectLink(`${PAYLINK}/connect#`)).toBeNull()
  })

  it("returns null for an out-of-charset fragment", () => {
    expect(parseConnectLink(`${PAYLINK}/connect#bad packet!`)).toBeNull()
    expect(parseConnectLink(`${PAYLINK}/connect#has.dot`)).toBeNull()
  })

  it("returns null for a plain user tag link (no /connect path)", () => {
    expect(parseConnectLink("alice.zk.money")).toBeNull()
    expect(parseConnectLink("https://alice.zk.money")).toBeNull()
  })
})

describe("mintableOrigin", () => {
  it("keeps a deploy's own origin so staging and PR previews link back to themselves", () => {
    for (const origin of [
      "https://wallet.zk.money",
      "https://wallet.staging.zk.money",
      "https://wallet-pr-1220.zk.money",
      "https://wallet-pr-1220.staging.zk.money",
    ]) {
      expect(mintableOrigin(origin, Network.TESTNET)).toBe(origin)
    }
  })

  it("falls back where a minted link would not survive the parser (localhost, desktop loopback)", () => {
    for (const origin of ["http://localhost:5173", "https://localhost:8443", undefined, ""]) {
      expect(mintableOrigin(origin, Network.TESTNET)).toBe("https://wallet.staging.zk.money")
      expect(mintableOrigin(origin, Network.MAINNET)).toBe("https://wallet.zk.money")
    }
  })

  it("never returns an origin the scanner would reject", () => {
    for (const origin of ["https://evil.com", "http://localhost:5173", "https://wallet.zk.money"]) {
      const link = buildHandshakeLink(mintableOrigin(origin, Network.TESTNET), PACKET)
      expect(parseConnectLink(link)).toBe(PACKET)
    }
  })

  it("walletBaseUrl splits prod from everything else", () => {
    expect(walletBaseUrl(Network.MAINNET)).toBe("https://wallet.zk.money")
    expect(walletBaseUrl(Network.TESTNET)).toBe("https://wallet.staging.zk.money")
    expect(walletBaseUrl(Network.SANDBOX)).toBe("https://wallet.staging.zk.money")
  })
})

describe("dispatch ordering safety (connect vs. legacy bare-tag parser)", () => {
  it("a /connect#… link IS parsed by parseConnectLink and is NOT a bare tag for the caller", () => {
    const link = buildHandshakeLink(PAYLINK, PACKET)

    expect(parseConnectLink(link)).toBe(PACKET)

    // Unknown path payloads are not bare user tags, so the fallback parser
    // will not reinterpret a handshake URL after the connect parser handles it.
    expect(parseUserTagFromQRPayload(link)).toBeNull()
  })

  it("a plain user tag link falls through parseConnectLink to the legacy parser", () => {
    expect(parseConnectLink("alice.zk.money")).toBeNull()
    expect(parseUserTagFromQRPayload("alice.zk.money")).toBe("alice")
  })

  it("HANDSHAKE_LINK_HOST is an origin the parser accepts", () => {
    expect(parseConnectLink(buildHandshakeLink(HANDSHAKE_LINK_HOST, PACKET))).toBe(PACKET)
  })
})
