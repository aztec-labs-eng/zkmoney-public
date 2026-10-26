/**
 * The slice of an Ethereum JSON-RPC that an offline demo has to answer: viem's read path
 * (`readContract` / `getCode`), its send path (`sendTransaction` over an injected wallet) and its
 * receipt wait. One handler serves both transports the exit flows use — the injected provider
 * (`fakeEthereum.ts`) and the app's own HTTP client over `config.l1RpcUrl`.
 *
 * Unknown methods log and resolve `null`: a demo must degrade to a blank field, never to a throw.
 */
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { encodeAbiParameters, toFunctionSelector, type Address, type Hex } from "viem"

/** The demo's L1 EOA — connected wallet, transaction sender, recovery destination and tip target. */
export const DEMO_L1_ACCOUNT = "0x7c4a1b9d2ef3a5b60c81de4f72a93b5c6d0e8f14" as Hex

/** What `balanceOf` reports for a deposit address: clears the fee below by enough that both exits'
 *  balance guards pass. */
export const DEMO_SIPA_BALANCE = 2_500_000_000_000_000_000n

/** The forwarding-table deposit row's sweep tip — the relayer's sweep fee, at the deployed figure. */
export const DEMO_DEPOSIT_FEE = 250_000_000_000_000_000n

/** The plain withdrawal executor's `FEE()`, at the deployed figure. */
export const DEMO_WITHDRAWAL_FEE = 100_000_000_000_000_000n

/** Who the plain withdrawal executor pays its fee to. */
export const DEMO_WITHDRAWAL_FEE_BENEFICIARY =
  "0xfee0000000000000000000000000000000000fee" as Address

/** The portal every forwarding-table row names, and the one the withdrawal executor serves. */
export const DEMO_PORTAL = "0xde1100000000000000000000000000000000da01" as Address

/** The portal's `TX_AMOUNT_CAP()`: the most one sweep may deposit. */
export const DEMO_TX_AMOUNT_CAP = 5166n * 10n ** 18n

/** What `SIPAFactory.implementationFor` answers for every intent; only its shape matters here. */
const DEMO_SIPA_IMPLEMENTATION = 0x5117a0000000000000000000000000000000119en

/**
 * The deposit token: the portal's underlying. The mainnet DAI address, so the demo's one row takes the mainnet swap
 * inputs the demo shows.
 */
export const DEMO_L1_TOKEN = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address

/** The TEE registry the portal states; a placeholder nothing dials. */
const DEMO_TEE_REGISTRY = "0x7ee0000000000000000000000000000000007ee0" as Address

/**
 * The rollup identity `OxidePortal` states in the demo. The version is the figure
 * `DEMO_OXIDE_TUPLE.rollupVersion` carries; the addresses are placeholders nothing dials.
 */
const DEMO_ROLLUP_VERSION = 1n
const DEMO_ROLLUP_ADDRESS = "0x2011000000000000000000000000000000000a11" as Address
const DEMO_INBOX_ADDRESS = "0x1b0000000000000000000000000000000000b0c5" as Address

/**
 * How long a submitted transaction stays pending, so a flow's "Waiting for Ethereum confirmation"
 * stage is actually seen. viem re-reads the receipt once per new block, so the wait shows as one
 * block time longer than this.
 */
export const DEMO_RECEIPT_DELAY_MS = 3_000

const BLOCK_NUMBER = 0x1a2b3cn
const GAS_PRICE = 1_500_000_000n

/** viem's receipt poller only re-checks on a block number it has not seen, so the head must move. */
const BLOCK_TIME_MS = 2_000

const SELECTOR = {
  rowFor: toFunctionSelector("rowFor(address,uint8)"),
  withdrawalFee: toFunctionSelector("FEE()"),
  feeBeneficiary: toFunctionSelector("BENEFICIARY()"),
  executorPortal: toFunctionSelector("PORTAL()"),
  txAmountCap: toFunctionSelector("TX_AMOUNT_CAP()"),
  underlying: toFunctionSelector("UNDERLYING()"),
  teeRegistry: toFunctionSelector("TEE_REGISTRY()"),
  name: toFunctionSelector("name()"),
  implementationFor: toFunctionSelector("implementationFor(uint8)"),
  predictSIPA: toFunctionSelector("predictSIPA(address,bytes32,bytes32,uint256,bool,address)"),
  predictLegacySIPA: toFunctionSelector("predictSIPA(address,bytes32,address,uint256,bool)"),
  isWithdrawalSpent: toFunctionSelector("$isWithdrawalSpent(bytes32)"),
  decimals: toFunctionSelector("decimals()"),
  symbol: toFunctionSelector("symbol()"),
  balanceOf: toFunctionSelector("balanceOf(address)"),
  rollupVersion: toFunctionSelector("ROLLUP_VERSION()"),
  rollup: toFunctionSelector("ROLLUP()"),
  inbox: toFunctionSelector("INBOX()"),
}

/** The deposit token's ERC-20 metadata, as the deposit screens read it off L1. */
export const DEMO_TOKEN_DECIMALS = 18
export const DEMO_TOKEN_SYMBOL = WALLET_TOKEN_SYMBOL

/**
 * The picker's non-manifest tokens, at the addresses `MAINNET_TOKENS` lists. Without these every
 * read answers the manifest token's 18 decimals and symbol, and a USDC row reads as DAI.
 */
export const DEMO_L1_TOKENS: Record<string, { decimals: number; symbol: string; balance: bigint }> =
  {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
      decimals: 6,
      symbol: "USDC",
      balance: 4_210_500_000n,
    },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": {
      decimals: 6,
      symbol: "USDT",
      balance: 1_875_250_000n,
    },
  }

/**
 * `recipientCommitment → SIPA address` for the seeded deposits, so `predictSIPA` reproduces each
 * fixture's own address. The self-sweep refuses to deploy anywhere but the predicted address, and
 * the commitment is the only fixture value carried in that call's arguments.
 */
const predictions = new Map<string, Address>()

const commitmentKey = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")

export function registerDemoSipaPrediction(recipientCommitment: string, sipa: Address): void {
  predictions.set(commitmentKey(recipientCommitment), sipa)
}

const quantity = (value: bigint | number): Hex => `0x${value.toString(16)}` as Hex

const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}` as Hex

function randomHex(bytes: number): Hex {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return `0x${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex
}

/**
 * The reads the exits, the deposit screens and the portal identity check make, dispatched on the
 * selector and, for a picker token, on the address it was sent to. An unrecognized one answers the
 * SIPA balance, which is a harmless default for a bare `uint256` and wrong for anything else, so
 * every non-`uint256` return has to be dispatched explicitly.
 */
function contractRead(data?: Hex, to?: string): Hex {
  const selector = data?.slice(0, 10)
  const token = to ? DEMO_L1_TOKENS[to.toLowerCase()] : undefined
  if (token) {
    if (selector === SELECTOR.decimals) return word(BigInt(token.decimals))
    if (selector === SELECTOR.symbol)
      return encodeAbiParameters([{ type: "string" }], [token.symbol])
    if (selector === SELECTOR.balanceOf) return word(token.balance)
  }
  // Every token and intent routes to the one portal, at the deposit tip and no beneficiary fee.
  if (selector === SELECTOR.rowFor) {
    return encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }],
      [DEMO_PORTAL, `0x${"00".repeat(20)}`, 0n, DEMO_DEPOSIT_FEE],
    )
  }
  if (selector === SELECTOR.withdrawalFee) return word(DEMO_WITHDRAWAL_FEE)
  if (selector === SELECTOR.feeBeneficiary) {
    return encodeAbiParameters([{ type: "address" }], [DEMO_WITHDRAWAL_FEE_BENEFICIARY])
  }
  if (selector === SELECTOR.executorPortal) {
    return encodeAbiParameters([{ type: "address" }], [DEMO_PORTAL])
  }
  if (selector === SELECTOR.txAmountCap) return word(DEMO_TX_AMOUNT_CAP)
  // The token immutables read the portal's underlying and TEE registry, and the underlying's name.
  if (selector === SELECTOR.underlying) {
    return encodeAbiParameters([{ type: "address" }], [DEMO_L1_TOKEN])
  }
  if (selector === SELECTOR.teeRegistry) {
    return encodeAbiParameters([{ type: "address" }], [DEMO_TEE_REGISTRY])
  }
  if (selector === SELECTOR.name) {
    return encodeAbiParameters([{ type: "string" }], [DEMO_TOKEN_SYMBOL])
  }
  // The demo serves one implementation for every intent, so the intent argument is not read.
  if (selector === SELECTOR.implementationFor) return word(DEMO_SIPA_IMPLEMENTATION)
  if (selector === SELECTOR.decimals) return word(BigInt(DEMO_TOKEN_DECIMALS))
  // A `string` return is head+tail, not a bare word — the balance default would decode as garbage.
  if (selector === SELECTOR.symbol) {
    return encodeAbiParameters([{ type: "string" }], [DEMO_TOKEN_SYMBOL])
  }
  // No relayer in the demo, so nothing is ever released ahead of the manual finalize. Load-bearing:
  // the balance default would decode as `true` and abort the flow as already released.
  if (selector === SELECTOR.isWithdrawalSpent) return word(0n)
  if (selector === SELECTOR.rollupVersion) return word(DEMO_ROLLUP_VERSION)
  if (selector === SELECTOR.rollup) {
    return encodeAbiParameters([{ type: "address" }], [DEMO_ROLLUP_ADDRESS])
  }
  if (selector === SELECTOR.inbox) {
    return encodeAbiParameters([{ type: "address" }], [DEMO_INBOX_ADDRESS])
  }
  if (selector === SELECTOR.predictSIPA || selector === SELECTOR.predictLegacySIPA) {
    // `intentHash` is the second argument: skip the selector and the `implementation` word.
    const sipa = predictions.get(commitmentKey(data!.slice(74, 138)))
    return word(BigInt(sipa ?? `0x${"00".repeat(20)}`))
  }
  // `balanceOf`, and a harmless default for any other bare-uint256 read.
  return word(DEMO_SIPA_BALANCE)
}

export type RpcHandler = (method: string, params?: readonly unknown[]) => Promise<unknown>

function block(hash: Hex, number: bigint) {
  return {
    number: quantity(number),
    hash,
    parentHash: `0x${"00".repeat(32)}` as Hex,
    timestamp: quantity(BigInt(Math.floor(Date.now() / 1000))),
    baseFeePerGas: quantity(GAS_PRICE),
    gasLimit: quantity(30_000_000),
    gasUsed: quantity(21_000),
    miner: DEMO_L1_ACCOUNT,
    difficulty: "0x0",
    extraData: "0x",
    logsBloom: `0x${"00".repeat(256)}`,
    nonce: "0x0000000000000000",
    receiptsRoot: `0x${"00".repeat(32)}`,
    sha3Uncles: `0x${"00".repeat(32)}`,
    size: "0x0",
    stateRoot: `0x${"00".repeat(32)}`,
    totalDifficulty: "0x0",
    transactions: [],
    transactionsRoot: `0x${"00".repeat(32)}`,
    uncles: [],
  }
}

/**
 * A demo L1 whose every transaction succeeds, `DEMO_RECEIPT_DELAY_MS` after it was sent. Only the
 * transactions this handler minted are held pending — a hash it never saw (a reload mid-flow)
 * resolves at once.
 */
export function createL1RpcHandler(chainId: number): RpcHandler {
  const blockHash = randomHex(32)
  const openedAt = Date.now()
  const sentAt = new Map<string, number>()
  predictions.clear()

  const head = () => BLOCK_NUMBER + BigInt(Math.floor((Date.now() - openedAt) / BLOCK_TIME_MS))

  const isPending = (hash: Hex) => {
    const sent = sentAt.get(hash.toLowerCase())
    return sent !== undefined && Date.now() - sent < DEMO_RECEIPT_DELAY_MS
  }

  const receipt = (hash: Hex) => ({
    blockHash,
    blockNumber: quantity(head()),
    contractAddress: null,
    cumulativeGasUsed: quantity(120_000),
    effectiveGasPrice: quantity(GAS_PRICE),
    from: DEMO_L1_ACCOUNT,
    gasUsed: quantity(96_000),
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    to: DEMO_L1_ACCOUNT,
    transactionHash: hash,
    transactionIndex: "0x0",
    type: "0x2",
  })

  return async (method, params = []) => {
    switch (method) {
      case "eth_chainId":
        return quantity(chainId)
      case "net_version":
        return String(chainId)
      case "eth_accounts":
      case "eth_requestAccounts":
        return [DEMO_L1_ACCOUNT]
      case "wallet_requestPermissions":
        return [{ parentCapability: "eth_accounts" }]
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null
      case "eth_blockNumber":
        return quantity(head())
      case "eth_getBlockByNumber":
      case "eth_getBlockByHash":
        return block(blockHash, head())
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return quantity(GAS_PRICE)
      case "eth_feeHistory":
        return {
          oldestBlock: quantity(BLOCK_NUMBER),
          baseFeePerGas: [quantity(GAS_PRICE), quantity(GAS_PRICE)],
          gasUsedRatio: [0.5],
          reward: [[quantity(GAS_PRICE)]],
        }
      case "eth_estimateGas":
        return quantity(120_000)
      case "eth_getTransactionCount":
        return "0x0"
      // Every SIPA is counterfactual in the demo, so the self-sweep takes the
      // deploy-and-sweep-through-Multicall3 branch.
      case "eth_getCode":
        return "0x"
      case "eth_call": {
        const call = params[0] as { data?: Hex; to?: string } | undefined
        return contractRead(call?.data, call?.to)
      }
      case "eth_sendTransaction":
      case "eth_sendRawTransaction": {
        const hash = randomHex(32)
        sentAt.set(hash, Date.now())
        return hash
      }
      case "eth_getTransactionByHash": {
        const hash = params[0] as Hex
        const pending = isPending(hash)
        return {
          hash,
          blockHash: pending ? null : blockHash,
          blockNumber: pending ? null : quantity(head()),
          transactionIndex: pending ? null : "0x0",
          from: DEMO_L1_ACCOUNT,
          to: DEMO_L1_ACCOUNT,
          gas: quantity(120_000),
          gasPrice: quantity(GAS_PRICE),
          input: "0x",
          nonce: "0x0",
          value: "0x0",
          type: "0x2",
          v: "0x0",
          r: `0x${"00".repeat(32)}`,
          s: `0x${"00".repeat(32)}`,
        }
      }
      case "eth_getTransactionReceipt": {
        const hash = params[0] as Hex
        return isPending(hash) ? null : receipt(hash)
      }
      default:
        console.warn(`[demo] unhandled L1 RPC ${method} — answering null`, params)
        return null
    }
  }
}

interface JsonRpcRequest {
  id?: number | string
  method: string
  params?: readonly unknown[]
}

/**
 * Answer the app's own HTTP L1 client (`l1Transport`) from `handle`, and pass every other request
 * through. Scoped to `rpcUrl` exactly — the demo must not intercept the design-system assets, the
 * dev server's HMR, or anything else the page fetches.
 */
export function installL1RpcStub(rpcUrl: string, handle: RpcHandler): void {
  const passthrough = globalThis.fetch.bind(globalThis)
  // `new URL` adds the trailing slash a bare origin lacks, as the app's client does.
  const target = new URL(rpcUrl).href

  const answer = async (request: JsonRpcRequest) => ({
    jsonrpc: "2.0",
    id: request.id ?? null,
    result: await handle(request.method, request.params),
  })

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    if (new URL(url, location.href).href !== target) return passthrough(input, init)
    const body = JSON.parse(String(init?.body ?? "{}")) as JsonRpcRequest | JsonRpcRequest[]
    // `l1Transport` batches, so a same-tick pair of reads arrives as one array.
    const payload = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
}
