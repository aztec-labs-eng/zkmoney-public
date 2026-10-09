/**
 * The oxide token's `withdraw` carries a 7-Field `meta` passthrough that lands unparsed in the
 * withdrawer's private `Withdraw` event. The event names the executor and the amount but not the
 * L1 address the executor pays, so this stream carries that address. For a swap-on-withdraw or a
 * Sky savings move it also carries the values the escrow address commits to, so a fresh device
 * rebuilds the record, and with it the escrow's run and recovery, from chain alone.
 *
 * Same layout as `transferMeta.ts`: one flat 217-byte TLV stream, 31 bytes per field —
 *
 *   byte 0      format version (0x01)
 *   then        [type: u8][len: u8][value: len bytes] entries —
 *               0x01 swap route (1 byte, the escrow's `SwapRoute` id), 0x02 swap recipient
 *               (20 bytes), 0x03 escrow factory (20 bytes), 0x04 recovery commitment (32 bytes),
 *               0x05 relayer tip (32 bytes, uint256 big-endian), 0x06 escrow nonce (32 bytes),
 *               0x07 recipient the executor pays (20 bytes; the escrow on a swap or a Sky move),
 *               0x08 group id (16 bytes), 0x09 group leg (1 byte: 0x01 gas, 0x02 funds),
 *               0x0a Sky route (1 byte, the escrow's `SkyRoute`), 0x0b Sky recipient
 *               commitment (32 bytes), 0x0c swap daiForGas, 0x0d swap minEthForGas (1-32 bytes,
 *               uint256 big-endian, written only when nonzero)
 *   then        0x00 terminator, zero fill
 *
 * The group entries label the two burns of a fresh-address withdrawal so a rescan pairs them.
 * A swap burn with a group uses 193 of the 217 bytes, one with both gas entries at most 194 (each
 * fits 9 bytes, since `daiForGas` is at most 50 DAI), and a Sky burn 184.
 *
 * Decoding is total — any input yields a (possibly empty) WithdrawMeta, never a throw — and a swap
 * or Sky move is reported only when all six of its required entries are present and well-formed, a
 * group only when both of its entries are. The values are what the wallet asserted at burn time;
 * `withdrawEventSource.ts` checks them against the escrow the burn actually paid before a reader
 * trusts them.
 */

import type { Fr } from "@aztec/aztec.js/fields"
import type { FieldLike } from "@aztec/aztec.js/abi"
import { getAddress, isAddress, type Address, type Hex } from "viem"
import { SkyRoute } from "@oxide/experiments/sky/sky_savings.js"
import { WITHDRAW_META_LEN } from "@obsidion/core/constants"
import { swapOutputForRoute, swapRouteForOutput } from "../oxide/swapOnWithdraw.js"
import type { SwapEscrowOutput, WithdrawalGroupLeg } from "@obsidion/core/types"
import { metaCapacity, packMetaFields, unpackMetaFields } from "./metaFields.js"

const META_CAPACITY = metaCapacity(WITHDRAW_META_LEN)

const TLV_VERSION = 0x01
const TYPE_END = 0x00
const TYPE_SWAP_ROUTE = 0x01
const TYPE_SWAP_RECIPIENT = 0x02
const TYPE_ESCROW_FACTORY = 0x03
const TYPE_RECOVERY_COMMITMENT = 0x04
const TYPE_RELAYER_TIP = 0x05
const TYPE_ESCROW_NONCE = 0x06
const TYPE_RECIPIENT = 0x07
const TYPE_GROUP_ID = 0x08
const TYPE_GROUP_LEG = 0x09
const TYPE_SKY_ROUTE = 0x0a
const TYPE_RECIPIENT_COMMITMENT = 0x0b
const TYPE_DAI_FOR_GAS = 0x0c
const TYPE_MIN_ETH_FOR_GAS = 0x0d

const ADDRESS_LEN = 20
const WORD_LEN = 32
const GROUP_ID_LEN = 16
const ZERO_ADDRESS = `0x${"00".repeat(ADDRESS_LEN)}`
/** Leg byte = index + 1, so the zero fill never reads as a leg. */
const GROUP_LEGS: readonly WithdrawalGroupLeg[] = ["gas", "funds"]

/** What a swap-on-withdraw's escrow address commits to, beside the escrow itself. */
export interface SwapWithdrawMeta {
  output: SwapEscrowOutput
  /** Where the swap output lands. */
  recipient: Address
  /** The `SwapEscrowFactory` the escrow address was derived from. */
  factory: Address
  recoveryCommitment: Hex
  relayerTip: bigint
  nonce: Hex
  /** DAI the escrow swaps to ETH for `recipient`. 0 when the meta has no entry. */
  daiForGas: bigint
  /** The least ETH the gas swap must pay. 0 when the meta has no entry. */
  minEthForGas: bigint
}

/** What a Sky savings move's escrow address commits to, beside the escrow itself. */
export interface SkyWithdrawMeta {
  route: SkyRoute
  /** The `SkyEscrowFactory` the escrow address was derived from. */
  factory: Address
  /** The secret hash of the deposit the escrow makes; the move's nonce derives its salt. */
  recipientCommitment: Hex
  recoveryCommitment: Hex
  relayerTip: bigint
  nonce: Hex
}

/** The fresh-address withdrawal a burn belongs to, and which of its two legs it is. */
export interface WithdrawGroupMeta {
  /** 16 random bytes as 0x-hex, shared by both legs. */
  id: Hex
  leg: WithdrawalGroupLeg
}

export interface WithdrawMeta {
  /** The L1 address the executor pays: the recipient, or the escrow on a swap or a Sky move. */
  recipient?: Address
  swap?: SwapWithdrawMeta
  sky?: SkyWithdrawMeta
  group?: WithdrawGroupMeta
}

export function buildWithdrawMeta(input: WithdrawMeta): Fr[] {
  const buf = Buffer.alloc(META_CAPACITY)
  buf[0] = TLV_VERSION
  let pos = 1
  const put = (type: number, value: Buffer) => {
    if (pos + 2 + value.length > META_CAPACITY)
      throw new Error("withdraw meta overflows its fields")
    buf[pos] = type
    buf[pos + 1] = value.length
    value.copy(buf, pos + 2)
    pos += 2 + value.length
  }
  if (input.swap) {
    const { swap } = input
    put(TYPE_SWAP_ROUTE, Buffer.from([swapRouteForOutput(swap.output)]))
    put(TYPE_SWAP_RECIPIENT, addressBytes(swap.recipient, "recipient"))
    put(TYPE_ESCROW_FACTORY, addressBytes(swap.factory, "factory"))
    put(TYPE_RECOVERY_COMMITMENT, hexBytes(swap.recoveryCommitment, WORD_LEN, "recoveryCommitment"))
    put(TYPE_RELAYER_TIP, wordBytes(swap.relayerTip))
    put(TYPE_ESCROW_NONCE, hexBytes(swap.nonce, WORD_LEN, "nonce"))
    if (swap.daiForGas > 0n) put(TYPE_DAI_FOR_GAS, uintBytes(swap.daiForGas))
    if (swap.minEthForGas > 0n) put(TYPE_MIN_ETH_FOR_GAS, uintBytes(swap.minEthForGas))
  }
  if (input.sky) {
    const { sky } = input
    if (!isSkyRoute(sky.route)) throw new Error(`withdraw meta Sky route is unknown: ${sky.route}`)
    put(TYPE_SKY_ROUTE, Buffer.from([sky.route]))
    put(TYPE_ESCROW_FACTORY, addressBytes(sky.factory, "factory"))
    put(
      TYPE_RECIPIENT_COMMITMENT,
      hexBytes(sky.recipientCommitment, WORD_LEN, "recipientCommitment"),
    )
    put(TYPE_RECOVERY_COMMITMENT, hexBytes(sky.recoveryCommitment, WORD_LEN, "recoveryCommitment"))
    put(TYPE_RELAYER_TIP, wordBytes(sky.relayerTip))
    put(TYPE_ESCROW_NONCE, hexBytes(sky.nonce, WORD_LEN, "nonce"))
  }
  if (input.group) {
    put(TYPE_GROUP_ID, hexBytes(input.group.id, GROUP_ID_LEN, "group id"))
    put(TYPE_GROUP_LEG, Buffer.from([groupLegByte(input.group.leg)]))
  }
  if (input.recipient) put(TYPE_RECIPIENT, addressBytes(input.recipient, "recipient"))
  return packMetaFields(buf, WITHDRAW_META_LEN)
}

/**
 * Total decode: a wrong version, a truncated or overrunning entry, a duplicate (first wins), or a
 * malformed value never throws. A swap missing any entry, naming the zero address or a zero
 * recovery commitment, or naming a route no output maps to decodes as no swap, and a Sky move
 * likewise, or beside a swap route. A group missing
 * either entry, with a zero id or an unknown leg byte decodes as no group.
 */
export function decodeWithdrawMeta(meta: readonly FieldLike[] | undefined): WithdrawMeta {
  const buf = unpackMetaFields(meta, WITHDRAW_META_LEN)
  if (!buf || buf[0] !== TLV_VERSION) return {}

  // The escrow entries a swap and a Sky move share collect here, with the swap's own.
  const swap: Partial<SwapWithdrawMeta> = {}
  let skyRoute: SkyRoute | undefined
  let recipientCommitment: Hex | undefined
  let daiForGas: bigint | undefined
  let minEthForGas: bigint | undefined
  let recipient: Address | undefined
  let groupId: Hex | undefined
  let groupLeg: WithdrawalGroupLeg | undefined
  let pos = 1
  while (pos + 1 < META_CAPACITY) {
    const type = buf[pos]!
    if (type === TYPE_END) break
    const len = buf[pos + 1]!
    const end = pos + 2 + len
    if (end > META_CAPACITY) break
    const value = buf.subarray(pos + 2, end)
    if (type === TYPE_SWAP_ROUTE && swap.output === undefined && len === 1) {
      swap.output = swapOutputForRoute(value[0]!)
    } else if (
      type === TYPE_SWAP_RECIPIENT &&
      swap.recipient === undefined &&
      len === ADDRESS_LEN
    ) {
      swap.recipient = nonZeroAddress(value)
    } else if (type === TYPE_ESCROW_FACTORY && swap.factory === undefined && len === ADDRESS_LEN) {
      swap.factory = nonZeroAddress(value)
    } else if (
      type === TYPE_RECOVERY_COMMITMENT &&
      swap.recoveryCommitment === undefined &&
      len === WORD_LEN
    ) {
      swap.recoveryCommitment = nonZeroHex(value)
    } else if (type === TYPE_RELAYER_TIP && swap.relayerTip === undefined && len === WORD_LEN) {
      swap.relayerTip = BigInt(`0x${value.toString("hex")}`)
    } else if (type === TYPE_ESCROW_NONCE && swap.nonce === undefined && len === WORD_LEN) {
      swap.nonce = `0x${value.toString("hex")}`
    } else if (type === TYPE_RECIPIENT && recipient === undefined && len === ADDRESS_LEN) {
      recipient = nonZeroAddress(value)
    } else if (type === TYPE_GROUP_ID && groupId === undefined && len === GROUP_ID_LEN) {
      groupId = nonZeroHex(value)
    } else if (type === TYPE_GROUP_LEG && groupLeg === undefined && len === 1) {
      groupLeg = GROUP_LEGS[value[0]! - 1]
    } else if (type === TYPE_SKY_ROUTE && skyRoute === undefined && len === 1) {
      skyRoute = isSkyRoute(value[0]!) ? value[0]! : undefined
    } else if (
      type === TYPE_RECIPIENT_COMMITMENT &&
      recipientCommitment === undefined &&
      len === WORD_LEN
    ) {
      recipientCommitment = nonZeroHex(value)
    } else if (type === TYPE_DAI_FOR_GAS && daiForGas === undefined && isUintLen(len)) {
      daiForGas = BigInt(`0x${value.toString("hex")}`)
    } else if (type === TYPE_MIN_ETH_FOR_GAS && minEthForGas === undefined && isUintLen(len)) {
      minEthForGas = BigInt(`0x${value.toString("hex")}`)
    }
    pos = end
  }
  swap.daiForGas = daiForGas ?? 0n
  swap.minEthForGas = minEthForGas ?? 0n
  const { factory, recoveryCommitment, relayerTip, nonce } = swap
  const sky = {
    route: skyRoute,
    factory,
    recipientCommitment,
    recoveryCommitment,
    relayerTip,
    nonce,
  }
  return {
    ...(recipient ? { recipient } : {}),
    ...(isSwapMeta(swap) ? { swap } : {}),
    ...(swap.output === undefined && isSkyMeta(sky) ? { sky } : {}),
    ...(groupId && groupLeg ? { group: { id: groupId, leg: groupLeg } } : {}),
  }
}

function isSkyRoute(route: number): route is SkyRoute {
  return route === SkyRoute.Stake || route === SkyRoute.Unstake
}

function isSkyMeta(sky: Partial<SkyWithdrawMeta>): sky is SkyWithdrawMeta {
  return (
    sky.route !== undefined &&
    sky.factory !== undefined &&
    sky.recipientCommitment !== undefined &&
    sky.recoveryCommitment !== undefined &&
    sky.relayerTip !== undefined &&
    sky.nonce !== undefined
  )
}

function groupLegByte(leg: WithdrawalGroupLeg): number {
  const index = GROUP_LEGS.indexOf(leg)
  if (index < 0) throw new Error(`withdraw meta group leg is unknown: ${leg}`)
  return index + 1
}

function isSwapMeta(swap: Partial<SwapWithdrawMeta>): swap is SwapWithdrawMeta {
  return (
    swap.output !== undefined &&
    swap.recipient !== undefined &&
    swap.factory !== undefined &&
    swap.recoveryCommitment !== undefined &&
    swap.relayerTip !== undefined &&
    swap.nonce !== undefined
  )
}

function nonZeroAddress(bytes: Buffer): Address | undefined {
  const hex = `0x${bytes.toString("hex")}`
  return hex === ZERO_ADDRESS ? undefined : getAddress(hex)
}

function nonZeroHex(bytes: Buffer): Hex | undefined {
  return bytes.some((byte) => byte !== 0) ? `0x${bytes.toString("hex")}` : undefined
}

function addressBytes(address: string, what: string): Buffer {
  if (!isAddress(address)) throw new Error(`withdraw meta ${what} is not an address: ${address}`)
  return Buffer.from(address.slice(2), "hex")
}

const isUintLen = (len: number) => len >= 1 && len <= WORD_LEN

/** `value` in its fewest big-endian bytes. */
function uintBytes(value: bigint): Buffer {
  const word = wordBytes(value)
  return word.subarray(word.findIndex((byte) => byte !== 0))
}

function wordBytes(value: bigint): Buffer {
  if (value < 0n || value >= 1n << 256n)
    throw new Error(`withdraw meta uint256 out of range: ${value}`)
  return Buffer.from(value.toString(16).padStart(WORD_LEN * 2, "0"), "hex")
}

function hexBytes(hex: string, len: number, what: string): Buffer {
  if (!new RegExp(`^0x[0-9a-fA-F]{${len * 2}}$`).test(hex)) {
    throw new Error(`withdraw meta ${what} must be ${len}-byte 0x-hex: ${hex}`)
  }
  return Buffer.from(hex.slice(2), "hex")
}
