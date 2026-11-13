// @vitest-environment node
// Each Sky holding's price is read on its own: one vault that does not answer costs only its own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeAbiParameters, toFunctionSelector, toHex } from "viem"
import { PORTAL } from "../fixtures/sandboxProfile"
import { createPageChain } from "../../src/app/pageChain"
import { sandboxConfig } from "../support/seedBootConfig"
import { testChain } from "../support/query"

const MANIFEST_URL = "http://profile-oxide.test/sandbox.json"
const L1_URL = "http://profile-l1.test"
const VAULT = `0x${"d2".repeat(20)}`
const OLD_VAULT = `0x${"d3".repeat(20)}`
const PRICE = 1_050_000_000_000_000_000n
const DECIMALS = toFunctionSelector("decimals()")
const uint = (value: bigint | number) => encodeAbiParameters([{ type: "uint256" }], [BigInt(value)])

const bridge = (key: string, token: string, portal: string, byte: string) => ({
  key,
  bridgeId: `brg-${key}-sandbox`,
  token,
  portal,
  l2Token: `0x${byte.repeat(32)}`,
  plainWithdrawalExecutor: `0x${byte.repeat(20)}`,
})
const sky = (sUsds: string) => ({
  project: "sky",
  bridges: { sUsds, dai: "brg-dai-sandbox" },
  contracts: {
    skyWithdrawalExecutor: `0x${"e5".repeat(20)}`,
    skyEscrowFactory: `0x${"fa".repeat(20)}`,
  },
})
const manifest = {
  schemaVersion: "5",
  deployments: [
    {
      label: "sandbox",
      deployedAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      chainId: "31337",
      rollupVersion: "1821665230",
      enclaveUrl: "http://localhost:5071/rpc",
      features: {
        "fea-sky-sandbox": sky("brg-susds-sandbox"),
        "fea-sky-old": sky("brg-susdsold-sandbox"),
      },
      bridges: [
        bridge("susds", VAULT, `0x${"bb".repeat(20)}`, "b2"),
        bridge("susdsold", OLD_VAULT, `0x${"bc".repeat(20)}`, "b3"),
        bridge("dai", `0x${"d1".repeat(20)}`, PORTAL, "a1"),
      ],
    },
  ],
}

type Call = { id: number; method: string; params: [{ to: string; data: string }, string?] }
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

/** The vaults whose reads the L1 node reverts. */
let down: Set<string>

function answer({ id, method, params }: Call) {
  if (method === "eth_blockNumber") return { jsonrpc: "2.0", id, result: toHex(16n) }
  const [{ to, data }] = params
  if (down.has(to.toLowerCase()))
    return { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: "0x" } }
  return { jsonrpc: "2.0", id, result: uint(data.startsWith(DECIMALS) ? 18 : PRICE) }
}

beforeEach(() => {
  down = new Set()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === MANIFEST_URL) return json(manifest)
    if (String(url).replace(/\/$/, "") !== L1_URL) throw new Error(`unexpected fetch: ${url}`)
    const body = JSON.parse(String(init?.body)) as Call | Call[]
    return json(Array.isArray(body) ? body.map(answer) : answer(body))
  })
})
afterEach(() => vi.unstubAllGlobals())

describe("the Savings prices", () => {
  it("price each Sky holding on its own: one vault that fails leaves the others priced", async () => {
    down.add(OLD_VAULT)
    const chain = createPageChain(await sandboxConfig(), testChain())
    const prices = await chain.savingsPrices.read()
    expect(prices.map((p) => p.holding.id)).toEqual(["fea-sky-sandbox", "fea-sky-old"])
    expect(prices[0]).toMatchObject({ sharePrice: PRICE, shareDecimals: 18 })
    expect(prices[1]).toEqual({ holding: prices[1]?.holding, failed: true })
  })

  it("keep a holding's earlier price through a re-read of it that fails", async () => {
    const chain = createPageChain(await sandboxConfig(), testChain())
    const [, old] = await chain.savingsPrices.read()
    down.add(OLD_VAULT)
    chain.savingsPrices.refresh()
    chain.holdingPrice(old!.holding).refresh()
    const [fresh, kept] = await chain.savingsPrices.read()
    expect(fresh).toMatchObject({ sharePrice: PRICE })
    expect(kept).toEqual(old)
  })
})
