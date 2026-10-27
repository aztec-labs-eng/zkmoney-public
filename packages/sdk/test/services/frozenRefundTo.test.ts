import { describe, expect, it, vi } from "vitest"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { WITHDRAW_RELAYER_TIP as TIP } from "@obsidion/core/constants"

const m = vi.hoisted(() => ({ sponsor: vi.fn() }))
vi.mock("@oxide/oxide-client/broadcaster_calls.js", () => ({
  broadcastL1Operation: () => ({ request: async () => ({ calls: ["broadcast"] }) }),
}))
vi.mock("../../src/feePaymentMethod/claimSponsoredCall.js", () => ({
  buildClaimSponsorPayload: async (o: unknown) => {
    m.sponsor(o)
    return { sponsored: true }
  },
}))
vi.mock("../../src/feePaymentMethod/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: () => ({}),
}))

const { FrozenMetadataMigrationSource } = await import(
  "../../src/services/FrozenMetadataMigrationSource.js"
)

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const TO = addr("12")
const PORTAL = addr("51")
const deposit = (id: string, amount: bigint) => ({
  id,
  amount: String(amount),
  kind: "frozen-deposit" as const,
  leafIndex: `${id}-leaf`,
})

function fixture(candidates: ReturnType<typeof deposit>[], call = vi.fn(async () => ({}))) {
  const build = vi.fn(async ({ ids }: { ids: string[] }, _to: string, _tip: bigint) => ({
    amount: ids.reduce((sum, id) => sum + BigInt(candidates.find((c) => c.id === id)!.amount), 0n),
    operation: {
      target: EthAddress.fromString(PORTAL),
      payoutToken: EthAddress.fromString(addr("da")),
      calldata: Buffer.from("1234", "hex"),
      condition: L1OperationCondition.immediate(),
    },
  }))
  const sendTx = vi.fn(
    async (_payload: unknown, opts: { onTxHash(hash: string): Promise<void> }) => {
      await opts.onTxHash(`0x${String(sendTx.mock.calls.length).padStart(64, "0")}`)
    },
  )
  const source = new FrozenMetadataMigrationSource({
    owner: addr("0a"),
    runtime: {
      identity: "frozen",
      migration: {
        executor: addr("e1"),
        subsidy: addr("5b"),
        payoutToken: addr("da"),
        sourcePortal: PORTAL,
        destinationPortal: addr("de"),
        operationExecutor: addr("0e"),
      },
      validate: async () => {},
      candidates: async () => ({
        maxNotesPerBatch: 2,
        maxBatchAmount: 1000n * TIP,
        candidates,
        waiting: 7n,
      }),
      build,
      refunded: async () => false,
    },
    destinationAsset: addr("01"),
    destination: { portal: addr("de"), factory: addr("f0"), rollupVersion: 5n },
    registered: { user: AztecAddress.ZERO, policy: {} },
    client: { call },
    wallet: { sendTx },
  } as never)
  return { source, build, sendTx, call }
}

describe("refunding a frozen source to an L1 address", () => {
  it("sends one sponsored broadcast per refund that covers its tip, skipping refunds in flight", async () => {
    const { source, build, sendTx } = fixture([
      deposit("a", 20n * TIP),
      deposit("b", 10n * TIP),
      deposit("c", TIP),
      deposit("d", 5n * TIP),
    ])
    const onSent = vi.fn()

    const result = await source.refundTo(TO, TIP, { skip: new Set(["d"]), onSent })

    expect(build.mock.calls.map(([selection, to, tip]) => [selection.ids, to, tip])).toEqual([
      [["a"], TO, TIP],
      [["b"], TO, TIP],
    ])
    expect(sendTx).toHaveBeenCalledTimes(2)
    expect(m.sponsor).toHaveBeenLastCalledWith(
      expect.objectContaining({ innerCalls: ["broadcast"] }),
    )
    expect(onSent).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      sent: [
        {
          ids: ["a"],
          deposits: [{ leafIndex: "a-leaf", amount: String(20n * TIP) }],
          amount: 20n * TIP,
          txHash: `0x${"1".padStart(64, "0")}`,
        },
        {
          ids: ["b"],
          deposits: [{ leafIndex: "b-leaf", amount: String(10n * TIP) }],
          amount: 10n * TIP,
          txHash: `0x${"2".padStart(64, "0")}`,
        },
      ],
      // A refund no larger than its tip stays.
      stranded: TIP,
      waiting: 7n,
    })
  })

  it("spends no sponsored send on a refund that would revert on L1", async () => {
    const { source, sendTx } = fixture(
      [deposit("a", 20n * TIP)],
      vi.fn(async () => {
        throw new Error("execution reverted")
      }),
    )

    await expect(source.refundTo(TO, TIP)).rejects.toThrow("execution reverted")
    expect(sendTx).not.toHaveBeenCalled()
  })
})
