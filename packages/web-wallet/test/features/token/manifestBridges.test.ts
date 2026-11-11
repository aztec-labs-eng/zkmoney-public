/**
 * The bridge list the token-first lookup reads: a list missing another manifest's bridges is not kept, and a token
 * the kept list lacks is looked up in a fresh fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Network } from "@obsidion/core/constants"
import type { WebWalletConfig } from "../../../src/config/env"
import { testChain } from "../../support/query"

const h = vi.hoisted(() => ({ loadOxideManifestTuple: vi.fn() }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  loadOxideManifestTuple: h.loadOxideManifestTuple,
}))

const { createPageChain } = await import("../../../src/app/pageChain")

const MANIFEST_URL = "https://oxide.example/manifest.json"
const token = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const portal = (n: number) => `0x${n.toString(16).padStart(40, "0")}`

const bridge = (n: number) => ({ portal: portal(n), l2Token: token(n), token: portal(0xda) })
const manifest = (...bridges: ReturnType<typeof bridge>[]) => ({
  schemaVersion: "5",
  deployments: [
    {
      label: "v6",
      updatedAt: "2026-10-20T00:00:00Z",
      deployedAt: "2026-10-01T00:00:00Z",
      enclaveUrl: "https://fleet.example/rpc",
      rollupVersion: "1",
      chainId: "11155111",
      bridges,
    },
  ],
})

const reads = (sourceRollups: unknown[] = [], pin = portal(1)) =>
  createPageChain(
    {
      oxideProfile: { manifestUrl: MANIFEST_URL, portal: pin },
      network: Network.TESTNET,
      sourceRollups,
    } as unknown as WebWalletConfig,
    testChain(),
  )

let served: unknown
const fetchMock = vi.fn(async () => new Response(JSON.stringify(served)))

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockClear()
  h.loadOxideManifestTuple.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe("manifestBridges", () => {
  it("keeps a complete list for the profile", async () => {
    served = manifest(bridge(1))
    const { manifestBridges } = reads()
    expect((await manifestBridges.read()).map((b) => b.l2Token)).toEqual([token(1)])
    await manifestBridges.read()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not keep a list missing another manifest's bridges", async () => {
    served = manifest(bridge(1))
    const { manifestBridges } = reads(
      [{ manifestUrl: "https://oxide.example/v5.json", pins: [{ portal: portal(5) }] }],
      portal(2),
    )
    h.loadOxideManifestTuple.mockRejectedValueOnce(new Error("v5 manifest down"))
    expect((await manifestBridges.read()).map((b) => b.l2Token)).toEqual([token(1)])
    h.loadOxideManifestTuple.mockResolvedValueOnce({ ...bridge(5), enclaveUrl: "https://v5/rpc" })
    expect((await manifestBridges.read()).map((b) => b.l2Token)).toEqual([1, 5].map(token))
  })
})

describe("bridgeOfToken", () => {
  it("finds a bridge added since the list was fetched", async () => {
    const pinned = reads()
    served = manifest(bridge(1))
    await pinned.manifestBridges.read()
    served = manifest(bridge(1), bridge(2))
    expect((await pinned.bridgeOfToken(token(2)).read()).portal).toBe(portal(2))
  })

  it("names a token no manifest lists", async () => {
    served = manifest(bridge(1))
    await expect(reads().bridgeOfToken(token(9)).read()).rejects.toThrow(
      `No oxide bridge lists the token ${token(9)}`,
    )
  })
})
