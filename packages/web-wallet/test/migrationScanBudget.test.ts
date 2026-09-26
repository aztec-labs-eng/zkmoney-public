import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  toEventSelector,
  toHex,
  type PublicClient,
} from "viem"
import { sepolia } from "viem/chains"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { resetDeploymentScanRangeForTests } from "@obsidion/front-core"
import type { HistoricResidualSummary } from "../src/features/migration/historicResiduals"

const HEAD = 25_000n
const CHUNK = 10_000n
const HEADER_READ_BUDGET_PER_TUPLE = 16
const CHAIN_START_SEC = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000)
const SEC_PER_BLOCK = 10

const blockTime = (block: bigint) => CHAIN_START_SEC + Number(block) * SEC_PER_BLOCK

const chunksFrom = (deployBlock: bigint) => Number((HEAD - deployBlock + CHUNK) / CHUNK)

interface LogRange {
  address: string
  fromBlock: string
  toBlock: string
}

interface CountingClient {
  client: PublicClient
  calls: Record<string, number>
  getLogs: LogRange[]
}

interface Chain {
  sweeps: { address: string; block: bigint }[]
  rejectGetCode?: boolean
  rejectGetBlock?: boolean
  rejectSources?: boolean
}

const SWEEP_TOPIC = toEventSelector("Sweep(uint256,uint256)")

function sweepLog(address: string, block: bigint) {
  return {
    address,
    topics: [SWEEP_TOPIC],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [7n, 100n]),
    blockNumber: toHex(block),
    blockHash: "0x" + "1".repeat(64),
    transactionHash: "0x" + "2".repeat(64),
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
  }
}

function countingClient(chain: Chain): CountingClient {
  const calls: Record<string, number> = {}
  const getLogs: LogRange[] = []
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls[method] = (calls[method] ?? 0) + 1
      if (method === "eth_chainId") return toHex(sepolia.id)
      if (method === "eth_blockNumber") return toHex(HEAD)
      if (method === "eth_call") return "0x" + "0".repeat(64)
      if (method === "eth_getCode") {
        if (chain.rejectGetCode) throw new Error("historical state unavailable")
        return "0x6001"
      }
      if (method === "eth_getBlockByNumber") {
        if (chain.rejectGetBlock) throw new Error("pruned history unavailable")
        const [block] = params as [string]
        return { number: block, timestamp: toHex(blockTime(BigInt(block))) }
      }
      if (method === "eth_getLogs") {
        const [filter] = params as [LogRange]
        getLogs.push({
          address: filter.address,
          fromBlock: filter.fromBlock,
          toBlock: filter.toBlock,
        })
        return chain.sweeps
          .filter(
            (s) =>
              s.address.toLowerCase() === filter.address.toLowerCase() &&
              s.block >= BigInt(filter.fromBlock) &&
              s.block <= BigInt(filter.toBlock),
          )
          .map((s) => sweepLog(s.address, s.block))
      }
      throw new Error(`unmocked JSON-RPC method ${method}`)
    },
  })
  return {
    client: createPublicClient({
      chain: sepolia,
      transport: (config) => transport({ ...config, retryCount: 0 }),
    }) as PublicClient,
    calls,
    getLogs,
  }
}

const h = vi.hoisted(() => ({
  detect: vi.fn(),
  sources: vi.fn(),
  active: { current: null as unknown },
  balance: { current: 0n },
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PendingPaylinkMigrationService: class {
    reconcile = async () => []
    recordPending = async () => undefined
  },
  PendingPaylinkMigrationStore: { get: () => ({}) },
  AppNotificationStore: { get: () => ({}) },
  TransactionStorage: { get: () => ({ getTransactions: async () => [] }) },
  WithdrawalStorage: { get: () => ({ load: async () => {}, list: () => [] }) },
  deriveStealthKey: () => ({ publicKey: "pk" }),
  deriveRefundableSipaSources: h.sources,
  setupSipaDiscovery: async () => ({ broadcaster: "0x" + "bb".repeat(20) }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  IntraRollupMigrationService: { detectHistoricDeployments: h.detect },
  getBroadcasterArtifact: async () => ({}),
  fetchSipaEvents: async () => [],
  isSipaDepositClaimed: async () => false,
  readDepositSIPAImplementation: async () => "0x" + "dd".repeat(20),
  readDepositMessageKey: async () => ({ toString: () => "0x" + "ab".repeat(32) }),
  TokenService: { create: async () => ({ getBalance: async () => h.balance.current }) },
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({
    oxideProfile: {
      manifestUrl: "https://manifest.example/staging.v4.json",
      portal: "0x" + "01".repeat(20),
    },
    network: "sandbox",
    l1ChainId: 11155111,
  }),
}))
vi.mock("../src/config/oxideTuple", () => ({
  l1PublicClient: () => (h.active.current as CountingClient).client,
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => "0x01" }),
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../src/features/paylink/chainTime", () => ({
  latestChainSeconds: async () => 1_700_000_000,
}))

const { probeAccountResiduals } = await import("../src/features/migration/probeAccountResiduals")

const DEPLOY_BLOCKS: Record<number, bigint> = { 1: 12_000n, 2: 21_000n, 9: 24_000n }

const tuple = (n: number): OxideEnvTuple =>
  ({
    version: `v${n}`,
    gitSha: "",
    timestamp: new Date(blockTime(HEAD) * 1000).toISOString(),
    deployedAt: new Date(blockTime(DEPLOY_BLOCKS[n] ?? 0n) * 1000).toISOString(),
    portal: "0x" + n.toString(16).padStart(40, "0"),
    token: "0x" + "cc".repeat(20),
    l2Token: "0x" + n.toString(16).padStart(64, "0"),
    enclaveUrl: "http://tee.example.test/rpc",
    pcr0: "",
    rollupVersion: "7",
  } as OxideEnvTuple)

const current = tuple(9)
const wallet = { node: {}, pxe: {} } as never
const account = {
  getAddress: () => ({ toString: () => "0x" + "ee".repeat(32) }),
  makeDepositSpendMetadataResolver: async () => async () => ({ masterNullifierHidingKey: 1 }),
} as never

function sourcesOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    sipaAddress: "0x" + (i + 0x100).toString(16).padStart(40, "0"),
    recipientL2Address: "0x" + "ee".repeat(32),
    messageSecret: "0x01",
    origin: "sipa-event" as const,
  }))
}

interface BudgetRow {
  condition: string
  historic: number
  sources: number
  calls: Record<string, number>
  firstGetLogs?: LogRange
  lastGetLogs?: LogRange
}

const rows: BudgetRow[] = []

async function boot(
  condition: string,
  historic: OxideEnvTuple[],
  sources: number,
  chain: Partial<Chain> = {},
  balance = 0n,
): Promise<{ l1: CountingClient; residuals: HistoricResidualSummary[] }> {
  h.balance.current = balance
  const l1 = countingClient({ sweeps: [], ...chain })
  h.active.current = l1
  h.detect.mockResolvedValue({ current, historic })
  h.sources.mockImplementation(async () => {
    if (chain.rejectSources) throw new Error("exceed maximum block range: 50000")
    return sourcesOf(sources)
  })
  const found = await probeAccountResiduals(wallet, account)
  rows.push({
    condition,
    historic: historic.length,
    sources,
    calls: l1.calls,
    firstGetLogs: l1.getLogs[0],
    lastGetLogs: l1.getLogs.at(-1),
  })
  return { l1, residuals: found?.residuals ?? [] }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Every row here is the cost of a COLD boot; the deployment-block cache spans a session.
  resetDeploymentScanRangeForTests()
})

const ARTIFACT = "test-artifacts/migration-scan-budget.json"

beforeAll(() => {
  rmSync(ARTIFACT, { force: true })
})

describe("migration sweep-scan budget of one wallet boot", () => {
  it("no historic entry: no L1 call", async () => {
    const { l1 } = await boot("no-historic", [], 0)
    expect(l1.calls).toEqual({})
  })

  it("one historic entry, 0 sources: the head read only, no block search", async () => {
    const { l1 } = await boot("historic-1-sources-0", [tuple(1)], 0)
    expect(l1.calls).toEqual({ eth_blockNumber: 1 })
  })

  it("scans from the deployment's deployedAt, never from its later updatedAt", async () => {
    const { l1 } = await boot("republished-tuple-sources-1", [tuple(1)], 1)
    expect(l1.getLogs[0]).toMatchObject({ fromBlock: toHex(12_000n) })
  })

  it.each([1, 5, 20])(
    "one historic entry, %i sources: chunks from the portal's deploy block per source",
    async (sources) => {
      const { l1 } = await boot(`historic-1-sources-${sources}`, [tuple(1)], sources)
      expect(l1.calls.eth_getLogs).toBe(sources * chunksFrom(12_000n))
      expect(l1.calls.eth_call).toBe(sources)
      expect(l1.calls.eth_getCode).toBeUndefined()
      expect(l1.calls.eth_getBlockByNumber).toBeLessThanOrEqual(HEADER_READ_BUDGET_PER_TUPLE)
      expect(l1.getLogs[0]).toMatchObject({ fromBlock: toHex(12_000n), toBlock: toHex(21_999n) })
      expect(l1.getLogs.at(-1)).toMatchObject({ toBlock: toHex(HEAD) })
      expect(l1.getLogs.every((r) => BigInt(r.fromBlock) >= 12_000n)).toBe(true)
    },
  )

  it("two historic entries, 5 sources each: each portal scans from its own deploy block", async () => {
    const { l1 } = await boot("historic-2-sources-5", [tuple(1), tuple(2)], 5)
    expect(l1.calls.eth_getLogs).toBe(5 * chunksFrom(12_000n) + 5 * chunksFrom(21_000n))
    expect(l1.calls.eth_getBlockByNumber).toBeLessThanOrEqual(2 * HEADER_READ_BUDGET_PER_TUPLE)
    expect(l1.getLogs.some((r) => r.fromBlock === toHex(21_000n))).toBe(true)
  })

  it("after migration, notes still present: the bounded scan repeats at the same cost", async () => {
    const { l1 } = await boot("drained-sources-5", [tuple(1)], 5)
    expect(l1.calls.eth_getLogs).toBe(5 * chunksFrom(12_000n))
  })

  it("second boot in the same session: the sweep scan repeats, the deployment-block search does not", async () => {
    const first = await boot("second-boot-a-sources-5", [tuple(1)], 5)
    const second = await boot("second-boot-b-sources-5", [tuple(1)], 5)
    // No finding is persisted, so every log and balance read is paid again.
    expect(second.l1.calls.eth_getLogs).toBe(first.l1.calls.eth_getLogs)
    expect(second.l1.calls.eth_call).toBe(first.l1.calls.eth_call)
    // A deployment's first block cannot change, so the header search is paid once per session.
    expect(first.l1.calls.eth_getBlockByNumber).toBeGreaterThan(0)
    expect(second.l1.calls.eth_getBlockByNumber).toBeUndefined()
  })

  it("a published deployedAtBlock buys the same window for no header reads at all", async () => {
    const pinned = { ...tuple(1), deployedAtBlock: String(DEPLOY_BLOCKS[1]) } as OxideEnvTuple
    const { l1 } = await boot("deployed-at-block-sources-5", [pinned], 5)
    expect(l1.calls.eth_getBlockByNumber).toBeUndefined()
    expect(l1.calls.eth_getLogs).toBe(5 * chunksFrom(12_000n))
    expect(l1.getLogs[0]).toMatchObject({ fromBlock: toHex(12_000n) })
  })

  it("a sweep at exactly the deploy block is inside the bound and reported as swept", async () => {
    const { residuals } = await boot("sweep-at-deploy-block-sources-1", [tuple(1)], 1, {
      sweeps: [{ address: sourcesOf(1)[0]!.sipaAddress, block: 12_000n }],
    })
    expect(residuals).toHaveLength(1)
    expect(residuals[0]).toMatchObject({ sweptDeposits: 1, incomplete: false })
  })

  it("a node that keeps no historical state still completes the scan", async () => {
    const { l1, residuals } = await boot("pruned-state-sources-1", [tuple(1)], 1, {
      rejectGetCode: true,
      sweeps: [{ address: sourcesOf(1)[0]!.sipaAddress, block: 12_000n }],
    })
    expect(l1.calls.eth_getCode).toBeUndefined()
    expect(residuals).toHaveLength(1)
    expect(residuals[0]).toMatchObject({ sweptDeposits: 1, incomplete: false })
  })

  it("block search fails at zero balance: no sweep scan runs and no row is reported", async () => {
    const { l1, residuals } = await boot("getblock-fails-sources-5", [tuple(1)], 5, {
      rejectGetBlock: true,
    })
    expect(l1.calls.eth_getLogs).toBeUndefined()
    expect(residuals).toEqual([])
  })

  it("block search fails on a funded deployment: the row is reported as incomplete", async () => {
    const { residuals } = await boot(
      "getblock-fails-funded-sources-5",
      [tuple(1)],
      5,
      { rejectGetBlock: true },
      9n,
    )
    expect(residuals).toHaveLength(1)
    expect(residuals[0]).toMatchObject({ incomplete: true, balance: 9n })
  })

  it("source discovery fails at zero balance: no L1 scan runs and no row is reported", async () => {
    const { l1, residuals } = await boot("sources-fail-sources-5", [tuple(1)], 5, {
      rejectSources: true,
    })
    expect(l1.calls.eth_getLogs).toBeUndefined()
    expect(l1.calls.eth_getCode).toBeUndefined()
    expect(residuals).toEqual([])
  })

  it("writes the budget artifact once every condition has run", () => {
    expect(rows).toHaveLength(16)
    mkdirSync("test-artifacts", { recursive: true })
    writeFileSync(
      ARTIFACT,
      JSON.stringify(
        {
          scope:
            "probeAccountResiduals sweep scan: eth_blockNumber, eth_getBlockByNumber deployment-block search, balanceOf eth_call, Sweep eth_getLogs",
          outside: [
            "setupSipaDiscovery: the AccountMetadataRegistry log scan, chunked over the same range as the sweep scan, plus one eth_call per operator, per historic tuple",
            "readDepositSIPAImplementation: one eth_call per SIPA factory",
            "readDepositMessageKey: one eth_getTransactionReceipt per sweep found",
          ],
          head: HEAD.toString(),
          chunkBlocks: CHUNK.toString(),
          rows,
        },
        null,
        2,
      ),
    )
  })
})
