import { describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { Network } from "@obsidion/core/constants"
import {
  decodeInline,
  mintQRHandshakeShare,
  parseConnectLink,
  type MintQRHandshakeShareDeps,
} from "../../src/index.js"

/**
 * Serverless generate-flow test. The pure `mintQRHandshakeShare` core builds
 * the inline packet, records the per-share uuid, and emits the QR link — no
 * network. We round-trip the emitted packet through the real front-core codec
 * to assert its contents.
 */

const FIXED_NOW = 1_717_000_000_000
const FIXED_UUID = "deadbeef-cafe-400d-8011-223344556677"
const XMTP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const L2 = "0x0c1d2e3f405162738495a6b7c8d9eafb0c1d2e3f405162738495a6b7c8d9eafb"

function makeDeps(overrides: Partial<MintQRHandshakeShareDeps> = {}): {
  deps: MintQRHandshakeShareDeps
  record: ReturnType<typeof vi.fn>
} {
  const record = vi.fn(async () => {})

  const deps: MintQRHandshakeShareDeps = {
    tag: "alice",
    ownXmtpHandle: XMTP as Address,
    chain: Network.TESTNET,
    baseUrl: "https://wallet.staging.zk.money",
    l2Address: L2,
    uuid: () => FIXED_UUID,
    now: () => FIXED_NOW,
    record: record as unknown as MintQRHandshakeShareDeps["record"],
    ...overrides,
  }
  return { deps, record }
}

describe("mintQRHandshakeShare (serverless generate flow)", () => {
  it("happy: builds an inline link offline, records the uuid, packet carries identity", async () => {
    const { deps, record } = makeDeps()

    const link = await mintQRHandshakeShare(deps)

    // Minted on the wallet's own origin — the only surface that handles /connect.
    expect(link).toBe(`https://wallet.staging.zk.money/connect#${link.split("#")[1]}`)

    const parsed = parseConnectLink(link)
    expect(parsed).not.toBeNull()

    // Round-trip the packet through the real codec. The tag rides in the BODY.
    const packet = decodeInline(parsed!)
    expect(packet).toEqual({
      version: "1.0:testnet",
      kind: "handshake",
      xmtpHandle: XMTP,
      uuid: FIXED_UUID,
      time: FIXED_NOW,
      l2Address: L2,
      tag: "alice",
    })

    // Local record keyed by the per-share uuid (no handle/deletionKey args).
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith(FIXED_UUID)
  })

  it("error: a malformed packet (bad address) throws and never records a dangling entry", async () => {
    const record = vi.fn(async () => {})
    const { deps } = makeDeps({
      ownXmtpHandle: "0xnot-an-address" as Address,
      record: record as unknown as MintQRHandshakeShareDeps["record"],
    })

    await expect(mintQRHandshakeShare(deps)).rejects.toThrow()
    expect(record).not.toHaveBeenCalled()
  })

  it("edge: tag-less owner → same host, packet simply omits the tag", async () => {
    const { deps } = makeDeps({ tag: undefined })
    const link = await mintQRHandshakeShare(deps)
    expect(link.startsWith("https://wallet.staging.zk.money/connect#")).toBe(true)
    expect(decodeInline(parseConnectLink(link)!)).not.toHaveProperty("tag")
  })

  it("edge: mints on whatever origin it is handed — a PR preview links back to itself", async () => {
    const { deps } = makeDeps({ baseUrl: "https://wallet-pr-1220.zk.money" })
    const link = await mintQRHandshakeShare(deps)
    expect(link.startsWith("https://wallet-pr-1220.zk.money/connect#")).toBe(true)
    expect(parseConnectLink(link)).not.toBeNull()
  })

  it("edge: mainnet mints on the prod wallet origin", async () => {
    const { deps } = makeDeps({ chain: Network.MAINNET, baseUrl: "https://wallet.zk.money" })
    const link = await mintQRHandshakeShare(deps)
    expect(link.startsWith("https://wallet.zk.money/connect#")).toBe(true)
    expect(decodeInline(parseConnectLink(link)!).version).toBe("1.0:mainnet")
  })

  it("edge: a non-canonical own handle is normalized before it reaches the wire", async () => {
    const { deps } = makeDeps({ tag: "@Alice.zk.money" })
    const link = await mintQRHandshakeShare(deps)
    expect(decodeInline(parseConnectLink(link)!).tag).toBe("alice")
  })

  it("error: an unnormalizable tag throws and never records a dangling entry", async () => {
    const record = vi.fn(async () => {})
    const { deps } = makeDeps({
      tag: "-nope-",
      record: record as unknown as MintQRHandshakeShareDeps["record"],
    })
    await expect(mintQRHandshakeShare(deps)).rejects.toThrow()
    expect(record).not.toHaveBeenCalled()
  })

  it("edge: omits optional address fields when not provided", async () => {
    const { deps } = makeDeps({ l2Address: undefined })
    const link = await mintQRHandshakeShare(deps)
    const packet = decodeInline(parseConnectLink(link)!)
    expect(packet).not.toHaveProperty("l2Address")
    expect(packet).not.toHaveProperty("stealthAddress")
  })

  it("edge: re-minting yields a fresh uuid per show (single-use intent)", async () => {
    let n = 0
    const { deps, record } = makeDeps({ uuid: () => `00000000-0000-4000-8000-00000000000${n++}` })
    await mintQRHandshakeShare(deps)
    await mintQRHandshakeShare(deps)
    expect(record).toHaveBeenCalledTimes(2)
    expect(record.mock.calls[0][0]).not.toBe(record.mock.calls[1][0])
  })
})
