// @vitest-environment node
/**
 * Deposit sync benchmark: one account with a history of deposits, synced through the real
 * `syncSipaDeposits` against a local JSON-RPC L1 and a fake L2 node, each answering after a fixed
 * latency. One HTTP request costs one latency however many JSON-RPC calls it batches, as it does
 * against a real RPC. Run it on two checkouts to compare pipelines; the storage a run leaves can seed
 * the other's "previous storage" layout.
 *
 *   pnpm --filter @obsidion/front-core bench:sipa
 *
 * Env: SIPA_BENCH_LATENCY_MS (200), SIPA_BENCH_DEPOSITS (25), SIPA_BENCH_LABEL, SIPA_BENCH_OUT (JSON
 * results), SIPA_BENCH_STATE_OUT (storage after the fresh-device run), SIPA_BENCH_STATE_IN (storage
 * to run as the previous layout).
 */
import { createServer, type Server } from "node:http"
import { readFileSync, writeFileSync } from "node:fs"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  http,
  multicall3Abi,
  pad,
  parseAbi,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from "viem"
import { mainnet } from "viem/chains"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { EthAddress } from "@aztec/foundation/eth-address"
import { keccak256 } from "@aztec/foundation/crypto/keccak"
import { deriveMasterNullifierHidingSecretKey } from "@aztec/stdlib/keys"
import type { OxideEnvTuple } from "@obsidion/core/types"

const LATENCY_MS = Number(process.env.SIPA_BENCH_LATENCY_MS ?? 200)
const DEPOSITS = Number(process.env.SIPA_BENCH_DEPOSITS ?? 25)
const LABEL = process.env.SIPA_BENCH_LABEL ?? "this checkout"
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const l2 = vi.hoisted(() => ({ calls: 0, events: [] as unknown[] }))
vi.mock("@obsidion/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@obsidion/sdk")>()
  return {
    ...actual,
    // The PXE's private-event read: one node round trip.
    fetchSipaEvents: async () => {
      l2.calls += 1
      await sleep(Number(process.env.SIPA_BENCH_LATENCY_MS ?? 200))
      return l2.events
    },
  }
})

import { computeStealthRecipientHash, deriveRecoveryAddress } from "@obsidion/sdk"
import { SIPADepositStore } from "../src/core/services/deposits/SIPADepositStore"
import { computeSIPAAddress } from "../src/core/services/deposits/sipa/sipaAddress"
import { deriveStealthKey } from "../src/oxide/oxideAccountKeys"
import { syncSipaDeposits } from "../src/oxide/sipaClaims"

const HEAD = 21_000_000n
const DEPLOYED = HEAD - 500_000n
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address
const PORTAL = "0x92308ce04e2416f20b03e941a14f9238c3603334" as Address
const FACTORY = "0x239474855dff1eb58dca3ee877d599e3c6bd0bd2" as Address
const IMPLEMENTATION = "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4" as Address
const RELAYER = "0x00000000000000000000000000000000000000e1" as Address
const FPC_FUNDER = "0x00000000000000000000000000000000000000e2" as Address
const FUNDER = "0x00000000000000000000000000000000000000f1" as Address
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11" as Address
const ROLLUP_VERSION = 4127419662n
const DEPOSIT_FEE = 25n * 10n ** 16n
const CUT = 10n ** 16n
const RECIPIENT = AztecAddress.fromBigIntUnsafe(0xbeefn)
const STEALTH = deriveStealthKey(new Fr(7n)).publicKey
const TUPLE = {
  sipaFactory: FACTORY,
  portal: PORTAL,
  rollupVersion: ROLLUP_VERSION.toString(),
  l2Token: "0x0000000000000000000000000000000000000000000000000000000000001234",
} as unknown as OxideEnvTuple

// ── The account's history on L1 ────────────────────────────────────────────────

type RpcLog = {
  address: Address
  topics: Hex[]
  data: Hex
  blockNumber: bigint
  txHash: Hex
  logIndex: number
}
const events = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Sweep(uint256 index, uint256 amount)",
  "event Deposit(bytes32 indexed recipientCommitment, uint256 amount, bytes32 key, uint256 index)",
])
const logs: RpcLog[] = []
const receipts = new Map<string, RpcLog[]>()
const balances = new Map<string, bigint>()
let txCounter = 0
const nextTx = () => pad(toHex(++txCounter), { size: 32 })

function emit(
  tx: Hex,
  blockNumber: bigint,
  address: Address,
  eventName: "Transfer" | "Sweep" | "Deposit",
  args: Record<string, unknown>,
  data: Hex,
) {
  const topics = encodeEventTopics({ abi: events, eventName, args } as never) as Hex[]
  const log = {
    address,
    topics,
    data,
    blockNumber,
    txHash: tx,
    logIndex: receipts.get(tx)?.length ?? 0,
  }
  logs.push(log)
  receipts.set(tx, [...(receipts.get(tx) ?? []), log])
}
const uint = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v])

async function buildHistory() {
  for (let i = 0; i < DEPOSITS + 2; i++) {
    const salt = new Fr(BigInt(0x1000 + i))
    const commitment = await computeStealthRecipientHash(salt, RECIPIENT)
    const intentHash = keccak256(commitment.toBuffer())
    const sipa = computeSIPAAddress({
      sipaFactory: EthAddress.fromString(FACTORY),
      implementation: EthAddress.fromString(IMPLEMENTATION),
      intentHash,
      rollupVersion: ROLLUP_VERSION,
      resweepable: true,
      recoveryAddress: deriveRecoveryAddress(STEALTH, salt),
    } as never)
      .toString()
      .toLowerCase() as Address
    l2.events.push({
      sharedSecretSalt: salt,
      resweepable: true,
      intentHash: `0x${intentHash.toString("hex")}`,
    })
    const gross = 100n * 10n ** 18n + BigInt(i) * 10n ** 18n
    if (i < DEPOSITS) {
      // Funded, swept and claimed long ago.
      const funded = DEPLOYED + 1_000n + BigInt(i) * 15_000n
      emit(nextTx(), funded, DAI, "Transfer", { from: FUNDER, to: sipa }, uint(gross))
      const sweep = nextTx()
      const bridged = gross - DEPOSIT_FEE
      const credited = bridged - CUT
      const index = BigInt(1_000 + i)
      const key = pad(toHex(0x5000 + i), { size: 32 })
      emit(sweep, funded + 20n, DAI, "Transfer", { from: sipa, to: RELAYER }, uint(DEPOSIT_FEE))
      emit(sweep, funded + 20n, DAI, "Transfer", { from: sipa, to: PORTAL }, uint(bridged))
      emit(sweep, funded + 20n, DAI, "Transfer", { from: PORTAL, to: FPC_FUNDER }, uint(CUT))
      emit(
        sweep,
        funded + 20n,
        PORTAL,
        "Deposit",
        { recipientCommitment: commitment.toString() },
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
          [credited, key, index],
        ),
      )
      emit(
        sweep,
        funded + 20n,
        sipa,
        "Sweep",
        {},
        encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [index, credited]),
      )
    } else {
      // One funded and waiting for its sweep, one below the floor.
      const amount = i === DEPOSITS ? gross : 10n ** 15n
      emit(
        nextTx(),
        HEAD - 100n - BigInt(i),
        DAI,
        "Transfer",
        { from: FUNDER, to: sipa },
        uint(amount),
      )
      balances.set(sipa, amount)
    }
  }
}

// ── A JSON-RPC L1 with a fixed latency per HTTP request ───────────────────────

// Answers like production's archive RPC: no limit on filter lists or ranges.
const stats = { http: 0, calls: new Map<string, number>() }

const selectors = {
  balanceOf: toFunctionSelector("balanceOf(address)"),
  getEthBalance: toFunctionSelector("getEthBalance(address)"),
  implementationFor: toFunctionSelector("implementationFor(address,uint8)"),
  depositFee: toFunctionSelector("depositFee()"),
  cut: toFunctionSelector("FPC_FUNDING_CUT()"),
}
const word = (hex: string) => `0x${hex.slice(2).padStart(64, "0")}` as Hex

function answerCall(to: string, data: Hex): Hex {
  const selector = data.slice(0, 10)
  if (selector === selectors.balanceOf) return uint(balances.get(`0x${data.slice(34, 74)}`) ?? 0n)
  if (selector === selectors.getEthBalance) return uint(0n)
  if (selector === selectors.implementationFor) return word(IMPLEMENTATION)
  if (selector === selectors.depositFee) return uint(DEPOSIT_FEE)
  if (selector === selectors.cut) return uint(CUT)
  throw new Error(`unanswered call ${selector} to ${to}`)
}

const rpcLog = (l: RpcLog) => ({
  address: l.address,
  topics: l.topics,
  data: l.data,
  blockNumber: toHex(l.blockNumber),
  blockHash: pad(toHex(l.blockNumber), { size: 32 }),
  transactionHash: l.txHash,
  transactionIndex: "0x0",
  logIndex: toHex(l.logIndex),
  removed: false,
})

function matches(
  log: RpcLog,
  filter: { address?: string | string[]; topics?: (string | string[] | null)[] },
) {
  if (filter.address) {
    const addresses = [filter.address].flat().map((a) => a.toLowerCase())
    if (!addresses.includes(log.address.toLowerCase())) return false
  }
  return (filter.topics ?? []).every((topic, i) => {
    if (topic === null || topic === undefined) return true
    const wanted = [topic].flat().map((t) => t.toLowerCase())
    return wanted.includes(log.topics[i]?.toLowerCase() ?? "")
  })
}

function handle(method: string, params: unknown[]): unknown {
  stats.calls.set(method, (stats.calls.get(method) ?? 0) + 1)
  switch (method) {
    case "eth_chainId":
      return "0x1"
    case "eth_blockNumber":
      return toHex(HEAD)
    case "eth_getLogs": {
      const filter = params[0] as {
        address?: string | string[]
        topics?: (string | string[] | null)[]
        fromBlock: Hex
        toBlock: Hex
      }
      const from = BigInt(filter.fromBlock)
      const to = filter.toBlock === "latest" ? HEAD : BigInt(filter.toBlock)
      return logs
        .filter((l) => l.blockNumber >= from && l.blockNumber <= to && matches(l, filter))
        .map(rpcLog)
    }
    case "eth_call": {
      const { to, data } = params[0] as { to: string; data: Hex }
      if (to.toLowerCase() !== MULTICALL3) return answerCall(to, data)
      const { args } = decodeFunctionData({ abi: multicall3Abi, data }) as unknown as {
        args: [readonly { target: string; callData: Hex }[]]
      }
      const results = args[0].map((call) => {
        try {
          return { success: true, returnData: answerCall(call.target, call.callData) }
        } catch {
          return { success: false, returnData: "0x" as Hex }
        }
      })
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: results,
      })
    }
    case "eth_getBlockByNumber": {
      const n = BigInt(params[0] as Hex)
      return {
        number: toHex(n),
        hash: pad(toHex(n), { size: 32 }),
        parentHash: pad(toHex(n - 1n), { size: 32 }),
        timestamp: toHex(1_700_000_000n + n * 12n),
        transactions: [],
        gasLimit: "0x0",
        gasUsed: "0x0",
        baseFeePerGas: "0x0",
        difficulty: "0x0",
        logsBloom: "0x",
        miner: RELAYER,
        extraData: "0x",
        nonce: "0x0000000000000000",
        size: "0x0",
        stateRoot: pad("0x0", { size: 32 }),
        receiptsRoot: pad("0x0", { size: 32 }),
        transactionsRoot: pad("0x0", { size: 32 }),
        sha3Uncles: pad("0x0", { size: 32 }),
        uncles: [],
      }
    }
    case "eth_getTransactionReceipt": {
      const hash = (params[0] as string).toLowerCase()
      const receiptLogs = receipts.get(hash) ?? []
      const block = receiptLogs[0]?.blockNumber ?? HEAD
      return {
        transactionHash: hash,
        blockHash: pad(toHex(block), { size: 32 }),
        blockNumber: toHex(block),
        logs: receiptLogs.map(rpcLog),
        status: "0x1",
        from: RELAYER,
        to: MULTICALL3,
        contractAddress: null,
        cumulativeGasUsed: "0x0",
        gasUsed: "0x0",
        effectiveGasPrice: "0x0",
        logsBloom: "0x",
        transactionIndex: "0x0",
        type: "0x2",
      }
    }
    case "eth_getCode":
      return "0x"
    case "eth_getBalance":
      return "0x0"
    default:
      throw { code: -32601, message: `method ${method} not served` }
  }
}

let server: Server
let url = ""

beforeAll(async () => {
  await buildHistory()
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", async () => {
      stats.http += 1
      await sleep(LATENCY_MS)
      const parsed = JSON.parse(body)
      const answer = (call: { id: number; method: string; params: unknown[] }) => {
        try {
          return { jsonrpc: "2.0", id: call.id, result: handle(call.method, call.params) }
        } catch (error) {
          const e = error as { code?: number; message?: string }
          return {
            jsonrpc: "2.0",
            id: call.id,
            error: { code: e.code ?? -32000, message: e.message ?? String(error) },
          }
        }
      }
      const reply = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(reply))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 120_000)

afterAll(() => {
  server?.close()
})

// ── Runs ──────────────────────────────────────────────────────────────────────

class MemoryStorage {
  data = new Map<string, string>()
  async getItem(key: string) {
    return this.data.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.data.set(key, value)
  }
  async removeItem(key: string) {
    this.data.delete(key)
  }
  async clear() {
    this.data.clear()
  }
}

async function freshStore(seed?: Record<string, string>) {
  ;(SIPADepositStore as unknown as { instance: unknown }).instance = null
  const storage = new MemoryStorage()
  for (const [key, value] of Object.entries(seed ?? {})) storage.data.set(key, value)
  const store = SIPADepositStore.get(storage)
  await store.load()
  return { store, storage }
}

/** Every deposit was claimed on another device; the one still unswept has nothing to claim. */
const tokenService = {
  claimSweptDeposit: async () => {
    l2.calls += 1
    await sleep(LATENCY_MS)
    throw new Error("deposit already stored")
  },
}
const node = {
  getL1ToL2MessageCheckpoint: async () => {
    l2.calls += 1
    await sleep(LATENCY_MS)
    return 1
  },
  getBlockData: async () => {
    l2.calls += 1
    await sleep(LATENCY_MS)
    return { checkpointNumber: 9 }
  },
  // Every replayed deposit's nullifier is in the tree: spent on another device.
  findLeavesIndexes: async (_block: unknown, _tree: unknown, leaves: unknown[]) => {
    l2.calls += 1
    await sleep(LATENCY_MS)
    return leaves.map(() => ({ data: 1n, l2BlockNumber: 1, l2BlockHash: "0x00" }))
  },
}

/** The previous pipeline rescans a settled SIPA once its 5-minute slow-lane interval passes. */
async function slowLaneTurn(store: SIPADepositStore) {
  for (const record of store.list())
    await store.upsert(record.sipaAddress, { phase: record.phase, lastScanAt: 0 } as never)
}

type Row = {
  label: string
  layout: string
  pass: number
  ms: number
  http: number
  rpc: number
  l2: number
  result: string
}
const rows: Row[] = []

async function pass(
  store: SIPADepositStore,
  layout: string,
  n: number,
  opts: { observeOnly?: boolean } = {},
) {
  stats.http = 0
  stats.calls.clear()
  l2.calls = 0
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(url, { batch: true, retryCount: 0 }),
  })
  const started = performance.now()
  const result = await syncSipaDeposits({
    publicClient: publicClient as never,
    node: node as never,
    wallet: {} as never,
    tokenService: tokenService as never,
    refreshBalance: async () => {
      l2.calls += 1
      await sleep(LATENCY_MS)
    },
    store,
    tuple: TUPLE,
    recipient: RECIPIENT,
    stealthPublicKey: STEALTH,
    masterNullifierHidingKey: deriveMasterNullifierHidingSecretKey(new Fr(7n)),
    token: { address: DAI, symbol: "DAI", decimals: 18 },
    l1ChainId: 1,
    historyStartBlock: async () => DEPLOYED,
    ...opts,
  } as never)
  const ms = Math.round(performance.now() - started)
  const rpc = [...stats.calls.values()].reduce((a, b) => a + b, 0)
  const summary = `claimed ${result.claimed}, reconciled ${result.reconciled}, recoverable ${result.recoverable}, failed ${result.failed}`
  rows.push({
    label: LABEL,
    layout,
    pass: n,
    ms,
    http: stats.http,
    rpc,
    l2: l2.calls,
    result: summary,
  })
  console.log(
    `[bench] ${LABEL} | ${layout} | pass ${n}: ${ms} ms, ${stats.http} HTTP, ${rpc} JSON-RPC (${[
      ...stats.calls,
    ]
      .map(([m, c]) => `${m} ${c}`)
      .join(", ")}), ${l2.calls} L2 | ${summary}`,
  )
}

describe(`SIPA deposit sync, ${
  DEPOSITS + 2
} SIPAs, ${LATENCY_MS} ms per L1 request and L2 call`, () => {
  it("runs every storage layout", async () => {
    const fresh = await freshStore()
    await pass(fresh.store, "fresh device (empty storage)", 1)
    await pass(fresh.store, "fresh device (empty storage)", 2)
    await slowLaneTurn(fresh.store)
    await pass(fresh.store, "fresh device (empty storage), slow-lane turn", 3)
    await pass(fresh.store, "watched tick, no new block", 4, { observeOnly: true })
    if (process.env.SIPA_BENCH_STATE_OUT) {
      writeFileSync(
        process.env.SIPA_BENCH_STATE_OUT,
        JSON.stringify(Object.fromEntries(fresh.storage.data)),
      )
    }
    if (process.env.SIPA_BENCH_STATE_IN) {
      const seed = JSON.parse(readFileSync(process.env.SIPA_BENCH_STATE_IN, "utf8")) as Record<
        string,
        string
      >
      const previous = await freshStore(seed)
      await pass(previous.store, "previous pipeline's storage", 1)
      await pass(previous.store, "previous pipeline's storage", 2)
    }
    if (process.env.SIPA_BENCH_OUT)
      writeFileSync(process.env.SIPA_BENCH_OUT, JSON.stringify(rows, null, 2))
  }, 3_600_000)
})
