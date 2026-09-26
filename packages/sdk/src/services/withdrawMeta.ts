/**
 * The oxide token's `withdraw` carries a 7-Field `meta` passthrough that lands unparsed in the
 * withdrawer's private `Withdraw` event. The event names the executor and the amount but not the
 * L1 address the executor pays, so this stream carries that address. For a swap-on-withdraw it
 * also carries the values the escrow address commits to, so a fresh device rebuilds the record,
 * and with it the self-run swap and the recovery, from chain alone.
 *
 * Same layout as `transferMeta.ts`: one flat 217-byte TLV stream, 31 bytes per field —
 *
 *   byte 0      format version (0x01)
 *   then        [type: u8][len: u8][value: len bytes] entries —
 *               0x01 swap route (1 byte, the escrow's `SwapRoute` id), 0x02 swap recipient
 *               (20 bytes), 0x03 escrow factory (20 bytes), 0x04 recovery commitment (32 bytes),
 *               0x05 relayer tip (32 bytes, uint256 big-endian), 0x06 escrow nonce (32 bytes),
 *               0x07 recipient the executor pays (20 bytes; the escrow on a swap)
 *   then        0x00 terminator, zero fill
 *
 * Decoding is total — any input yields a (possibly empty) WithdrawMeta, never a throw — and a swap
 * is reported only when all six of its entries are present and well-formed. The values are what
 * the wallet asserted at burn time; `withdrawEventSource.ts` checks them against the escrow the
 * burn actually paid before a reader trusts them.
 */

import type { Fr } from "@aztec/aztec.js/fields"
import type { FieldLike } from "@aztec/aztec.js/abi"
import { getAddress, isAddress, type Address, type Hex } from "viem"
import { WITHDRAW_META_LEN } from "@obsidion/core/constants"
import { swapOutputForRoute, swapRouteForOutput } from "../oxide/swapOnWithdraw.js"
import type { SwapOnWithdrawOutput } from "@obsidion/core/types"
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

const ADDRESS_LEN = 20
const WORD_LEN = 32
const ZERO_ADDRESS = `0x${"00".repeat(ADDRESS_LEN)}`

/** What a swap-on-withdraw's escrow address commits to, beside the escrow itself. */
export interface SwapWithdrawMeta {
  output: SwapOnWithdrawOutput
  /** Where the swap output lands. */
  recipient: Address
  /** The `SwapEscrowFactory` the escrow address was derived from. */
  factory: Address
  recoveryCommitment: Hex
  relayerTip: bigint
  nonce: Hex
}

export interface WithdrawMeta {
  /** The L1 address the executor pays: the recipient, or the escrow on a swap. */
  recipient?: Address
  swap?: SwapWithdrawMeta
}

export function buildWithdrawMeta(input: WithdrawMeta): Fr[] {
  const buf = Buffer.alloc(META_CAPACITY)
  buf[0] = TLV_VERSION
  let pos = 1
  const put = (type: number, value: Buffer) => {
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
  }
  if (input.recipient) put(TYPE_RECIPIENT, addressBytes(input.recipient, "recipient"))
  return packMetaFields(buf, WITHDRAW_META_LEN)
}

/**
 * Total decode: a wrong version, a truncated or overrunning entry, a duplicate (first wins), or a
 * malformed value never throws. A swap missing any entry, naming the zero address or a zero
 * recovery commitment, or naming a route no output maps to decodes as no swap.
 */
export function decodeWithdrawMeta(meta: readonly FieldLike[] | undefined): WithdrawMeta {
  const buf = unpackMetaFields(meta, WITHDRAW_META_LEN)
  if (!buf || buf[0] !== TLV_VERSION) return {}

  const swap: Partial<SwapWithdrawMeta> = {}
  let recipient: Address | undefined
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
      swap.recoveryCommitment = nonZeroWord(value)
    } else if (type === TYPE_RELAYER_TIP && swap.relayerTip === undefined && len === WORD_LEN) {
      swap.relayerTip = BigInt(`0x${value.toString("hex")}`)
    } else if (type === TYPE_ESCROW_NONCE && swap.nonce === undefined && len === WORD_LEN) {
      swap.nonce = `0x${value.toString("hex")}`
    } else if (type === TYPE_RECIPIENT && recipient === undefined && len === ADDRESS_LEN) {
      recipient = nonZeroAddress(value)
    }
    pos = end
  }
  return {
    ...(recipient ? { recipient } : {}),
    ...(isSwapMeta(swap) ? { swap } : {}),
  }
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

function nonZeroWord(bytes: Buffer): Hex | undefined {
  return bytes.some((byte) => byte !== 0) ? `0x${bytes.toString("hex")}` : undefined
}

function addressBytes(address: string, what: string): Buffer {
  if (!isAddress(address)) throw new Error(`withdraw meta ${what} is not an address: ${address}`)
  return Buffer.from(address.slice(2), "hex")
}

function wordBytes(value: bigint): Buffer {
  if (value < 0n || value >= 1n << 256n) throw new Error(`withdraw meta tip out of range: ${value}`)
  return Buffer.from(value.toString(16).padStart(WORD_LEN * 2, "0"), "hex")
}

function hexBytes(hex: string, len: number, what: string): Buffer {
  if (!new RegExp(`^0x[0-9a-fA-F]{${len * 2}}$`).test(hex)) {
    throw new Error(`withdraw meta ${what} must be ${len}-byte 0x-hex: ${hex}`)
  }
  return Buffer.from(hex.slice(2), "hex")
}
