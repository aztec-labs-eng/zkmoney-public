// @vitest-environment node
/**
 * A cold page's L1 cost of a pending deposit's processing reason: the observer's terms read costs
 * the forwarding-table row and the portal's cap, and nothing for the deposit-token list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SipaIntent } from "@oxide/l1-contracts"
import type { Address, Hex } from "viem"
import {
  createPortalCapacityRegistry,
  createSipaProcessingObserver,
  memoryStore,
  type RecordSet,
  type SipaDeposit,
} from "@obsidion/front-core"
import { createPageChain } from "../../../src/app/pageChain"
import { createL1RpcHandler, DEMO_L1_TOKEN } from "../../../src/dev/fakeL1Rpc"
import { DEMO_OXIDE_DEPLOYMENT, DEMO_OXIDE_TUPLE } from "../../../src/dev/demoFixtures"
import { defaultConfig } from "../../support/page"
import { testChain, testQuery } from "../../support/query"

/** What the observer's own read of a deposit's terms cost: the table's row and the portal's cap. */
const OWN_TERMS_READ_CALLS = 2

/** The page's L1, counting each JSON-RPC request. */
function countingL1() {
  const handle = createL1RpcHandler(defaultConfig.l1ChainId)
  const calls = { count: 0 }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      const one = async (request: { id: number; method: string; params: unknown[] }) => {
        calls.count++
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: await handle(request.method, request.params),
        }
      }
      return Response.json(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body))
    }),
  )
  return calls
}

const pending: SipaDeposit = {
  sipaAddress: `0x${"5a".repeat(20)}` as Address,
  phase: "sweeping",
  networkId: "0xnet",
  recipientL2Address: "0x" + "11".repeat(32),
  messageSecret: "0x" + "22".repeat(32),
  recipientHash: "0x" + "33".repeat(32),
  recoveryAddress: "0x" + "44".repeat(20),
  origin: {
    sipaFactory: `0x${"fa".repeat(20)}` as Address,
    implementation: `0x${"0e".repeat(20)}` as Address,
    intentHash: `0x${"55".repeat(32)}` as Hex,
    rollupVersion: "1",
    resweepable: false,
    protocol: "account",
    recoveryAccount: `0x${"44".repeat(20)}` as Address,
    recoveryCommitment: `0x${"66".repeat(31)}` as Hex,
    accountFactory: `0x${"ac".repeat(20)}` as Address,
    forwardingTable: DEMO_OXIDE_TUPLE.forwardingTable as Address,
  },
  l1ChainId: defaultConfig.l1ChainId,
  amount: "101",
  tokenSymbol: "DAI",
  tokenAddress: DEMO_L1_TOKEN,
  tokenDecimals: 18,
  startTime: Date.now() - 600_000,
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("a pending deposit's reason on a cold page", () => {
  it("costs at most one L1 call more than the observer's own terms read", async () => {
    const calls = countingL1()
    const query = testQuery()
    const chain = createPageChain(
      defaultConfig,
      { query, database: testChain().database },
      undefined,
      {
        tuple: DEMO_OXIDE_TUPLE,
        deployment: DEMO_OXIDE_DEPLOYMENT,
      },
    )
    // Capacity reads are the same before and after, so they read no L1 here.
    const registry = createPortalCapacityRegistry({
      read: async () => new Promise(() => {}),
      query,
      policy: { maxHeadAgeMs: Infinity },
    })
    const observer = createSipaProcessingObserver({
      deposits: memoryStore<RecordSet<SipaDeposit>>({
        records: [pending],
        loaded: true,
        failed: false,
      }).readonly,
      capacity: (key) => registry.store(key),
      terms: (route, token) => chain.sipaPortalTerms(route, token),
      l1ChainId: defaultConfig.l1ChainId,
    })
    // The name card subscribes, as the only reader on the page.
    const off = observer.states.subscribe(() => {})
    await vi.waitFor(() =>
      expect(
        chain
          .sipaPortalTerms(
            {
              forwardingTable: DEMO_OXIDE_TUPLE.forwardingTable as Address,
              intent: SipaIntent.Deposit,
            },
            DEMO_L1_TOKEN,
          )
          .get().status,
      ).toBe("ready"),
    )
    expect(calls.count).toBeLessThanOrEqual(OWN_TERMS_READ_CALLS + 1)
    off()
  })
})
