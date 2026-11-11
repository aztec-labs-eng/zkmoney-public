/**
 * An in-memory L1 behind a real viem client: the JSON-RPC methods the SIPA pipeline sends, answered
 * from contract state and logs a test builds. Calls are ABI-decoded and answers ABI-encoded, so the
 * sdk readers run unchanged. `fakeL1.l1.test.ts` holds it to a real EVM.
 */
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  erc4626Abi,
  multicall3Abi,
  pad,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { mainnet } from "viem/chains"
import {
  ForwardingTableAbi,
  OxidePortalAbi,
  OxidePortalEventsAbi,
  SIPAAbi,
  SIPAFactoryAbi,
} from "@oxide/l1-contracts"

export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11" as Address
/** The address a sweep's relayer sends from. */
export const RELAYER = "0x00000000000000000000000000000000000000e1" as Address

/** One JSON-RPC request the client sent; `fn` names an `eth_call`'s function, inner calls apart. */
export interface L1Call {
  method: string
  to?: string
  fn?: string
  /** A log read's blocks. */
  range?: [bigint, bigint]
  /** The block an `eth_call` reads at; absent at the head. */
  block?: bigint
}

interface Log {
  address: Address
  topics: Hex[]
  data: Hex
  block: bigint
  tx: Hex
  index: number
}

/** What an extra factory or table answers. */
export interface ContractState {
  implementations: Map<number, Address>
  intentOf: Map<string, number>
  cloneImplementation: Map<string, Address>
  rows: Map<string, TableRow>
  row(token: Address, intent: number, row: TableRow): void
}

/** A deployed clone: the implementation its code delegates to and the arguments it reports. */
export interface CloneArgs {
  implementation: Address
  intentHash: Hex
  recoveryCommitment: Hex
  forwardingTable: Address
  resweepable: boolean
}

export interface TableRow {
  portal: Address
  beneficiary?: Address
  beneficiaryFee?: bigint
  sweepTip?: bigint
}

/** A call that reverts, the way a node answers one. */
export class Reverted extends Error {
  readonly code = 3
  readonly data = "0x"
}

const lower = (a: string) => a.toLowerCase()
const ETH = zeroAddress

export class FakeL1 {
  head = 1_000_000n
  /** Every request the client sent, in order. */
  readonly calls: L1Call[] = []
  /** Answers `true` to fail a request: the node errors as an outage would. */
  failing: (call: L1Call & { params: unknown }) => boolean = () => false
  /** Runs before each request is answered: a test acts mid-pass here. */
  before: (call: L1Call) => void | Promise<void> = () => {}
  /** Answers `true` to revert one contract read, inner calls of a multicall included. */
  reverts: (target: string, fn: string, args: readonly unknown[]) => boolean = () => false
  readonly implementations = new Map<number, Address>()
  readonly intentOf = new Map<string, number>()
  readonly cloneImplementation = new Map<string, Address>()
  readonly rows = new Map<string, TableRow>()
  readonly caps = new Map<string, bigint>()
  readonly decimals = new Map<string, number>()
  readonly symbols = new Map<string, string>()
  /** Each ERC-4626 vault's assets per whole share, by block. */
  readonly sharePrices = new Map<string, (block: bigint) => bigint>()
  readonly client: PublicClient
  private readonly logs: Log[] = []
  private readonly balances = new Map<string, bigint>()
  private readonly abis = new Map<string, Abi>([[MULTICALL3, multicall3Abi as Abi]])
  private readonly own = new Map<string, ContractState>()
  private readonly clones = new Map<string, CloneArgs>()
  private txs = 0

  constructor(readonly contracts: { factory: Address; table: Address; portals: Address[] }) {
    this.abis.set(lower(contracts.factory), SIPAFactoryAbi as Abi)
    this.abis.set(lower(contracts.table), ForwardingTableAbi as Abi)
    for (const portal of contracts.portals) this.abis.set(lower(portal), OxidePortalAbi as Abi)
    this.client = createPublicClient({
      chain: mainnet,
      // A failure fails: the client's own retries would hide it.
      transport: custom({ request: (r) => this.request(r) }, { retryCount: 0 }),
    }) as PublicClient
  }

  /**
   * Another SIPA factory or forwarding table, an earlier SIPA set's. It answers from its own state,
   * which starts empty.
   */
  contract(address: Address, kind: "factory" | "table"): ContractState {
    this.abis.set(lower(address), (kind === "factory" ? SIPAFactoryAbi : ForwardingTableAbi) as Abi)
    const state: ContractState = {
      implementations: new Map(),
      intentOf: new Map(),
      cloneImplementation: new Map(),
      rows: new Map(),
      row: (token, intent, row) => state.rows.set(`${lower(token)}:${intent}`, row),
    }
    this.own.set(lower(address), state)
    return state
  }

  /** A block's timestamp, seconds. */
  timeOf(block: bigint): bigint {
    return 1_700_000_000n + block * 12n
  }

  token(address: Address, symbol: string, decimals: number): void {
    this.abis.set(lower(address), erc20Abi as Abi)
    this.symbols.set(lower(address), symbol)
    this.decimals.set(lower(address), decimals)
  }

  /** An ERC-4626 vault whose whole share redeems for `priceAt(block)` of its asset. */
  vault(address: Address, decimals: number, priceAt: (block: bigint) => bigint): void {
    this.abis.set(lower(address), [...erc20Abi, ...erc4626Abi] as Abi)
    this.decimals.set(lower(address), decimals)
    this.sharePrices.set(lower(address), priceAt)
  }

  row(token: Address, intent: number, row: TableRow): void {
    this.rows.set(`${lower(token)}:${intent}`, row)
  }

  balanceOf(holder: Address, token: Address = ETH): bigint {
    return this.balances.get(`${lower(holder)}:${lower(token)}`) ?? 0n
  }

  setBalance(holder: Address, token: Address, amount: bigint): void {
    this.balances.set(`${lower(holder)}:${lower(token)}`, amount)
  }

  /** A new transaction's hash. */
  tx(): Hex {
    return pad(toHex(++this.txs), { size: 32 })
  }

  emit(
    address: Address,
    abi: Abi,
    eventName: string,
    args: Record<string, unknown>,
    at: {
      tx: Hex
      block?: bigint
    },
  ): void {
    const event = abi.find((i) => i.type === "event" && i.name === eventName) as {
      inputs: readonly { name: string; type: string; indexed?: boolean }[]
    }
    const data = event.inputs.filter((i) => !i.indexed)
    this.logs.push({
      address,
      topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[],
      data: encodeAbiParameters(data, data.map((i) => args[i.name]) as never),
      block: at.block ?? this.head,
      tx: at.tx,
      index: this.logs.filter((l) => l.tx === at.tx).length,
    })
  }

  /** `from` sends `amount` of `token` to `to`; ETH has no log. */
  transfer(token: Address, from: Address, to: Address, amount: bigint, block?: bigint): Hex {
    const tx = this.tx()
    if (token !== ETH)
      this.emit(token, erc20Abi as Abi, "Transfer", { from, to, value: amount }, { tx, block })
    this.setBalance(from, token, this.balanceOf(from, token) - amount)
    this.setBalance(to, token, this.balanceOf(to, token) + amount)
    return tx
  }

  /**
   * The relayer sweeps `gross` of `token` out of `sipa` into `portal`, which credits `credit` under
   * `commitment` at inbox `index`. Returns the sweep's tx and its L1→L2 message key.
   */
  sweep(s: {
    sipa: Address
    token: Address
    gross: bigint
    credit: bigint
    index: bigint
    commitment: Hex
    portal: Address
    block?: bigint
    /** Contracts emitting a `Sweep` for this deposit before the SIPA, e.g. a forger. */
    alsoEmitted?: Address[]
    /** A transaction that already swept another SIPA. */
    tx?: Hex
    /** The swept clone's arguments; zero when the test does not care. */
    clone?: CloneArgs
  }): { tx: Hex; key: Hex } {
    const tx = s.tx ?? this.tx()
    this.abis.set(lower(s.sipa), SIPAAbi as Abi)
    if (s.clone || !this.clones.has(lower(s.sipa)))
      this.clones.set(
        lower(s.sipa),
        s.clone ?? {
          intentHash: pad("0x0", { size: 32 }),
          recoveryCommitment: pad("0x0", { size: 32 }),
          forwardingTable: zeroAddress,
          resweepable: true,
          implementation: zeroAddress,
        },
      )
    const key = pad(toHex(0x5000n + s.index), { size: 32 })
    const at = { tx, block: s.block }
    for (const forger of s.alsoEmitted ?? [])
      this.emit(forger, SIPAAbi as Abi, "Sweep", { index: s.index, amount: s.credit }, at)
    this.emit(
      s.token,
      erc20Abi as Abi,
      "Transfer",
      { from: s.sipa, to: s.portal, value: s.gross },
      at,
    )
    this.setBalance(s.sipa, s.token, this.balanceOf(s.sipa, s.token) - s.gross)
    this.emit(s.sipa, SIPAAbi as Abi, "Sweep", { index: s.index, amount: s.credit }, at)
    this.emit(
      s.portal,
      OxidePortalEventsAbi as Abi,
      "Deposit",
      { recipientCommitment: s.commitment, amount: s.credit, key, index: s.index },
      at,
    )
    return { tx, key }
  }

  /** A reorg leaves `tx` out: its logs go. Balances are the test's to set. */
  reorg(tx: Hex): void {
    for (let i = this.logs.length - 1; i >= 0; i--)
      if (this.logs[i]!.tx === tx) this.logs.splice(i, 1)
  }

  /** A portal `Deposit` no SIPA made: a migration executor's direct deposit. */
  directDeposit(d: {
    portal: Address
    commitment: Hex
    credit: bigint
    index: bigint
    block?: bigint
  }) {
    const tx = this.tx()
    const key = pad(toHex(0x5000n + d.index), { size: 32 })
    this.emit(
      d.portal,
      OxidePortalEventsAbi as Abi,
      "Deposit",
      { recipientCommitment: d.commitment, amount: d.credit, key, index: d.index },
      { tx, block: d.block },
    )
    return { tx, key }
  }

  bless(intent: number, implementation: Address, block = this.head): void {
    this.implementations.set(intent, implementation)
    this.emit(
      this.contracts.factory,
      SIPAFactoryAbi as Abi,
      "ImplementationBlessed",
      { implementation, intent },
      { tx: this.tx(), block },
    )
  }

  /** How many requests matched `pick`. */
  count(pick: Partial<L1Call>): number {
    return this.calls.filter((c) =>
      Object.entries(pick).every(([k, v]) => c[k as keyof L1Call] === v),
    ).length
  }

  private answer(to: Address, data: Hex, block = this.head): Hex {
    const target = lower(to)
    const abi = this.abis.get(target)
    if (!abi) return "0x"
    const { functionName, args = [] } = decodeFunctionData({ abi, data })
    const result = this.read(target, functionName, args as readonly unknown[], block)
    return encodeFunctionResult({ abi, functionName, result } as never)
  }

  private read(target: string, fn: string, args: readonly unknown[], block: bigint): unknown {
    if (this.reverts(target, fn, args)) throw new Reverted(fn)
    const state = this.own.get(target) ?? this
    const clone = this.clones.get(target)
    if (clone && fn in clone) return clone[fn as keyof CloneArgs]
    switch (fn) {
      case "balanceOf":
        return this.balanceOf(args[0] as Address, target as Address)
      case "decimals":
        return this.decimals.get(target) ?? 18
      case "symbol":
        return this.symbols.get(target) ?? ""
      case "getEthBalance":
        return this.balanceOf(args[0] as Address)
      case "getCurrentBlockTimestamp":
        return this.timeOf(this.head)
      case "convertToAssets": {
        const priceAt = this.sharePrices.get(target)!
        return ((args[0] as bigint) * priceAt(block)) / 10n ** BigInt(this.decimals.get(target)!)
      }
      case "implementationFor":
        return state.implementations.get(Number(args[0])) ?? zeroAddress
      case "sipaIntentOf":
        return state.intentOf.get(lower(args[0] as string)) ?? 0
      case "cloneImplementation":
        return (
          state.cloneImplementation.get(lower(args[0] as string)) ??
          this.clones.get(lower(args[0] as string))?.implementation ??
          zeroAddress
        )
      case "rowFor": {
        const row = state.rows.get(`${lower(args[0] as string)}:${Number(args[1])}`)
        if (!row) throw new Reverted("no row")
        return [
          row.portal,
          row.beneficiary ?? zeroAddress,
          row.beneficiaryFee ?? 0n,
          row.sweepTip ?? 0n,
        ]
      }
      case "TX_AMOUNT_CAP": {
        const cap = this.caps.get(target)
        if (cap === undefined) throw new Reverted("no cap")
        return cap
      }
      default:
        throw new Error(`fake L1: ${fn} is not answered`)
    }
  }

  private aggregate(data: Hex): Hex {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data }) as unknown as {
      args: [readonly { target: Address; callData: Hex }[]]
    }
    const result = args[0].map((call) => {
      try {
        return { success: true, returnData: this.answer(call.target, call.callData) }
      } catch (err) {
        if (err instanceof Reverted) return { success: false, returnData: "0x" as Hex }
        throw err
      }
    })
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result })
  }

  private rpcLog(l: Log) {
    return {
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: toHex(l.block),
      blockHash: pad(toHex(l.block), { size: 32 }),
      transactionHash: l.tx,
      transactionIndex: "0x0",
      logIndex: toHex(l.index),
      removed: false,
    }
  }

  private matches(
    l: Log,
    f: { address?: string | string[]; topics?: unknown[]; fromBlock?: string; toBlock?: string },
  ) {
    if (f.fromBlock && l.block < BigInt(f.fromBlock)) return false
    if (f.toBlock && f.toBlock !== "latest" && l.block > BigInt(f.toBlock)) return false
    if (f.address && ![f.address].flat().some((a) => lower(a) === lower(l.address))) return false
    return (f.topics ?? []).every(
      (topic, i) =>
        topic == null ||
        [topic].flat().some((t) => lower(t as string) === lower(l.topics[i] ?? "")),
    )
  }

  private async request({
    method,
    params,
  }: {
    method: string
    params?: unknown
  }): Promise<unknown> {
    const list = (params ?? []) as unknown[]
    const first = list[0] as { to?: Address; data?: Hex } & Record<string, unknown>
    const call: L1Call = { method }
    if (method === "eth_call") {
      call.to = lower(first.to!)
      const abi = this.abis.get(call.to)
      call.fn = abi ? decodeFunctionData({ abi, data: first.data! }).functionName : undefined
      if (typeof list[1] === "string" && list[1].startsWith("0x")) call.block = BigInt(list[1])
    }
    if (method === "eth_getLogs")
      call.range = [BigInt(first.fromBlock as Hex), BigInt(first.toBlock as Hex)]
    this.calls.push(call)
    await this.before(call)
    if (this.failing({ ...call, params })) throw new Error(`fake L1: ${method} failed`)
    switch (method) {
      case "eth_chainId":
        return "0x1"
      case "eth_blockNumber":
        return toHex(this.head)
      case "eth_getLogs":
        return this.logs.filter((l) => this.matches(l, first as never)).map((l) => this.rpcLog(l))
      case "eth_call":
        try {
          return call.to === MULTICALL3 && call.fn === "aggregate3"
            ? this.aggregate(first.data!)
            : this.answer(first.to!, first.data!, call.block)
        } catch (err) {
          if (err instanceof Reverted) throw Object.assign(new Error("execution reverted"), err)
          throw err
        }
      case "eth_getBalance":
        return toHex(this.balanceOf(first as unknown as Address))
      case "eth_getBlockByNumber": {
        const block = list[0] === "latest" ? this.head : BigInt(list[0] as Hex)
        return {
          number: toHex(block),
          hash: pad(toHex(block), { size: 32 }),
          parentHash: pad("0x0", { size: 32 }),
          timestamp: toHex(this.timeOf(block)),
          transactions: [],
          logsBloom: null,
        }
      }
      case "eth_getTransactionReceipt": {
        const tx = lower(list[0] as string)
        const logs = this.logs.filter((l) => l.tx === tx)
        if (logs.length === 0) return null
        return {
          transactionHash: tx,
          blockNumber: toHex(logs[0]!.block),
          blockHash: pad(toHex(logs[0]!.block), { size: 32 }),
          logs: logs.map((l) => this.rpcLog(l)),
          status: "0x1",
          from: RELAYER,
          to: logs[0]!.address,
          transactionIndex: "0x0",
          cumulativeGasUsed: "0x0",
          gasUsed: "0x0",
          effectiveGasPrice: "0x0",
          logsBloom: "0x",
          type: "0x2",
        }
      }
      default:
        throw new Error(`fake L1: ${method} is not answered`)
    }
  }
}
