// @vitest-environment node
// The landing's live Savings rate: the pinned deployment's Sky vault's share price growth, read over
// L1 once per page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RATE_WINDOW_BLOCKS, yearlyRate } from "@obsidion/front-core"
import { encodeAbiParameters, toFunctionSelector, toHex } from "viem"
import { PORTAL } from "../../fixtures/sandboxProfile"
import { createPageChain } from "../../../src/app/pageChain"
import { landingRate } from "../../../src/features/savings/landingRate"
import { sandboxConfig } from "../../support/seedBootConfig"
import { testChain, testQuery } from "../../support/query"

const MANIFEST_URL = "http://profile-oxide.test/sandbox.json"
const L1_URL = "http://profile-l1.test"
const SKY_PORTAL = `0x${"bb".repeat(20)}`
const HEAD = 2n * RATE_WINDOW_BLOCKS
/** What one share redeems for now, and a window before the head. */
const PRICE_NOW = 1_050_000_000_000_000_000n
const PRICE_THEN = 1_049_000_000_000_000_000n
const DECIMALS = toFunctionSelector("decimals()")
const ASSET = toFunctionSelector("asset()")
const USDS = `0x${"d3".repeat(20)}` as const
const CONVERT = toFunctionSelector("convertToAssets(uint256)")
const uint = (value: bigint | number) => encodeAbiParameters([{ type: "uint256" }], [BigInt(value)])

const bridge = (key: string, token: string, portal: string, byte: string) => ({
  key,
  bridgeId: `brg-${key}-sandbox`,
  token,
  portal,
  l2Token: `0x${byte.repeat(32)}`,
  plainWithdrawalExecutor: `0x${byte.repeat(20)}`,
})

const manifest = (sky: boolean) => ({
  schemaVersion: "5",
  deployments: [
    {
      label: "sandbox",
      deployedAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      chainId: "31337",
      rollupVersion: "1821665230",
      enclaveUrl: "http://localhost:5071/rpc",
      ...(sky
        ? {
            features: {
              "fea-sky-sandbox": {
                project: "sky",
                bridges: { sUsds: "brg-susds-sandbox", dai: "brg-dai-sandbox" },
                contracts: {
                  skyWithdrawalExecutor: `0x${"e5".repeat(20)}`,
                  skyEscrowFactory: `0x${"fa".repeat(20)}`,
                },
              },
            },
          }
        : {}),
      bridges: [
        bridge("susds", `0x${"d2".repeat(20)}`, SKY_PORTAL, "b2"),
        bridge("dai", `0x${"d1".repeat(20)}`, PORTAL, "a1"),
      ],
    },
  ],
})

type Call = { id: number; method: string; params: [{ to: string; data: string }, string?] }
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

let sky: boolean
let calls: string[]
let config: Awaited<ReturnType<typeof sandboxConfig>>
/** Whether the L1 node refuses every read, and how many it was asked. */
let l1Down: boolean
let l1Asked: number

/** An L1 node's answer to each read: the head, and the vault's decimals, asset and share price. */
function answer({ id, method, params }: Call) {
  const result = (value: string) => ({ jsonrpc: "2.0", id, result: value })
  calls.push(method)
  if (method === "eth_blockNumber") return result(toHex(HEAD))
  if (method !== "eth_call") throw new Error(`unexpected L1 method: ${method}`)
  const [{ data }, block] = params
  if (data.startsWith(DECIMALS)) return result(uint(18))
  if (data.startsWith(ASSET)) return result(encodeAbiParameters([{ type: "address" }], [USDS]))
  if (!data.startsWith(CONVERT)) throw new Error(`unexpected read: ${data}`)
  const pinned = block !== undefined && block !== "latest"
  return result(uint(pinned ? PRICE_THEN : PRICE_NOW))
}

beforeEach(async () => {
  sky = true
  calls = []
  l1Down = false
  l1Asked = 0
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === MANIFEST_URL) return json(manifest(sky))
    if (String(url).replace(/\/$/, "") !== L1_URL) throw new Error(`unexpected fetch: ${url}`)
    l1Asked++
    if (l1Down) throw new Error("offline")
    const body = JSON.parse(String(init?.body)) as Call | Call[]
    return json(Array.isArray(body) ? body.map(answer) : answer(body))
  })
  config = await sandboxConfig()
})
afterEach(() => vi.unstubAllGlobals())

/** A page over the sandbox config, with chain reads of its own. */
const page = () => ({ config, chain: createPageChain(config, testChain()) })

describe("landingRate", () => {
  it("reads the rate once per page, however often it is asked", async () => {
    const rate = landingRate(testQuery(), page())
    await rate.read()
    const asked = calls.length
    await rate.read()
    expect(asked).toBeGreaterThan(0)
    expect(calls).toHaveLength(asked)
  })

  it("settles with the vault's yearly rate, or with none when the read fails", async () => {
    await expect(landingRate(testQuery(), page()).read()).resolves.toEqual({
      rate: yearlyRate(PRICE_NOW, PRICE_THEN),
    })
    l1Down = true
    l1Asked = 0
    await expect(landingRate(testQuery(), page()).read()).resolves.toEqual({ rate: undefined })
    expect(l1Asked).toBeGreaterThan(0)
  })

  it("is nothing, with no L1 read, where the deployment names no Sky savings", async () => {
    sky = false
    await expect(landingRate(testQuery(), page()).read()).resolves.toEqual({ rate: undefined })
    expect(calls).toEqual([])
  })
})
