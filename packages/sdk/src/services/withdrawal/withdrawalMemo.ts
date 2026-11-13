/**
 * The memo a wallet withdrawal carries in its recovery data (oxide's `WithdrawOperation.recoveryMemo`), encrypted to
 * the owner. The recovery data names the L1 address the burn pays, but for a swap, a Sky savings move or a bridge-out
 * that is an escrow, so the memo carries what the escrow address commits to. A vault move's burn pays the
 * `MultiStepExecutor`, so its memo carries only the nonce its claim and recovery secrets derive from. A fresh device
 * then rebuilds the record, and with it the escrow's run and recovery, from chain alone. A direct withdrawal carries
 * an empty memo.
 *
 *   byte 0      format version (0x01)
 *   then        [type: u8][len: u8][value: len bytes] entries —
 *               0x01 swap route (1 byte, the escrow's `SwapRoute` id), 0x02 swap recipient (20 bytes),
 *               0x03 escrow factory (20 bytes), 0x04 recovery commitment (32 bytes), 0x05 escrow relayer tip,
 *               0x06 escrow nonce (32 bytes), 0x07 swap daiForGas, 0x08 swap minEthForGas, 0x09 Sky route
 *               (1 byte, the escrow's `SkyRoute`), 0x0a Sky recipient commitment (32 bytes), 0x0b bridge
 *               provider (1 byte, 1 = Across), 0x0c destination chain id, 0x0d bridge output token (1 byte,
 *               1 = USDC, 2 = USDT), 0x0e bridge fee, 0x0f bridge min received, 0x10 vault move nonce
 *               (32 bytes). A bridge-out's recipient
 *               is 0x02. Amounts and the chain id are uint256 in their fewest big-endian bytes; the gas
 *               entries are written only when nonzero.
 *
 * Decoding is total: any input yields a (possibly empty) memo, never a throw. A memo is reported only when its kind
 * entry (0x01, 0x09, 0x0b or 0x10) is the only one and every entry it needs is present and well-formed. The values
 * are what the wallet asserted at burn time; `withdrawEventSource.ts` checks an escrow's against the escrow the burn
 * paid, and `moveBurns.ts` a vault move's against the route the burn ran, before a reader trusts them.
 */

import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from "viem"
import { SkyRoute, predictSkyEscrowAddressLocally } from "@oxide/experiments/sky/sky_savings.js"
import type { SwapEscrowOutput } from "@obsidion/core/types"
import {
  acrossBridgeEscrowArgs,
  predictAcrossBridgeEscrowAddressLocally,
  type BridgeOutToken,
} from "../../oxide/escrow/acrossBridgeOnWithdraw.js"
import {
  predictSwapEscrow,
  swapOutputForRoute,
  swapRouteForOutput,
} from "../../oxide/escrow/swapOnWithdraw.js"

const VERSION = 0x01
const TYPE_SWAP_ROUTE = 0x01
const TYPE_SWAP_RECIPIENT = 0x02
const TYPE_ESCROW_FACTORY = 0x03
const TYPE_RECOVERY_COMMITMENT = 0x04
const TYPE_RELAYER_TIP = 0x05
const TYPE_ESCROW_NONCE = 0x06
const TYPE_DAI_FOR_GAS = 0x07
const TYPE_MIN_ETH_FOR_GAS = 0x08
const TYPE_SKY_ROUTE = 0x09
const TYPE_RECIPIENT_COMMITMENT = 0x0a
const TYPE_BRIDGE_PROVIDER = 0x0b
const TYPE_BRIDGE_CHAIN = 0x0c
const TYPE_BRIDGE_TOKEN = 0x0d
const TYPE_BRIDGE_FEE = 0x0e
const TYPE_BRIDGE_MIN_RECEIVED = 0x0f
const TYPE_VAULT_MOVE_NONCE = 0x10

/** Every entry's type byte, as the format above lists them. */
export const WITHDRAWAL_MEMO_TAGS = {
  swapRoute: TYPE_SWAP_ROUTE,
  swapRecipient: TYPE_SWAP_RECIPIENT,
  escrowFactory: TYPE_ESCROW_FACTORY,
  recoveryCommitment: TYPE_RECOVERY_COMMITMENT,
  relayerTip: TYPE_RELAYER_TIP,
  escrowNonce: TYPE_ESCROW_NONCE,
  daiForGas: TYPE_DAI_FOR_GAS,
  minEthForGas: TYPE_MIN_ETH_FOR_GAS,
  skyRoute: TYPE_SKY_ROUTE,
  recipientCommitment: TYPE_RECIPIENT_COMMITMENT,
  bridgeProvider: TYPE_BRIDGE_PROVIDER,
  bridgeChain: TYPE_BRIDGE_CHAIN,
  bridgeToken: TYPE_BRIDGE_TOKEN,
  bridgeFee: TYPE_BRIDGE_FEE,
  bridgeMinReceived: TYPE_BRIDGE_MIN_RECEIVED,
  vaultMoveNonce: TYPE_VAULT_MOVE_NONCE,
} as const

const BRIDGE_PROVIDERS = { across: 1 } as const satisfies Record<BridgeOutProviderId, number>
const BRIDGE_TOKENS = { USDC: 1, USDT: 2 } as const satisfies Record<BridgeOutToken, number>

const ADDRESS_LEN = 20
const WORD_LEN = 32
const ZERO_ADDRESS = `0x${"00".repeat(ADDRESS_LEN)}`

/** What a swap-on-withdraw's escrow address commits to. */
export interface SwapWithdrawalMemo {
  output: SwapEscrowOutput
  /** Where the swap output lands. */
  recipient: Address
  /** The `SwapEscrowFactory` the escrow address was derived from. */
  factory: Address
  recoveryCommitment: Hex
  relayerTip: bigint
  nonce: Hex
  /** DAI the escrow swaps to ETH for `recipient`. */
  daiForGas: bigint
  /** The least ETH the gas swap must pay. */
  minEthForGas: bigint
}

/** What a Sky savings move's escrow address commits to. */
export interface SkyWithdrawalMemo {
  route: SkyRoute
  /** The `SkyEscrowFactory` the escrow address was derived from. */
  factory: Address
  /** The secret hash of the deposit the escrow makes; the move's nonce derives its salt. */
  recipientCommitment: Hex
  recoveryCommitment: Hex
  relayerTip: bigint
  nonce: Hex
}

/** Who carries a bridge-out to its chain. */
export type BridgeOutProviderId = "across"

/** What a bridge-out's escrow address commits to. */
export interface BridgeWithdrawalMemo {
  provider: BridgeOutProviderId
  chainId: number
  token: BridgeOutToken
  /** Where the bridge lands the output on `chainId`. */
  recipient: Address
  /** The escrow factory the escrow address was derived from. */
  factory: Address
  /** Bridge input-token units the escrow keeps back for the bridge. */
  fee: bigint
  /** Output-token units the recipient receives at the swap floor. */
  minReceived: bigint
  recoveryCommitment: Hex
  relayerTip: bigint
  nonce: Hex
}

/** A vault move's: its claim and recovery secrets derive from `nonce`. */
export interface VaultMoveWithdrawalMemo {
  nonce: Hex
}

/** The escrow a burn pays, as the send names it. */
export type EscrowMemo =
  | { swap: SwapWithdrawalMemo }
  | { sky: SkyWithdrawalMemo }
  | { bridge: BridgeWithdrawalMemo }

/** What a burn's memo names: one escrow, or one vault move. */
export type BurnMemo = EscrowMemo | { vaultMove: VaultMoveWithdrawalMemo }

/** A decoded memo: at most one escrow or vault move. */
export interface WithdrawalMemo {
  swap?: SwapWithdrawalMemo
  sky?: SkyWithdrawalMemo
  bridge?: BridgeWithdrawalMemo
  vaultMove?: VaultMoveWithdrawalMemo
}

export function encodeWithdrawalMemo(memo: BurnMemo): Buffer {
  const entries: Buffer[] = []
  const put = (type: number, value: Buffer) => {
    entries.push(Buffer.from([type, value.length]), value)
  }
  if ("swap" in memo) {
    const { swap } = memo
    put(TYPE_SWAP_ROUTE, Buffer.from([swapRouteForOutput(swap.output)]))
    put(TYPE_SWAP_RECIPIENT, addressBytes(swap.recipient, "recipient"))
    put(TYPE_ESCROW_FACTORY, addressBytes(swap.factory, "factory"))
    put(TYPE_RECOVERY_COMMITMENT, hexBytes(swap.recoveryCommitment, WORD_LEN, "recoveryCommitment"))
    put(TYPE_RELAYER_TIP, uintBytes(swap.relayerTip))
    put(TYPE_ESCROW_NONCE, hexBytes(swap.nonce, WORD_LEN, "nonce"))
    if (swap.daiForGas > 0n) put(TYPE_DAI_FOR_GAS, uintBytes(swap.daiForGas))
    if (swap.minEthForGas > 0n) put(TYPE_MIN_ETH_FOR_GAS, uintBytes(swap.minEthForGas))
  }
  if ("sky" in memo) {
    const { sky } = memo
    if (!isSkyRoute(sky.route))
      throw new Error(`withdrawal memo Sky route is unknown: ${sky.route}`)
    put(TYPE_SKY_ROUTE, Buffer.from([sky.route]))
    put(TYPE_ESCROW_FACTORY, addressBytes(sky.factory, "factory"))
    put(
      TYPE_RECIPIENT_COMMITMENT,
      hexBytes(sky.recipientCommitment, WORD_LEN, "recipientCommitment"),
    )
    put(TYPE_RECOVERY_COMMITMENT, hexBytes(sky.recoveryCommitment, WORD_LEN, "recoveryCommitment"))
    put(TYPE_RELAYER_TIP, uintBytes(sky.relayerTip))
    put(TYPE_ESCROW_NONCE, hexBytes(sky.nonce, WORD_LEN, "nonce"))
  }
  if ("bridge" in memo) {
    const { bridge } = memo
    put(TYPE_BRIDGE_PROVIDER, Buffer.from([BRIDGE_PROVIDERS[bridge.provider]]))
    put(TYPE_BRIDGE_CHAIN, uintBytes(BigInt(bridge.chainId)))
    put(TYPE_BRIDGE_TOKEN, Buffer.from([BRIDGE_TOKENS[bridge.token]]))
    put(TYPE_SWAP_RECIPIENT, addressBytes(bridge.recipient, "recipient"))
    put(TYPE_ESCROW_FACTORY, addressBytes(bridge.factory, "factory"))
    put(TYPE_BRIDGE_FEE, uintBytes(bridge.fee))
    put(TYPE_BRIDGE_MIN_RECEIVED, uintBytes(bridge.minReceived))
    put(
      TYPE_RECOVERY_COMMITMENT,
      hexBytes(bridge.recoveryCommitment, WORD_LEN, "recoveryCommitment"),
    )
    put(TYPE_RELAYER_TIP, uintBytes(bridge.relayerTip))
    put(TYPE_ESCROW_NONCE, hexBytes(bridge.nonce, WORD_LEN, "nonce"))
  }
  if ("vaultMove" in memo) {
    put(TYPE_VAULT_MOVE_NONCE, hexBytes(memo.vaultMove.nonce, WORD_LEN, "vault move nonce"))
  }
  return Buffer.concat([Buffer.from([VERSION]), ...entries])
}

/** The kind entries of an escrow's memo. */
const ESCROW_KIND_TYPES = [TYPE_SWAP_ROUTE, TYPE_SKY_ROUTE, TYPE_BRIDGE_PROVIDER]

/**
 * A wrong version, a truncated entry, a duplicate (the first wins) or a malformed value never throws. A swap missing
 * an entry, naming the zero address or a zero recovery commitment, or naming a route no output maps to decodes as no
 * swap. A Sky move and a bridge-out likewise, and two kind entries decode as nothing. A vault move nonce decodes only
 * as 32 bytes with no other kind entry, well formed or not.
 */
export function decodeWithdrawalMemo(memo: Buffer): WithdrawalMemo {
  if (memo[0] !== VERSION) return {}
  const values = new Map<number, Buffer>()
  for (let pos = 1; pos + 2 <= memo.length; ) {
    const type = memo[pos]!
    const end = pos + 2 + memo[pos + 1]!
    if (end > memo.length) break
    if (!values.has(type)) values.set(type, memo.subarray(pos + 2, end))
    pos = end
  }
  const value = (type: number, len?: number) => {
    const bytes = values.get(type)
    return bytes && (len === undefined || bytes.length === len) ? bytes : undefined
  }
  const uint = (type: number) => {
    const bytes = value(type)
    return bytes && bytes.length >= 1 && bytes.length <= WORD_LEN
      ? BigInt(`0x${bytes.toString("hex")}`)
      : undefined
  }
  const route = value(TYPE_SWAP_ROUTE, 1)
  const factory = nonZeroAddress(value(TYPE_ESCROW_FACTORY, ADDRESS_LEN))
  const recoveryCommitment = nonZeroHex(value(TYPE_RECOVERY_COMMITMENT, WORD_LEN))
  const relayerTip = uint(TYPE_RELAYER_TIP)
  const nonceBytes = value(TYPE_ESCROW_NONCE, WORD_LEN)
  const nonce = nonceBytes && (`0x${nonceBytes.toString("hex")}` as Hex)
  const escrow =
    factory && recoveryCommitment && relayerTip !== undefined && nonce
      ? { factory, recoveryCommitment, relayerTip, nonce }
      : undefined
  const skyRoute = value(TYPE_SKY_ROUTE, 1)?.[0]
  const provider = value(TYPE_BRIDGE_PROVIDER, 1)?.[0]
  const moveNonce = values.get(TYPE_VAULT_MOVE_NONCE)
  if (moveNonce) {
    const alone = ESCROW_KIND_TYPES.every((type) => !values.has(type))
    return alone && moveNonce.length === WORD_LEN
      ? { vaultMove: { nonce: `0x${moveNonce.toString("hex")}` } }
      : {}
  }
  const kinds = [route, skyRoute, provider].filter((kind) => kind !== undefined)
  if (kinds.length !== 1 || !escrow) return {}
  const recipient = nonZeroAddress(value(TYPE_SWAP_RECIPIENT, ADDRESS_LEN))
  if (route) {
    const output = swapOutputForRoute(route[0]!)
    if (!output || !recipient) return {}
    const daiForGas = uint(TYPE_DAI_FOR_GAS) ?? 0n
    const minEthForGas = uint(TYPE_MIN_ETH_FOR_GAS) ?? 0n
    return { swap: { output, recipient, ...escrow, daiForGas, minEthForGas } }
  }
  if (skyRoute !== undefined) {
    const recipientCommitment = nonZeroHex(value(TYPE_RECIPIENT_COMMITMENT, WORD_LEN))
    if (!isSkyRoute(skyRoute) || !recipientCommitment) return {}
    return { sky: { route: skyRoute, recipientCommitment, ...escrow } }
  }
  const bridgeProvider = keyOf(BRIDGE_PROVIDERS, provider)
  const token = keyOf(BRIDGE_TOKENS, value(TYPE_BRIDGE_TOKEN, 1)?.[0])
  const chainId = uint(TYPE_BRIDGE_CHAIN)
  const fee = uint(TYPE_BRIDGE_FEE)
  const minReceived = uint(TYPE_BRIDGE_MIN_RECEIVED)
  if (
    !bridgeProvider ||
    !token ||
    !recipient ||
    !chainId ||
    chainId > BigInt(Number.MAX_SAFE_INTEGER) ||
    fee === undefined ||
    minReceived === undefined
  ) {
    return {}
  }
  return {
    bridge: {
      provider: bridgeProvider,
      chainId: Number(chainId),
      token,
      recipient,
      fee,
      minReceived,
      ...escrow,
    },
  }
}

/**
 * Whether `memo`'s args derive `escrow` from its factory: the memo is what the wallet asserted at
 * burn time, and only args the burn actually paid into are worth acting on.
 */
export function memoDerivesEscrow(memo: EscrowMemo, escrow: Address): boolean {
  const predicted = predictMemoEscrow(memo)
  return predicted !== undefined && isAddressEqual(predicted, escrow)
}

function predictMemoEscrow(memo: EscrowMemo): Address | undefined {
  if ("swap" in memo) {
    const { output, factory, ...args } = memo.swap
    return predictSwapEscrow(factory, {
      layout: "v2",
      args: { ...args, route: swapRouteForOutput(output) },
    })
  }
  if ("sky" in memo) return predictSkyEscrowAddressLocally(memo.sky.factory, memo.sky)
  const { bridge } = memo
  const args = acrossBridgeEscrowArgs(bridge.token, bridge.chainId, {
    ...bridge,
    acrossFee: bridge.fee,
  })
  return args && predictAcrossBridgeEscrowAddressLocally(bridge.factory, args)
}

function keyOf<K extends string>(ids: Record<K, number>, id: number | undefined): K | undefined {
  return (Object.keys(ids) as K[]).find((key) => ids[key] === id)
}

function isSkyRoute(route: number): route is SkyRoute {
  return route === SkyRoute.Stake || route === SkyRoute.Unstake
}

function nonZeroAddress(bytes: Buffer | undefined): Address | undefined {
  if (!bytes) return undefined
  const hex = `0x${bytes.toString("hex")}`
  return hex === ZERO_ADDRESS ? undefined : getAddress(hex)
}

function nonZeroHex(bytes: Buffer | undefined): Hex | undefined {
  return bytes?.some((byte) => byte !== 0) ? `0x${bytes.toString("hex")}` : undefined
}

function addressBytes(address: string, what: string): Buffer {
  if (!isAddress(address)) throw new Error(`withdrawal memo ${what} is not an address: ${address}`)
  return Buffer.from(address.slice(2), "hex")
}

/** `value` in its fewest big-endian bytes, at least one. */
function uintBytes(value: bigint): Buffer {
  if (value < 0n || value >= 1n << 256n)
    throw new Error(`withdrawal memo uint256 out of range: ${value}`)
  const hex = value.toString(16)
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex")
}

function hexBytes(hex: string, len: number, what: string): Buffer {
  if (!new RegExp(`^0x[0-9a-fA-F]{${len * 2}}$`).test(hex)) {
    throw new Error(`withdrawal memo ${what} must be ${len}-byte 0x-hex: ${hex}`)
  }
  return Buffer.from(hex.slice(2), "hex")
}
