// A burn whose executor's terms do not read, or whose tx the node has not indexed, is reported
// unread, so a replay retries it.
import { describe, expect, it } from "vitest"
import { getAddress, type Address } from "viem"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { TxHash } from "@aztec-labs/stdlib/tx"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { readRecoveredWithdrawals } from "../../../src/services/withdrawal/withdrawEventSource.js"
import { encodeWithdrawalMemo } from "../../../src/services/withdrawal/withdrawalMemo.js"
import type { WithdrawalExecutor } from "../../../src/oxide/withdrawal/withdrawalExecutor.js"

const PORTAL = getAddress(`0x${"0a".repeat(20)}`)
const EXECUTOR = getAddress(`0x${"e0".repeat(20)}`)
const TX = TxHash.fromField(new Fr(7n))
const UNINDEXED = TxHash.fromField(new Fr(8n))
const BROKEN = TxHash.fromField(new Fr(9n))

/** One burn naming EXECUTOR, one failure the node has not indexed, and one it has. */
const recovered = {
  withdrawals: [
    {
      txHash: TX,
      messageHash: new Fr(1n),
      finalizationData: { executor: EthAddress.fromString(EXECUTOR), amount: 5n, proverTip: 0n },
      memo: [],
    },
  ],
  failures: [
    { txHash: UNINDEXED, reason: "no effect" },
    { txHash: BROKEN, reason: "bad chunk" },
  ],
} as unknown as Parameters<typeof readRecoveredWithdrawals>[0]

const node = {
  getTxEffect: async (tx: TxHash) => (tx.equals(BROKEN) ? {} : undefined),
  getTxReceipt: async () => ({ blockNumber: 3 }),
} as unknown as Parameters<typeof readRecoveredWithdrawals>[1]["node"]

const read = (readExecutor: (address: Address) => Promise<WithdrawalExecutor>) =>
  readRecoveredWithdrawals(recovered, { node, portal: PORTAL, readExecutor })

describe("readRecoveredWithdrawals", () => {
  it("reports a burn unread when its executor's terms fail to read, and skips another portal's", async () => {
    const failed = await read(async () => {
      throw new Error("rpc down")
    })
    expect(failed).toEqual({ withdrawals: [], unread: [UNINDEXED.toString(), TX.toString()] })

    const other = { address: EXECUTOR, kind: "sky", portal: EXECUTOR, fee: 0n } as const
    expect(await read(async () => other)).toEqual({
      withdrawals: [],
      unread: [UNINDEXED.toString()],
    })
  })

  it("reports a burn whose receipt names no block unread, and returns it once the block is mined", async () => {
    const recipient = EthAddress.fromNumber(0xa1)
    const [burn] = recovered.withdrawals
    const userPayload = encodePlainWithdrawalPayload({ recipient, relayerTip: 2n })
    const sent = {
      withdrawals: [{ ...burn!, finalizationData: { ...burn!.finalizationData, userPayload } }],
      failures: [],
    } as unknown as typeof recovered
    let mined = false
    const pending = {
      getTxEffect: async () => undefined,
      getTxReceipt: async () => (mined ? { blockNumber: 3 } : {}),
    } as unknown as typeof node
    const plain = { address: EXECUTOR, kind: "plain", portal: PORTAL, fee: 1n } as const
    const scan = () =>
      readRecoveredWithdrawals(sent, {
        node: pending,
        portal: PORTAL,
        readExecutor: async () => plain,
      })

    expect(await scan()).toEqual({ withdrawals: [], unread: [TX.toString()] })
    mined = true
    const { withdrawals, unread } = await scan()
    expect(unread).toEqual([])
    expect(withdrawals).toMatchObject([
      {
        txHash: TX.toString(),
        blockNumber: 3,
        executor: EXECUTOR,
        withdrawalFee: 1n,
        l1Recipient: getAddress(recipient.toString()),
        amount: 5n,
        relayerTip: 2n,
      },
    ])
  })

  it("leaves a vault move's burn to the moves engine, without reading its executor", async () => {
    const [burn] = recovered.withdrawals
    const memo = encodeWithdrawalMemo({ vaultMove: { nonce: `0x${"ab".repeat(32)}` } })
    const moved = {
      withdrawals: [{ ...burn!, memo }],
      failures: [],
    } as unknown as typeof recovered
    let reads = 0
    const scan = await readRecoveredWithdrawals(moved, {
      node,
      portal: PORTAL,
      readExecutor: async () => {
        reads += 1
        throw new Error("no PORTAL on a MultiStepExecutor")
      },
    })
    expect(scan).toEqual({ withdrawals: [], unread: [] })
    expect(reads).toBe(0)
  })

  const failingDeps = (sighted: string[]) => ({
    node,
    portal: PORTAL,
    readExecutor: async (): Promise<WithdrawalExecutor> => {
      throw new Error("rpc down")
    },
    onSighted: (txHash: string) => void sighted.push(txHash),
  })

  it("tells `onSighted` of a vault move's burn, which the scan still leaves out", async () => {
    const [burn] = recovered.withdrawals
    const memo = encodeWithdrawalMemo({ vaultMove: { nonce: `0x${"ab".repeat(32)}` } })
    const moved = { withdrawals: [{ ...burn!, memo }], failures: [] } as unknown as typeof recovered
    const sighted: string[] = []

    expect(await readRecoveredWithdrawals(moved, failingDeps(sighted))).toEqual({
      withdrawals: [],
      unread: [],
    })
    expect(sighted).toEqual([TX.toString()])
  })

  it("tells `onSighted` of each burn it could not read, and still reports them unread", async () => {
    const sighted: string[] = []

    expect(await readRecoveredWithdrawals(recovered, failingDeps(sighted))).toEqual({
      withdrawals: [],
      unread: [UNINDEXED.toString(), TX.toString()],
    })
    expect(sighted).toEqual([UNINDEXED.toString(), TX.toString()])
  })
})
