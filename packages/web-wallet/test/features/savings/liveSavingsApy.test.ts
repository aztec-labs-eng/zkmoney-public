// @vitest-environment node
// The landing's live Savings rate: the pinned deployment's Sky vault, read over L1 once per page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { apyFromSsr } from "@obsidion/front-core"
import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem"
import { PORTAL } from "../../fixtures/sandboxProfile"
import { createPageChain } from "../../../src/app/pageChain"
import { sandboxConfig } from "../../support/seedBootConfig"
import { testChain, testQuery } from "../../support/query"

const MANIFEST_URL = "http://profile-oxide.test/sandbox.json"
const L1_URL = "http://profile-l1.test"
const SKY_PORTAL = `0x${"bb".repeat(20)}`
const VAULT: Hex = `0x${"cc".repeat(20)}`
/** A per-second rate a little over one ray. */
const SSR = 10n ** 27n + 1_234_567_890_000_000_000n
const UNDERLYING = toFunctionSelector("UNDERLYING()")
const SSR_CALL = toFunctionSelector("ssr()")

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

type Call = { id: number; method: string; params: [{ to: string; data: string }] }
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

let sky: boolean
let calls: string[]
let config: Awaited<ReturnType<typeof sandboxConfig>>
/** Whether the L1 node refuses every read, and how many it was asked. */
let l1Down: boolean
let l1Asked: number

/** The answer an L1 node gives each read: the Sky portal's vault, and the vault's rate. */
function answer({ id, method, params }: Call) {
  if (method !== "eth_call") throw new Error(`unexpected L1 method: ${method}`)
  const { to, data } = params[0]
  calls.push(data.slice(0, 10))
  if (data.startsWith(UNDERLYING) && to.toLowerCase() === SKY_PORTAL)
    return { jsonrpc: "2.0", id, result: encodeAbiParameters([{ type: "address" }], [VAULT]) }
  if (data.startsWith(SSR_CALL) && to.toLowerCase() === VAULT)
    return { jsonrpc: "2.0", id, result: encodeAbiParameters([{ type: "uint256" }], [SSR]) }
  throw new Error(`unexpected read of ${to}: ${data}`)
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
  // A fresh module per test: its caches and its one read per page start empty.
  vi.resetModules()
  config = await sandboxConfig()
})
afterEach(() => vi.unstubAllGlobals())

/** A page over the sandbox config, with chain reads of its own. */
const page = () => ({ config, chain: createPageChain(config, testChain()) })

const gateway = () => import("../../../src/features/savings/savingsGateway")

describe("readLiveSavingsApy", () => {
  it("is the yearly rate of the vault behind the pinned deployment's Sky portal", async () => {
    const { readLiveSavingsApy } = await gateway()
    await expect(readLiveSavingsApy(page())).resolves.toBe(apyFromSsr(SSR))
    expect(calls).toEqual([UNDERLYING, SSR_CALL])
  })

  it("is nothing, with no L1 read, where the deployment names no Sky savings", async () => {
    sky = false
    const { readLiveSavingsApy } = await gateway()
    await expect(readLiveSavingsApy(page())).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })
})

describe("liveSavingsApy", () => {
  it("reads the rate once per page, however often it is asked", async () => {
    const rate = (await gateway()).liveSavingsApy(testQuery(), page())
    await rate.read()
    await rate.read()
    expect(calls).toEqual([UNDERLYING, SSR_CALL])
  })

  it("settles with the rate it read, or with none when the read fails", async () => {
    const { liveSavingsApy } = await gateway()
    await expect(liveSavingsApy(testQuery(), page()).read()).resolves.toEqual({
      apy: apyFromSsr(SSR),
    })
    l1Down = true
    l1Asked = 0
    // The L1 client retries before the read fails.
    await expect(liveSavingsApy(testQuery(), page()).read()).resolves.toEqual({ apy: undefined })
    expect(l1Asked).toBeGreaterThan(0)
  })
})
