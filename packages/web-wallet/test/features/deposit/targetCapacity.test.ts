// @vitest-environment node
/** A shown address's capacity: its row's terms, its eligibility, and why a fixed amount is held. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  type Address,
  type Hex,
} from "viem"
import { ForwardingTableAbi, OxidePortalAbi, SipaIntent } from "@oxide/l1-contracts"
import type { OxideBridge } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  createPortalCapacityStore,
  type CapacityEligibility,
  type RequiredCredit,
} from "@obsidion/front-core"
import type { PortalCapacitySnapshot } from "@obsidion/sdk"
import {
  capacityHold,
  targetEligibility,
  type TargetCapacity,
} from "../../../src/features/deposit/targetCapacity"
import { defaultConfig, testPage } from "../../support/page"
import { testQuery } from "../../support/query"

const DAI = getAddress(`0x${"da".repeat(20)}`)
const SUSDS = getAddress(`0x${"5d".repeat(20)}`)
const PORTAL = getAddress(`0x${"a0".repeat(20)}`)
const SUSDS_PORTAL = getAddress(`0x${"a5".repeat(20)}`)
const BENEFICIARY = getAddress(`0x${"be".repeat(20)}`)
const TIP = 200_000_000_000_000_000n
const BENEFICIARY_FEE = 50_000_000_000_000_000n
const CAP = 5166n * 10n ** 18n

let next = 1
/** A forwarding table no earlier case read, so no terms are remembered for it. */
const freshTable = (): Address => getAddress(`0x${(next++).toString(16).padStart(40, "f")}`)

const selector = (data: Hex) => data.slice(0, 10)
const ROW_FOR = selector(
  encodeFunctionData({ abi: ForwardingTableAbi, functionName: "rowFor", args: [DAI, 0] } as never),
)
const TX_AMOUNT_CAP = selector(
  encodeFunctionData({ abi: OxidePortalAbi, functionName: "TX_AMOUNT_CAP" }),
)

type RpcCall = { id: number; params: [{ data: Hex }] }

/** A token's row: sUSDS settles on its own portal with no tip; every other token on `PORTAL`. */
const rowOf = (data: Hex) => {
  const { args } = decodeFunctionData({ abi: ForwardingTableAbi, data } as never) as unknown as {
    args: readonly [Address, number]
  }
  const susds = getAddress(args[0]) === SUSDS
  return encodeFunctionResult({
    abi: ForwardingTableAbi,
    functionName: "rowFor",
    result: susds
      ? [SUSDS_PORTAL, BENEFICIARY, BENEFICIARY_FEE, 0n]
      : [PORTAL, BENEFICIARY, BENEFICIARY_FEE, TIP],
  } as never)
}

/** An L1 node whose tables route DAI to `PORTAL`; the first `failures` calls fail. */
function node(failures = 0) {
  const answers: Record<string, Hex> = {
    [TX_AMOUNT_CAP]: encodeFunctionResult({
      abi: OxidePortalAbi,
      functionName: "TX_AMOUNT_CAP",
      result: CAP,
    }),
    [selector(encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }))]: encodeFunctionResult(
      { abi: erc20Abi, functionName: "symbol", result: "DAI" },
    ),
    [selector(encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }))]:
      encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 18 }),
  }
  const calls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as RpcCall | RpcCall[]
      const reply = (call: RpcCall) => {
        calls.push(selector(call.params[0].data))
        if (failures-- > 0) {
          return { jsonrpc: "2.0", id: call.id, error: { code: -32603, message: "rpc down" } }
        }
        const data = call.params[0].data
        const result = selector(data) === ROW_FOR ? rowOf(data) : answers[selector(data)]
        return { jsonrpc: "2.0", id: call.id, result }
      }
      const body = Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
    }),
  )
  return { calls }
}

const BRIDGE: OxideBridge = {
  key: "dai",
  underlying: DAI,
  token: DAI,
  portal: PORTAL,
  l2Token: `0x${"0c".repeat(32)}`,
  tuple: { rollupVersion: "7", portal: PORTAL, token: DAI } as OxideEnvTuple,
}

const SUSDS_BRIDGE: OxideBridge = {
  key: "susds",
  underlying: SUSDS,
  token: SUSDS,
  portal: SUSDS_PORTAL,
  l2Token: `0x${"0d".repeat(32)}`,
  tuple: { rollupVersion: "7", portal: SUSDS_PORTAL, token: SUSDS } as OxideEnvTuple,
}

/** A page primed with the test deployment, whose rows the terms read. */
let page: ReturnType<typeof testPage>
beforeAll(() => {
  page = testPage(undefined, defaultConfig, {
    tuple: BRIDGE.tuple,
    deployment: {
      deployment: {
        label: "test",
        rollupVersion: "7",
        forwardingTable: freshTable(),
        bridges: [BRIDGE, SUSDS_BRIDGE],
      },
      pinned: BRIDGE,
      timestampMs: 1,
    } as never,
  })
})
afterEach(() => vi.unstubAllGlobals())

describe("the page chain's sipaPortalTerms", () => {
  it("reads the row a recorded SIPA's token settles on, once per row", async () => {
    const { calls } = node()
    const route = { forwardingTable: freshTable(), intent: SipaIntent.Deposit }

    const terms = await page.chain.sipaPortalTerms(route, DAI).read()

    expect(terms).toEqual({
      portal: PORTAL,
      token: DAI,
      depositFee: TIP + BENEFICIARY_FEE,
      txAmountCap: CAP,
    })
    const reads = calls.length
    expect(page.chain.sipaPortalTerms({ ...route }, DAI.toLowerCase())).toBe(
      page.chain.sipaPortalTerms(route, DAI),
    )
    await page.chain.sipaPortalTerms(route, DAI).read()
    expect(calls).toHaveLength(reads)
  })

  it("reads each recorded token's own row", async () => {
    node()
    const route = { forwardingTable: freshTable(), intent: SipaIntent.Deposit }
    const [dai, susds] = await Promise.all([
      page.chain.sipaPortalTerms(route, DAI).read(),
      page.chain.sipaPortalTerms(route, SUSDS).read(),
    ])
    expect(dai).toMatchObject({ portal: PORTAL, token: DAI, depositFee: TIP + BENEFICIARY_FEE })
    expect(susds).toMatchObject({ portal: SUSDS_PORTAL, token: SUSDS, depositFee: BENEFICIARY_FEE })
  })

  it("settles on the intent's default row while no token is recorded", async () => {
    node()
    const terms = await page.chain
      .sipaPortalTerms({ forwardingTable: freshTable(), intent: SipaIntent.Deposit }, undefined)
      .read()
    expect(terms.token).toBe(DAI)
  })

  it("keeps no failed read, so the next start reads again", async () => {
    const route = { forwardingTable: freshTable(), intent: SipaIntent.Deposit }
    node(Infinity)
    await expect(page.chain.sipaPortalTerms(route, DAI).read()).rejects.toThrow()

    node()
    await expect(page.chain.sipaPortalTerms(route, DAI).read()).resolves.toMatchObject({
      portal: PORTAL,
    })
  })
})

const KEY = { chainId: 31337, portal: PORTAL, token: DAI } as const
const known = (whole: bigint): RequiredCredit => ({
  status: "known",
  atomic: whole * 10n ** 18n,
  token: DAI,
  decimals: 18,
})
const snapshot = (availableAtomic: bigint): PortalCapacitySnapshot => ({
  ...KEY,
  decimals: 18,
  blockNumber: 1n,
  blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
  rateAtomicPerSecond: 10n ** 18n,
  globalLimitAtomic: 50_000n * 10n ** 18n,
  availableAtomic,
  txAmountCapAtomic: CAP,
})
const capacity = (patch: Partial<TargetCapacity>): TargetCapacity => ({
  resolution: "resolved",
  retry: () => {},
  ...patch,
})

describe("targetEligibility", () => {
  it("keeps the target's own reason while no bucket is named", () => {
    const unknown: CapacityEligibility = { kind: "checking" }
    expect(targetEligibility(capacity({ unknown }), known(1n))).toBe(unknown)
  })

  it("is checking until the bucket has a state", () => {
    const store = createPortalCapacityStore(KEY, {
      read: async () => snapshot(0n),
      query: testQuery(),
    })
    expect(targetEligibility(capacity({}), known(1n))).toEqual({ kind: "checking" })
    expect(targetEligibility(capacity({ store }), known(1n))).toEqual({ kind: "checking" })
  })

  it("evaluates the amount against the bucket's state", async () => {
    const store = createPortalCapacityStore(KEY, {
      read: async () => snapshot(500n * 10n ** 18n),
      query: testQuery(),
    })
    await store.refresh()
    const target = capacity({ store, state: store.getState() })

    expect(targetEligibility(target, known(10n)).kind).toBe("fits")
    expect(targetEligibility(target, known(2_000n)).kind).toBe("exceeds-available")
  })
})

describe("capacityHold", () => {
  it("names a hold only for an amount known capacity refuses", () => {
    const hold = (kind: string) => capacityHold({ kind } as CapacityEligibility)
    expect(hold("exceeds-available")).toBe("capacity")
    expect(hold("exceeds-ceiling")).toBe("ceiling")
    expect(hold("exceeds-operation-cap")).toBe("protocol")
    expect(hold("fits")).toBeUndefined()
    expect(hold("checking")).toBeUndefined()
  })
})
