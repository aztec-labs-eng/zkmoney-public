import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/foundation/eth-address"
import { getAddress, type Address, type Hex } from "viem"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { WITHDRAW_META_LEN, emptyWithdrawMeta } from "@obsidion/core/constants"
import { planSwapOnWithdraw } from "../src/oxide/swapOnWithdraw.js"
import {
  buildWithdrawMeta,
  decodeWithdrawMeta,
  type SwapWithdrawMeta,
  type WithdrawGroupMeta,
} from "../src/services/withdrawMeta.js"
import {
  createWithdrawEventSource,
  swapMetaForEscrow,
} from "../src/services/withdrawEventSource.js"
import type { ObsidionWallet } from "../src/obsidion/ObsidionWallet.js"

const CAPACITY = WITHDRAW_META_LEN * 31

/** Test-local mirror of the codec's flatten: 31 bytes per field, big-endian in the low bytes. */
const packRaw = (bytes: Uint8Array): Fr[] => {
  const meta: Fr[] = []
  for (let i = 0; i < WITHDRAW_META_LEN; i++) {
    const chunk = Buffer.from(bytes.subarray(i * 31, (i + 1) * 31))
    meta.push(Fr.fromBuffer(Buffer.concat([Buffer.alloc(1), chunk])))
  }
  return meta
}

const RECIPIENT = getAddress(`0x${"e5".repeat(20)}`)
const RECOVERY = { account: getAddress(`0x${"5a".repeat(20)}`), salt: new Fr(9n) }

const SWAP: SwapWithdrawMeta = {
  output: "USDC",
  recipient: getAddress(`0x${"b0".repeat(20)}`),
  factory: getAddress(`0x${"fa".repeat(20)}`),
  recoveryCommitment: deriveRecoveryCommitment(
    RECOVERY.salt,
    EthAddress.fromString(RECOVERY.account),
  ).toString(),
  relayerTip: 5n * 10n ** 18n,
  nonce: `0x${"77".repeat(32)}` as Hex,
}

const GROUP: WithdrawGroupMeta = { id: `0x${"c1".repeat(16)}` as Hex, leg: "funds" }

const hex = (s: string) => [...Buffer.from(s.slice(2), "hex")]

/** Byte length of the swap entries `buildWithdrawMeta(SWAP)` lays out after the version byte. */
const SWAP_ENTRIES_LEN = 3 + 22 * 2 + 34 * 3
/** Byte length of the group entries: the id (2 + 16) and the leg (2 + 1). */
const GROUP_ENTRIES_LEN = 18 + 3

/** The stream `buildWithdrawMeta(SWAP)` lays out, as raw bytes; `commitment` overrides entry 0x04. */
function swapStream(commitment = hex(SWAP.recoveryCommitment)): Uint8Array {
  const buf = new Uint8Array(CAPACITY)
  let pos = 0
  const put = (type: number, value: number[]) => {
    buf[pos] = type
    buf[pos + 1] = value.length
    buf.set(value, pos + 2)
    pos += 2 + value.length
  }
  buf[pos++] = 0x01
  put(0x01, [0])
  put(0x02, hex(SWAP.recipient))
  put(0x03, hex(SWAP.factory))
  put(0x04, commitment)
  put(0x05, hex(`0x${SWAP.relayerTip.toString(16).padStart(64, "0")}`))
  put(0x06, hex(SWAP.nonce))
  return buf
}

/** `stream` with a `[type, len, value]` entry written at `pos`. */
function withEntry(stream: Uint8Array, type: number, value: number[], pos: number) {
  const bytes = stream.slice()
  bytes[pos] = type
  bytes[pos + 1] = value.length
  bytes.set(value, pos + 2)
  return bytes
}

/** `stream` with a recipient entry appended after its last entry. */
function withRecipient(stream: Uint8Array, recipient: string, pos = 1 + SWAP_ENTRIES_LEN) {
  return withEntry(stream, 0x07, hex(recipient), pos)
}

/** `stream` with the group entries at `pos`: the id, then the leg byte. */
function withGroup(
  stream: Uint8Array,
  group: WithdrawGroupMeta,
  pos: number,
  legByte = group.leg === "gas" ? 1 : 2,
) {
  return withEntry(withEntry(stream, 0x08, hex(group.id), pos), 0x09, [legByte], pos + 18)
}

/** Bytes the stream occupies up to its terminator, the version byte included. */
function usedBytes(stream: Uint8Array): number {
  let pos = 1
  while (stream[pos] !== 0) pos += 2 + stream[pos + 1]!
  return pos
}

function emptyStream(): Uint8Array {
  const bytes = new Uint8Array(CAPACITY)
  bytes[0] = 0x01
  return bytes
}

describe("withdrawMeta", () => {
  it("round-trips a swap from Fr[] and bigint[], checksumming the addresses", () => {
    const meta = buildWithdrawMeta({ swap: SWAP })
    expect(meta).toHaveLength(WITHDRAW_META_LEN)
    expect(decodeWithdrawMeta(meta)).toEqual({ swap: SWAP })
    expect(decodeWithdrawMeta(meta.map((f) => f.toBigInt()))).toEqual({ swap: SWAP })
    expect(meta).toEqual(packRaw(swapStream()))
  })

  it("encodes every route", () => {
    for (const output of ["USDC", "USDT", "ETH"] as const) {
      expect(
        decodeWithdrawMeta(buildWithdrawMeta({ swap: { ...SWAP, output } })).swap?.output,
      ).toBe(output)
    }
  })

  it("encodes no swap as a versioned empty stream, and all-zero meta as nothing", () => {
    const meta = buildWithdrawMeta({})
    expect(meta[0]!.toBigInt()).toBe(1n << (30n * 8n))
    expect(meta.slice(1).every((f) => f.isZero())).toBe(true)
    expect(decodeWithdrawMeta(meta)).toEqual({})
    expect(decodeWithdrawMeta(emptyWithdrawMeta())).toEqual({})
    expect(decodeWithdrawMeta(undefined)).toEqual({})
    expect(decodeWithdrawMeta(meta.slice(0, 3))).toEqual({})
  })

  it("decodes a swap only when every entry is present and well-formed", () => {
    const stream = swapStream()
    const dropEntry = (type: number) => {
      const bytes = swapStream()
      let pos = 1
      while (bytes[pos] !== 0) {
        const len = bytes[pos + 1]!
        if (bytes[pos] === type) {
          bytes.copyWithin(pos, pos + 2 + len)
          bytes.fill(0, CAPACITY - 2 - len)
          break
        }
        pos += 2 + len
      }
      return packRaw(bytes)
    }
    for (const type of [0x01, 0x02, 0x03, 0x04, 0x05, 0x06]) {
      expect(decodeWithdrawMeta(dropEntry(type))).toEqual({})
    }
    // Unknown route id, zero address, zero or 20-byte recovery commitment, wrong version.
    const badRoute = swapStream()
    badRoute[3] = 9
    expect(decodeWithdrawMeta(packRaw(badRoute))).toEqual({})
    const zeroRecipient = swapStream()
    zeroRecipient.fill(0, 6, 26)
    expect(decodeWithdrawMeta(packRaw(zeroRecipient))).toEqual({})
    expect(decodeWithdrawMeta(packRaw(swapStream(Array(32).fill(0))))).toEqual({})
    expect(decodeWithdrawMeta(packRaw(swapStream(hex(RECOVERY.account))))).toEqual({})
    const badVersion = swapStream()
    badVersion[0] = 0x02
    expect(decodeWithdrawMeta(packRaw(badVersion))).toEqual({})
    expect(decodeWithdrawMeta(packRaw(stream))).toEqual({ swap: SWAP })
  })

  it("skips an unknown entry type and keeps the first of a duplicate", () => {
    const bytes = new Uint8Array(CAPACITY)
    const known = swapStream()
    bytes[0] = 0x01
    bytes[1] = 0x7f
    bytes[2] = 2
    bytes[3] = 0xaa
    bytes[4] = 0xbb
    bytes.set(known.subarray(1, 1 + SWAP_ENTRIES_LEN), 5)
    let pos = 5 + SWAP_ENTRIES_LEN
    bytes[pos] = 0x01
    bytes[pos + 1] = 1
    bytes[pos + 2] = 2
    expect(decodeWithdrawMeta(packRaw(bytes))).toEqual({ swap: SWAP })
  })

  it("round-trips the recipient alone, laid out as a 0x07 entry", () => {
    const meta = buildWithdrawMeta({ recipient: RECIPIENT })
    expect(meta).toEqual(packRaw(withRecipient(emptyStream(), RECIPIENT, 1)))
    expect(decodeWithdrawMeta(meta)).toEqual({ recipient: RECIPIENT })
    expect(
      decodeWithdrawMeta(buildWithdrawMeta({ recipient: RECIPIENT.toLowerCase() as Address })),
    ).toEqual({ recipient: RECIPIENT })
  })

  it("round-trips the recipient after the swap entries", () => {
    const meta = buildWithdrawMeta({ recipient: RECIPIENT, swap: SWAP })
    expect(meta).toEqual(packRaw(withRecipient(swapStream(), RECIPIENT)))
    expect(decodeWithdrawMeta(meta)).toEqual({ recipient: RECIPIENT, swap: SWAP })
  })

  it("decodes the recipient independently of the swap", () => {
    const partialSwap = withRecipient(swapStream(), RECIPIENT)
    partialSwap[3] = 9
    expect(decodeWithdrawMeta(packRaw(partialSwap))).toEqual({ recipient: RECIPIENT })

    const zeroRecipient = withRecipient(swapStream(), `0x${"00".repeat(20)}`)
    expect(decodeWithdrawMeta(packRaw(zeroRecipient))).toEqual({ swap: SWAP })

    const shortRecipient = withRecipient(emptyStream(), RECIPIENT, 1)
    shortRecipient[2] = 19
    expect(decodeWithdrawMeta(packRaw(shortRecipient))).toEqual({})

    const other = getAddress(`0x${"d4".repeat(20)}`)
    const duplicate = withRecipient(withRecipient(emptyStream(), RECIPIENT, 1), other, 23)
    expect(decodeWithdrawMeta(packRaw(duplicate))).toEqual({ recipient: RECIPIENT })
  })

  it("round-trips a group after the swap entries, using 193 of the 217 bytes", () => {
    const meta = buildWithdrawMeta({ recipient: RECIPIENT, swap: SWAP, group: GROUP })
    const stream = withRecipient(
      withGroup(swapStream(), GROUP, 1 + SWAP_ENTRIES_LEN),
      RECIPIENT,
      1 + SWAP_ENTRIES_LEN + GROUP_ENTRIES_LEN,
    )
    expect(meta).toEqual(packRaw(stream))
    expect(decodeWithdrawMeta(meta)).toEqual({ recipient: RECIPIENT, swap: SWAP, group: GROUP })
    expect(usedBytes(stream)).toBe(193)
    expect(CAPACITY).toBe(217)
  })

  it("round-trips a group on a direct withdrawal, either leg", () => {
    const gas: WithdrawGroupMeta = { ...GROUP, leg: "gas" }
    const meta = buildWithdrawMeta({ recipient: RECIPIENT, group: gas })
    expect(meta).toEqual(
      packRaw(withRecipient(withGroup(emptyStream(), gas, 1), RECIPIENT, 1 + GROUP_ENTRIES_LEN)),
    )
    expect(decodeWithdrawMeta(meta)).toEqual({ recipient: RECIPIENT, group: gas })
    expect(decodeWithdrawMeta(buildWithdrawMeta({ group: GROUP }))).toEqual({ group: GROUP })
  })

  it("decodes a group only when both entries are present and well-formed", () => {
    const loneId = withEntry(emptyStream(), 0x08, hex(GROUP.id), 1)
    expect(decodeWithdrawMeta(packRaw(withRecipient(loneId, RECIPIENT, 19)))).toEqual({
      recipient: RECIPIENT,
    })
    const loneLeg = withEntry(emptyStream(), 0x09, [2], 1)
    expect(decodeWithdrawMeta(packRaw(withRecipient(loneLeg, RECIPIENT, 4)))).toEqual({
      recipient: RECIPIENT,
    })
    const zeroId = withGroup(emptyStream(), { ...GROUP, id: `0x${"00".repeat(16)}` }, 1)
    expect(decodeWithdrawMeta(packRaw(zeroId))).toEqual({})
    for (const legByte of [0, 3, 0xff]) {
      expect(decodeWithdrawMeta(packRaw(withGroup(emptyStream(), GROUP, 1, legByte)))).toEqual({})
    }
    const shortId = withEntry(emptyStream(), 0x08, hex(GROUP.id).slice(0, 15), 1)
    expect(decodeWithdrawMeta(packRaw(withEntry(shortId, 0x09, [2], 18)))).toEqual({})
    // The swap and the recipient decode independently of a malformed group.
    const badLeg = withRecipient(
      withGroup(swapStream(), GROUP, 1 + SWAP_ENTRIES_LEN, 9),
      RECIPIENT,
      1 + SWAP_ENTRIES_LEN + GROUP_ENTRIES_LEN,
    )
    expect(decodeWithdrawMeta(packRaw(badLeg))).toEqual({ recipient: RECIPIENT, swap: SWAP })
  })

  it("refuses to encode a malformed value", () => {
    expect(() => buildWithdrawMeta({ swap: { ...SWAP, recipient: "0x12" as Address } })).toThrow(
      /recipient/,
    )
    expect(() => buildWithdrawMeta({ swap: { ...SWAP, nonce: "0x77" as Hex } })).toThrow(/nonce/)
    expect(() =>
      buildWithdrawMeta({ swap: { ...SWAP, recoveryCommitment: RECOVERY.account } }),
    ).toThrow(/recoveryCommitment/)
    expect(() => buildWithdrawMeta({ swap: { ...SWAP, relayerTip: -1n } })).toThrow(/tip/)
    expect(() => buildWithdrawMeta({ recipient: "0x12" as Address })).toThrow(/recipient/)
    expect(() => buildWithdrawMeta({ group: { ...GROUP, id: "0x77" as Hex } })).toThrow(/group id/)
  })
})

describe("swapMetaForEscrow", () => {
  const plan = planSwapOnWithdraw({
    swapEscrowFactory: SWAP.factory,
    output: SWAP.output,
    l1Recipient: SWAP.recipient,
    recovery: RECOVERY,
    amount: 100n * 10n ** 18n,
    withdrawalRelayerTip: 0n,
    proverTip: 0n,
    fpcFundingCut: 0n,
    relayerTip: SWAP.relayerTip,
    nonce: SWAP.nonce,
  })

  it("keeps the meta whose args derive the escrow the burn paid", () => {
    expect(swapMetaForEscrow(SWAP, plan.escrow)).toEqual(SWAP)
    expect(swapMetaForEscrow(SWAP, plan.escrow.toLowerCase() as Address)).toEqual(SWAP)
  })

  it("drops a meta that does not, and no meta at all", () => {
    expect(swapMetaForEscrow({ ...SWAP, recipient: RECOVERY.account }, plan.escrow)).toBe(undefined)
    const otherCommitment = `0x${"5b".repeat(32)}` as Hex
    expect(swapMetaForEscrow({ ...SWAP, recoveryCommitment: otherCommitment }, plan.escrow)).toBe(
      undefined,
    )
    expect(swapMetaForEscrow(SWAP, SWAP.factory)).toBe(undefined)
    expect(swapMetaForEscrow(undefined, plan.escrow)).toBe(undefined)
  })
})

describe("createWithdrawEventSource", () => {
  const plan = planSwapOnWithdraw({
    swapEscrowFactory: SWAP.factory,
    output: SWAP.output,
    l1Recipient: SWAP.recipient,
    recovery: RECOVERY,
    amount: 100n * 10n ** 18n,
    withdrawalRelayerTip: 0n,
    proverTip: 0n,
    fpcFundingCut: 0n,
    relayerTip: SWAP.relayerTip,
    nonce: SWAP.nonce,
  })

  function listed(meta: Fr[]) {
    const wallet = {
      getPrivateEvents: vi.fn(async () => [
        {
          event: { meta, amount: 42n },
          metadata: { txHash: { toString: () => "0xburn" }, l2BlockNumber: 7 },
        },
      ]),
    } as unknown as ObsidionWallet
    return createWithdrawEventSource({
      wallet,
      tokenAddress: `0x${"0a".repeat(32)}`,
      accountAddress: `0x${"0b".repeat(32)}`,
    }).listWithdrawals(0, 10)
  }

  it("reads the L1 payee off the meta", async () => {
    expect(await listed(buildWithdrawMeta({ recipient: RECIPIENT }))).toEqual([
      { txHash: "0xburn", blockNumber: 7, l1Recipient: RECIPIENT, amount: 42n, swap: undefined },
    ])
  })

  it("keeps the swap only when its args derive the escrow the meta names", async () => {
    const [swap] = await listed(buildWithdrawMeta({ recipient: plan.escrow, swap: SWAP }))
    expect(swap).toMatchObject({ l1Recipient: getAddress(plan.escrow), swap: SWAP })

    const [other] = await listed(buildWithdrawMeta({ recipient: RECIPIENT, swap: SWAP }))
    expect(other).toMatchObject({ l1Recipient: RECIPIENT, swap: undefined })
  })

  it("leaves the payee and the swap out when the meta names no recipient", async () => {
    const [event] = await listed(buildWithdrawMeta({ swap: SWAP }))
    expect(event).toMatchObject({ l1Recipient: undefined, swap: undefined, amount: 42n })
  })

  it("copies the group off the meta, checked against nothing", async () => {
    const [event] = await listed(
      buildWithdrawMeta({ recipient: RECIPIENT, swap: SWAP, group: GROUP }),
    )
    expect(event).toMatchObject({ l1Recipient: RECIPIENT, swap: undefined, group: GROUP })
  })
})
