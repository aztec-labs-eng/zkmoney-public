import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  pad,
  toHex,
  type Hex,
  type PublicClient,
} from "viem"
import { OxidePortalEventsAbi } from "@oxide/l1-contracts"
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

/**
 * One observation per retired deployment, however many sources: its portal's `Deposit` logs by commitment and its
 * token's `Transfer` logs from the SIPAs, each one request on an archive RPC, and one multicall of every balance.
 */
const LOG_READS_PER_DEPLOYMENT = 2
const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11"

interface LogRange {
  address: string | string[]
  fromBlock: string
  toBlock: string
  topics?: (Hex | Hex[] | null)[]
}

interface CountingClient {
  client: PublicClient
  calls: Record<string, number>
  getLogs: LogRange[]
}

interface Chain {
  /** A sweep of a source: its portal `Deposit` and the SIPA's `Transfer` out, in one transaction. */
  sweeps: { address: string; block: bigint }[]
  rejectGetCode?: boolean
  rejectGetBlock?: boolean
  rejectSources?: boolean
}

const log = (address: string, topics: Hex[], data: Hex, block: bigint, tx: Hex) => ({
  address,
  topics,
  data,
  blockNumber: toHex(block),
  blockHash: "0x" + "1".repeat(64),
  transactionHash: tx,
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
})
const sweepTx = (address: string) => pad(address as Hex, { size: 32 })
const listed = (topic: Hex | Hex[] | null | undefined, value: Hex) =>
  !topic || [topic].flat().some((t) => t.toLowerCase() === value.toLowerCase())

/** Answers the observation's log queries: the portal's deposits by commitment, the token's transfers from SIPAs. */
function logsFor(chain: Chain, filter: LogRange) {
  const inRange = (block: bigint) => block >= BigInt(filter.fromBlock) && block <= BigInt(filter.toBlock)
  const sweeps = chain.sweeps.filter((s) => inRange(s.block))
  const [topic0, topic1] = filter.topics ?? []
  const [deposit] = encodeEventTopics({ abi: OxidePortalEventsAbi, eventName: "Deposit" })
  const [transfer] = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" })
  if (topic0 === deposit)
    return sweeps
      .filter((s) => listed(topic1, commitmentOf(s.address)))
      .map((s) =>
        log(
          [filter.address].flat()[0]!,
          [deposit!, commitmentOf(s.address)],
          encodeAbiParameters(
            [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
            [100n, ("0x" + "ab".repeat(32)) as Hex, 7n],
          ),
          s.block,
          sweepTx(s.address),
        ),
      )
  if (topic0 === transfer)
    return sweeps
      .filter((s) => listed(topic1, pad(s.address as Hex, { size: 32 })))
      .map((s) =>
        log(
          [filter.address].flat()[0]!,
          [transfer!, pad(s.address as Hex, { size: 32 }), pad(PORTAL_OF_TUPLE_1, { size: 32 })],
          encodeAbiParameters([{ type: "uint256" }], [100n]),
          s.block,
          sweepTx(s.address),
        ),
      )
  return []
}

/** Answers Multicall3 with a zero balance for every call it batches. */
function multicallResult(data: Hex) {
  const { args } = decodeFunctionData({ abi: multicall3Abi, data })
  const calls = (args?.[0] ?? []) as unknown[]
  return encodeFunctionResult({
    abi: multicall3Abi,
    functionName: "aggregate3",
    result: calls.map(() => ({ success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [0n]) })),
  })
}

function countingClient(chain: Chain): CountingClient {
  const calls: Record<string, number> = {}
  const getLogs: LogRange[] = []
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls[method] = (calls[method] ?? 0) + 1
      if (method === "eth_chainId") return toHex(sepolia.id)
      if (method === "eth_blockNumber") return toHex(HEAD)
      if (method === "eth_call") {
        const [call] = params as [{ to: string; data: Hex }]
        if (call.to.toLowerCase() === MULTICALL) return multicallResult(call.data)
        return "0x" + "0".repeat(64)
      }
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
        return logsFor(chain, filter)
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
    retire = async () => undefined
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
  readSipaDepositsConsumed: async (_node: unknown, _scope: unknown, keys: unknown[]) =>
    keys.map(() => false),
  readDepositSIPAImplementation: async () => "0x" + "dd".repeat(20),
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
    assets: [],
  }),
}))
vi.mock("../src/config/oxideTuple", () => ({
  l1PublicClient: () => (h.active.current as CountingClient).client,
  l1MulticallClient: () => (h.active.current as CountingClient).client,
  getOtherManifestSources: async () => [],
}))
vi.mock("../src/features/savings/savingsGateway", () => ({
  getSavingsTuple: async () => undefined,
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => "0x01" }),
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../src/platform/storage/activeStorage", () => ({ getActiveStorageId: () => "acct" }))
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
    depositSIPAImplementation: "0x" + "dd".repeat(20),
  } as OxideEnvTuple)

const current = tuple(9)
const wallet = { node: {}, pxe: {} } as never
const account = {
  getAddress: () => ({ toString: () => "0x" + "ee".repeat(32) }),
  makeDepositSpendMetadataResolver: async () => async () => ({ masterNullifierHidingKey: 1 }),
} as never

const PORTAL_OF_TUPLE_1 = ("0x" + "1".padStart(40, "0")) as Hex
/** Each source's portal commitment, derived from its address so the fake chain can answer by either. */
const commitmentOf = (sipaAddress: string) => pad(sipaAddress as Hex, { size: 32, dir: "right" })

function sourcesOf(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const sipaAddress = "0x" + (i + 0x100).toString(16).padStart(40, "0")
    return {
      sipaAddress,
      recipientL2Address: "0x" + "ee".repeat(32),
      messageSecret: "0x01",
      recipientCommitment: commitmentOf(sipaAddress),
    }
  })
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
  h.detect.mockResolvedValue({ current, historic, destinations: new Map() })
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

describe("migration scan budget of one wallet boot", () => {
  it("no historic entry: no L1 call", async () => {
    const { l1 } = await boot("no-historic", [], 0)
    expect(l1.calls).toEqual({})
  })

  it("one historic entry, 0 sources: the freeze check and the head read only, no block search", async () => {
    const { l1 } = await boot("historic-1-sources-0", [tuple(1)], 0)
    expect(l1.calls).toEqual({ eth_blockNumber: 1, eth_call: 1 })
  })

  it("scans from the deployment's deployedAt, never from its later updatedAt", async () => {
    const { l1 } = await boot("republished-tuple-sources-1", [tuple(1)], 1)
    expect(l1.getLogs[0]).toMatchObject({ fromBlock: toHex(12_000n) })
  })

  it.each([1, 5, 20])(
    "one historic entry, %i sources: one observation from the portal's deploy block, whatever the count",
    async (sources) => {
      const { l1 } = await boot(`historic-1-sources-${sources}`, [tuple(1)], sources)
      expect(l1.calls.eth_getLogs).toBe(LOG_READS_PER_DEPLOYMENT)
      // The portal's freeze check, and one multicall of every balance.
      expect(l1.calls.eth_call).toBe(2)
      expect(l1.calls.eth_getCode).toBeUndefined()
      expect(l1.calls.eth_getBlockByNumber).toBeLessThanOrEqual(HEADER_READ_BUDGET_PER_TUPLE)
      expect(l1.getLogs[0]).toMatchObject({ fromBlock: toHex(12_000n), toBlock: toHex(HEAD) })
      expect(l1.getLogs.at(-1)).toMatchObject({ toBlock: toHex(HEAD) })
      expect(l1.getLogs.every((r) => BigInt(r.fromBlock) >= 12_000n)).toBe(true)
    },
  )

  it("two historic entries, 5 sources each: each portal scans from its own deploy block", async () => {
    const { l1 } = await boot("historic-2-sources-5", [tuple(1), tuple(2)], 5)
    expect(l1.calls.eth_getLogs).toBe(2 * LOG_READS_PER_DEPLOYMENT)
    expect(l1.calls.eth_getBlockByNumber).toBeLessThanOrEqual(2 * HEADER_READ_BUDGET_PER_TUPLE)
    expect(l1.getLogs.some((r) => r.fromBlock === toHex(21_000n))).toBe(true)
  })

  it("after migration, notes still present: the bounded scan repeats at the same cost", async () => {
    const { l1 } = await boot("drained-sources-5", [tuple(1)], 5)
    expect(l1.calls.eth_getLogs).toBe(LOG_READS_PER_DEPLOYMENT)
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
    expect(l1.calls.eth_getLogs).toBe(LOG_READS_PER_DEPLOYMENT)
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

  it("block search fails at zero balance: no sweep scan runs and the row stays incomplete", async () => {
    const { l1, residuals } = await boot("getblock-fails-sources-5", [tuple(1)], 5, {
      rejectGetBlock: true,
    })
    expect(l1.calls.eth_getLogs).toBeUndefined()
    expect(residuals).toEqual([expect.objectContaining({ incomplete: true, balance: 0n, hasResiduals: false })])
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

  it("source discovery fails at zero balance: no L1 scan runs and the row stays incomplete", async () => {
    const { l1, residuals } = await boot("sources-fail-sources-5", [tuple(1)], 5, {
      rejectSources: true,
    })
    expect(l1.calls.eth_getLogs).toBeUndefined()
    expect(l1.calls.eth_getCode).toBeUndefined()
    expect(residuals).toEqual([expect.objectContaining({ incomplete: true, balance: 0n, hasResiduals: false })])
  })

  it("writes the budget artifact once every condition has run", () => {
    expect(rows).toHaveLength(16)
    mkdirSync("test-artifacts", { recursive: true })
    writeFileSync(
      ARTIFACT,
      JSON.stringify(
        {
          scope:
            "probeAccountResiduals scan: the portal's isFrozen eth_call, eth_blockNumber, eth_getBlockByNumber deployment-block search, and one observation per deployment (portal Deposit and token Transfer eth_getLogs, one balance multicall)",
          outside: [
            "setupSipaDiscovery: the AccountMetadataRegistry log scan, chunked over the same range as the sweep scan, plus one eth_call per operator, per historic tuple",
            "readDepositSIPAImplementation: one eth_call per SIPA factory",
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
