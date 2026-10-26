import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { TxHash } from "@aztec-labs/stdlib/tx"
import { getAddress, type Address, type Hex } from "viem"
import { SkyRoute, predictSkyEscrowAddressLocally } from "@oxide/experiments/sky/sky_savings.js"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"

const recovered = vi.hoisted(() => ({ withdrawals: [] as unknown[] }))
vi.mock("@oxide/oxide-client/withdrawal_recovery.js", () => ({
  recoverWithdrawals: async () => ({ withdrawals: recovered.withdrawals, failures: [] }),
}))

import { planSwapOnWithdraw } from "../src/oxide/swapOnWithdraw.js"
import {
  decodeWithdrawalMemo,
  encodeWithdrawalMemo,
  type SkyWithdrawalMemo,
  type SwapWithdrawalMemo,
} from "../src/services/withdrawalMemo.js"
import {
  createWithdrawEventSource,
  skyMemoForEscrow,
  swapMemoForEscrow,
} from "../src/services/withdrawEventSource.js"
import type { ObsidionWallet } from "../src/obsidion/ObsidionWallet.js"
import type { WithdrawalExecutor } from "../src/oxide/withdrawalExecutor.js"

const RECOVERY = { account: getAddress(`0x${"5a".repeat(20)}`), salt: new Fr(9n) }

const SWAP: SwapWithdrawalMemo = {
  output: "USDC",
  recipient: getAddress(`0x${"b0".repeat(20)}`),
  factory: getAddress(`0x${"fa".repeat(20)}`),
  recoveryCommitment: deriveRecoveryCommitment(
    RECOVERY.salt,
    EthAddress.fromString(RECOVERY.account),
  ).toString(),
  relayerTip: 5n * 10n ** 18n,
  nonce: `0x${"77".repeat(32)}` as Hex,
  daiForGas: 0n,
  minEthForGas: 0n,
}

const SKY: SkyWithdrawalMemo = {
  route: SkyRoute.Unstake,
  factory: getAddress(`0x${"fb".repeat(20)}`),
  recipientCommitment: `0x${"2c".repeat(32)}` as Hex,
  recoveryCommitment: SWAP.recoveryCommitment,
  relayerTip: 3n * 10n ** 18n,
  nonce: `0x${"88".repeat(32)}` as Hex,
}
const SKY_ESCROW = predictSkyEscrowAddressLocally(SKY.factory, SKY)

const PLAN = planSwapOnWithdraw({
  swapEscrowFactoryV2: SWAP.factory,
  output: SWAP.output,
  l1Recipient: SWAP.recipient,
  recovery: RECOVERY,
  amount: 100n * 10n ** 18n,
  withdrawalFee: 0n,
  withdrawalRelayerTip: 0n,
  proverTip: 0n,
  relayerTip: SWAP.relayerTip,
  nonce: SWAP.nonce,
})

const hex = (s: string) => [...Buffer.from(s.slice(2), "hex")]
const entry = (type: number, value: number[]) => [type, value.length, ...value]

/** The bytes `encodeWithdrawalMemo({ swap: SWAP })` lays out. */
function swapBytes(commitment = hex(SWAP.recoveryCommitment)): number[] {
  return [
    0x01,
    ...entry(0x01, [0]),
    ...entry(0x02, hex(SWAP.recipient)),
    ...entry(0x03, hex(SWAP.factory)),
    ...entry(0x04, commitment),
    ...entry(0x05, hex(`0x${SWAP.relayerTip.toString(16)}`)),
    ...entry(0x06, hex(SWAP.nonce)),
  ]
}

/** The bytes `encodeWithdrawalMemo({ sky: SKY })` lays out, with `route` as the route byte. */
function skyBytes(route: number = SKY.route): number[] {
  return [
    0x01,
    ...entry(0x09, [route]),
    ...entry(0x03, hex(SKY.factory)),
    ...entry(0x0a, hex(SKY.recipientCommitment)),
    ...entry(0x04, hex(SKY.recoveryCommitment)),
    ...entry(0x05, hex(`0x${SKY.relayerTip.toString(16).padStart(16, "0")}`)),
    ...entry(0x06, hex(SKY.nonce)),
  ]
}

const decode = (bytes: number[]) => decodeWithdrawalMemo(Buffer.from(bytes))

/** `bytes` without the entry of `type`. */
function withoutEntry(bytes: number[], type: number): number[] {
  for (let pos = 1; pos < bytes.length; pos += 2 + bytes[pos + 1]!) {
    if (bytes[pos] === type)
      return [...bytes.slice(0, pos), ...bytes.slice(pos + 2 + bytes[pos + 1]!)]
  }
  return bytes
}

describe("withdrawalMemo", () => {
  it("round-trips a swap, every route, laid out as TLV entries", () => {
    const memo = encodeWithdrawalMemo({ swap: SWAP })
    expect([...memo]).toEqual(swapBytes())
    expect(decodeWithdrawalMemo(memo)).toEqual({ swap: SWAP })
    for (const output of ["USDC", "USDT", "ETH"] as const) {
      const swap = { ...SWAP, output }
      expect(decodeWithdrawalMemo(encodeWithdrawalMemo({ swap }))).toEqual({ swap })
    }
  })

  it("round-trips the gas swap in its fewest bytes", () => {
    const swap = { ...SWAP, daiForGas: 15n * 10n ** 18n, minEthForGas: 4_000_000_000_000_000n }
    const memo = encodeWithdrawalMemo({ swap })
    expect([...memo]).toEqual([
      ...swapBytes(),
      ...entry(0x07, hex(`0x${swap.daiForGas.toString(16).padStart(16, "0")}`)),
      ...entry(0x08, hex(`0x${swap.minEthForGas.toString(16).padStart(14, "0")}`)),
    ])
    expect(decodeWithdrawalMemo(memo)).toEqual({ swap })
    const free = { ...SWAP, relayerTip: 0n }
    expect(decodeWithdrawalMemo(encodeWithdrawalMemo({ swap: free }))).toEqual({ swap: free })
  })

  it("round-trips a Sky move, either route", () => {
    const memo = encodeWithdrawalMemo({ sky: SKY })
    expect([...memo]).toEqual(skyBytes())
    expect(decodeWithdrawalMemo(memo)).toEqual({ sky: SKY })
    const stake = { ...SKY, route: SkyRoute.Stake }
    expect(decodeWithdrawalMemo(encodeWithdrawalMemo({ sky: stake }))).toEqual({ sky: stake })
  })

  it("encodes no escrow as an empty memo, and decodes an empty or unversioned memo as nothing", () => {
    expect(encodeWithdrawalMemo({})).toEqual(Buffer.alloc(0))
    expect(decode([])).toEqual({})
    expect(decode([0x01])).toEqual({})
    expect(decode([0x02, ...swapBytes().slice(1)])).toEqual({})
  })

  it("decodes a swap only when every entry is present and well-formed", () => {
    for (const type of [0x01, 0x02, 0x03, 0x04, 0x05, 0x06]) {
      expect(decode(withoutEntry(swapBytes(), type))).toEqual({})
    }
    const badRoute = swapBytes()
    badRoute[3] = 9
    expect(decode(badRoute)).toEqual({})
    const zeroRecipient = swapBytes()
    zeroRecipient.fill(0, 6, 26)
    expect(decode(zeroRecipient)).toEqual({})
    expect(decode(swapBytes(Array(32).fill(0)))).toEqual({})
    expect(decode(swapBytes(hex(RECOVERY.account)))).toEqual({})
    expect(decode(swapBytes().slice(0, -1))).toEqual({})
  })

  it("skips an unknown entry type and keeps the first of a duplicate", () => {
    const bytes = [0x01, ...entry(0x7f, [0xaa, 0xbb]), ...swapBytes().slice(1), ...entry(0x01, [2])]
    expect(decode(bytes)).toEqual({ swap: SWAP })
  })

  it("ignores a gas entry of no bytes or more than a word", () => {
    for (const value of [[], Array(33).fill(1)]) {
      expect(decode([...swapBytes(), ...entry(0x07, value)])).toEqual({ swap: SWAP })
    }
  })

  it("decodes a Sky move only with a known route and every entry, and never beside a swap route", () => {
    expect(decode(skyBytes(7))).toEqual({})
    expect(decode(withoutEntry(skyBytes(), 0x0a))).toEqual({})
    expect(decode([...skyBytes(), ...entry(0x01, [0])])).toEqual({})
  })

  it("refuses to encode a malformed value or two escrows", () => {
    expect(() => encodeWithdrawalMemo({ swap: { ...SWAP, recipient: "0x12" as Address } })).toThrow(
      /recipient/,
    )
    expect(() => encodeWithdrawalMemo({ swap: { ...SWAP, nonce: "0x77" as Hex } })).toThrow(/nonce/)
    expect(() =>
      encodeWithdrawalMemo({ swap: { ...SWAP, recoveryCommitment: RECOVERY.account } }),
    ).toThrow(/recoveryCommitment/)
    expect(() => encodeWithdrawalMemo({ swap: { ...SWAP, relayerTip: -1n } })).toThrow(
      /out of range/,
    )
    expect(() => encodeWithdrawalMemo({ sky: { ...SKY, route: 7 as SkyRoute } })).toThrow(
      /Sky route/,
    )
    expect(() =>
      encodeWithdrawalMemo({ sky: { ...SKY, recipientCommitment: "0x2c" as Hex } }),
    ).toThrow(/recipientCommitment/)
    expect(() => encodeWithdrawalMemo({ swap: SWAP, sky: SKY })).toThrow(/one escrow/)
  })
})

describe("swapMemoForEscrow", () => {
  it("keeps the memo whose args derive the escrow the burn paid", () => {
    expect(swapMemoForEscrow(SWAP, PLAN.escrow)).toEqual(SWAP)
    expect(swapMemoForEscrow(SWAP, PLAN.escrow.toLowerCase() as Address)).toEqual(SWAP)
  })

  it("drops a memo that does not, and no memo at all", () => {
    expect(swapMemoForEscrow({ ...SWAP, recipient: RECOVERY.account }, PLAN.escrow)).toBe(undefined)
    expect(swapMemoForEscrow({ ...SWAP, daiForGas: 1n }, PLAN.escrow)).toBe(undefined)
    expect(swapMemoForEscrow(SWAP, SWAP.factory)).toBe(undefined)
    expect(swapMemoForEscrow(undefined, PLAN.escrow)).toBe(undefined)
  })
})

describe("skyMemoForEscrow", () => {
  it("keeps the memo whose args derive the escrow the burn paid, and drops any other", () => {
    expect(skyMemoForEscrow(SKY, SKY_ESCROW)).toEqual(SKY)
    expect(skyMemoForEscrow(SKY, SKY_ESCROW.toLowerCase() as Address)).toEqual(SKY)
    expect(skyMemoForEscrow({ ...SKY, nonce: SWAP.nonce }, SKY_ESCROW)).toBe(undefined)
    expect(skyMemoForEscrow({ ...SKY, route: SkyRoute.Stake }, SKY_ESCROW)).toBe(undefined)
    expect(skyMemoForEscrow(undefined, SKY_ESCROW)).toBe(undefined)
  })
})

describe("createWithdrawEventSource", () => {
  const EXECUTOR = getAddress(`0x${"44".repeat(20)}`)
  const PORTAL = getAddress(`0x${"55".repeat(20)}`)
  const TX = TxHash.fromString(`0x${"0a".repeat(32)}`)
  const terms = (address: Address, fee: bigint, portal = PORTAL): WithdrawalExecutor => ({
    address,
    kind: "plain",
    portal,
    fee,
  })

  function burn(payee: Address, memo: Buffer, executor: Address = EXECUTOR, txHash = TX) {
    return {
      txHash,
      memo,
      finalizationData: {
        executor: EthAddress.fromString(executor),
        amount: 42n,
        proverTip: 1n,
        userPayload: encodePlainWithdrawalPayload({
          recipient: EthAddress.fromString(payee),
          relayerTip: 2n,
        }),
      },
    }
  }

  function source(readExecutor = async (address: Address) => terms(address, 0n)) {
    const wallet = { node: { getTxReceipt: async () => ({ blockNumber: 7 }) } }
    return createWithdrawEventSource({
      wallet: wallet as unknown as ObsidionWallet,
      portal: { l1Portal: EthAddress.fromString(PORTAL) } as never,
      accountAddress: `0x${"0b".repeat(32)}`,
      readExecutor,
    })
  }

  function listed(payee: Address, memo: Buffer) {
    recovered.withdrawals = [burn(payee, memo)]
    return source().listWithdrawals(0, 10)
  }

  it("reads the payee and the tips off the finalization data", async () => {
    expect(await listed(SWAP.recipient, Buffer.alloc(0))).toEqual([
      {
        txHash: TX.toString(),
        blockNumber: 7,
        executor: EXECUTOR,
        withdrawalFee: 0n,
        l1Recipient: SWAP.recipient,
        amount: 42n,
        proverTip: 1n,
        relayerTip: 2n,
        swap: undefined,
        sky: undefined,
      },
    ])
  })

  it("keeps the swap only when its args derive the escrow the burn paid", async () => {
    const memo = encodeWithdrawalMemo({ swap: SWAP })
    const [swap] = await listed(PLAN.escrow, memo)
    expect(swap).toMatchObject({ l1Recipient: getAddress(PLAN.escrow), swap: SWAP })
    const [other] = await listed(SWAP.recipient, memo)
    expect(other).toMatchObject({ l1Recipient: SWAP.recipient, swap: undefined })
  })

  it("keeps the Sky move only when its args derive the escrow the burn paid", async () => {
    const memo = encodeWithdrawalMemo({ sky: SKY })
    const [sky] = await listed(SKY_ESCROW, memo)
    expect(sky).toMatchObject({ l1Recipient: SKY_ESCROW, sky: SKY })
    const [other] = await listed(PLAN.escrow, memo)
    expect(other).toMatchObject({ sky: undefined })
  })

  it("keeps every executor of the portal, each with its own fee, and reads each once", async () => {
    const swapped = getAddress(`0x${"66".repeat(20)}`)
    const foreign = getAddress(`0x${"77".repeat(20)}`)
    const tx = (byte: string) => TxHash.fromString(`0x${byte.repeat(32)}`)
    recovered.withdrawals = [
      burn(SWAP.recipient, Buffer.alloc(0), EXECUTOR, tx("01")),
      burn(SWAP.recipient, Buffer.alloc(0), swapped, tx("02")),
      burn(SWAP.recipient, Buffer.alloc(0), EXECUTOR, tx("03")),
      burn(SWAP.recipient, Buffer.alloc(0), foreign, tx("04")),
    ]
    const reads: Address[] = []
    const fees: Record<Address, bigint> = { [EXECUTOR]: 5n, [swapped]: 9n }
    const listed = await source(async (address) => {
      reads.push(address)
      return address === foreign
        ? terms(address, 0n, getAddress(`0x${"88".repeat(20)}`))
        : terms(address, fees[address]!)
    }).listWithdrawals(0, 10)
    expect(
      listed.map(({ txHash, executor, withdrawalFee }) => [txHash, executor, withdrawalFee]),
    ).toEqual([
      [tx("01").toString(), EXECUTOR, 5n],
      [tx("02").toString(), swapped, 9n],
      [tx("03").toString(), EXECUTOR, 5n],
    ])
    expect(reads).toEqual([EXECUTOR, swapped, foreign])
  })

  it("skips the burns through an executor whose terms cannot be read, and keeps the rest", async () => {
    const unreadable = getAddress(`0x${"99".repeat(20)}`)
    const tx = (byte: string) => TxHash.fromString(`0x${byte.repeat(32)}`)
    recovered.withdrawals = [
      burn(SWAP.recipient, Buffer.alloc(0), unreadable, tx("01")),
      burn(SWAP.recipient, Buffer.alloc(0), EXECUTOR, tx("02")),
    ]
    const listed = await source(async (address) => {
      if (address === unreadable) throw new Error("execution reverted: FEE")
      return terms(address, 5n)
    }).listWithdrawals(0, 10)
    expect(listed.map(({ txHash }) => txHash)).toEqual([tx("02").toString()])
  })
})
