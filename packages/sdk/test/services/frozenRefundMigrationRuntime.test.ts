import { beforeEach, describe, expect, it, vi } from "vitest"
import { NO_FROM } from "@aztec/aztec.js/account"
import { AztecAddress, EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import type { FrozenDepositDescriptor } from "@obsidion/core/types"
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, toHex } from "viem"

const h = vi.hoisted(() => ({
  notesCircuit: { bytecode: "0x" } as { bytecode?: string },
  depositCircuit: { bytecode: "0x" } as { bytecode?: string },
  unprocessedCircuit: { bytecode: "0x" } as { bytecode?: string },
  classify: vi.fn(),
  frozenNotes: vi.fn(),
  buildNotesRefund: vi.fn(async () => "0x12"),
}))
vi.mock("@oxide/refund-proof/frozen_notes_refund/artifact.js", () => ({
  RefundCircuit: h.notesCircuit,
}))
vi.mock("@oxide/refund-proof/frozen_deposit_refund/artifact.js", () => ({
  FrozenDepositRefundCircuit: h.depositCircuit,
}))
vi.mock("@oxide/refund-proof/unprocessed_deposit_refund/artifact.js", () => ({
  UnprocessedDepositRefundCircuit: h.unprocessedCircuit,
}))
vi.mock("@oxide/oxide-client/deposit_refund_eligibility.js", () => ({
  classifyDepositRefund: h.classify,
}))
vi.mock("@oxide/oxide-client/archive_ref.js", () => ({
  resolveFreezeArchive: async () => ({ root: Fr.ONE }),
}))
vi.mock("@oxide/oxide-client/frozen_notes.js", () => ({
  getRefundableFrozenNotes: h.frozenNotes,
}))
vi.mock("@oxide/oxide-lib/hash.js", () => ({
  computeNoteNullifier: async (provenNoteHash: Fr) => provenNoteHash,
}))
vi.mock("@oxide/oxide-client/atlatl/process_refund_requests.js", () => ({
  buildRefundFrozenNotesPortalCalldata: h.buildNotesRefund,
}))

const { FrozenRefundMigrationRuntime, nextFrozenSelfRefund, readRefundableFrozenDeposits } =
  await import("../../src/services/FrozenRefundMigrationRuntime.js")

const descriptor = (n: number): FrozenDepositDescriptor => ({
  messageKey: new Fr(n).toString(),
  messageLeafIndex: String(n),
  l1BlockNumber: "7",
  sharedSecretSalt: new Fr(100 + n).toString(),
  amount: String(1000 + n),
})

function runtime(over: Record<string, unknown> = {}) {
  const address = EthAddress.random()
  const owner = { address: { equals: () => true } }
  const options = {
    node: { getNodeInfo: vi.fn(), getBlockNumber: vi.fn(async () => 10) },
    pxe: {
      sync: vi.fn(async () => {}),
      getSyncedBlockHeader: vi.fn(async () => ({
        globalVariables: { blockNumber: 10, version: new Fr(1n) },
      })),
    },
    token: { address },
    portal: { address, getUnderlying: async () => address },
    inbox: {},
    rollup: address.toString(),
    rollupVersion: 1n,
    owner,
    depositMetadata: { ownerAddressPreimage: { address: owner.address } },
    depositDescriptors: vi.fn(async () => [descriptor(1)]),
    executor: address,
    tipRecipient: address,
    ...over,
  }
  return { runtime: new FrozenRefundMigrationRuntime(options as never), options }
}

describe("FrozenRefundMigrationRuntime", () => {
  beforeEach(() => {
    h.notesCircuit.bytecode = "0x"
    h.depositCircuit.bytecode = "0x"
    h.unprocessedCircuit.bytecode = "0x"
    h.classify.mockReset()
    h.frozenNotes.mockReset()
    h.frozenNotes.mockResolvedValue([])
    h.buildNotesRefund.mockClear()
  })

  it("finds the batches L1 already refunded, through notes the reader would drop", async () => {
    const notes = [11, 12].map((n) => ({ provenNoteHash: new Fr(n), amount: new Fr(5n) }))
    h.frozenNotes.mockImplementation(async (portal) =>
      (await portal.isRefundNullifierSpent()) ? [] : notes,
    )
    const executor = EthAddress.random()
    const { runtime: r, options } = runtime({
      executor,
      resolveSpendMetadata: async () => ({ masterNullifierHidingKey: Fr.ONE }),
    })
    Object.assign(options.portal, {
      isRefundNullifierSpent: async (id: Fr) => id.equals(new Fr(11)),
    })
    const recipient = `0x${"44".repeat(20)}` as const
    const hash = `0x${"ab".repeat(32)}` as const
    const client = {
      getBlockNumber: async () => 20n,
      getContractEvents: vi.fn(async () => [
        { transactionHash: hash, blockNumber: 15n, args: { executionAmount: 5n } },
      ]),
      getTransactionReceipt: async () => ({
        logs: [
          {
            address: options.portal.address.toString(),
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: "Transfer",
              args: { from: executor.toString() as `0x${string}`, to: recipient },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [5n]),
          },
        ],
      }),
    }
    expect(await r.refundsSent(client as never, 1n)).toEqual([
      { hash, amount: 5n, recipient: getAddress(recipient), blockNumber: 15n },
    ])
    expect(client.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "WithdrawalOrRefund",
        args: { nullifier: [toHex(11n, { size: 32 })] },
      }),
    )
  })

  it("reads each payment link's notes under its escrow, and refunds them as that escrow", async () => {
    const escrow = (n: bigint) => ({
      owner: { address: AztecAddress.fromBigIntUnsafe(n) },
      resolveSpendMetadata: vi.fn(async () => ({ masterNullifierHidingKey: new Fr(n) })),
    })
    const [a, b] = [escrow(0xan), escrow(0xbn)]
    const noteOf = new Map([
      [a.owner.address.toString(), { provenNoteHash: new Fr(11), amount: new Fr(5n) }],
      [b.owner.address.toString(), { provenNoteHash: new Fr(12), amount: new Fr(7n) }],
    ])
    h.frozenNotes.mockImplementation(async (_p, _t, _n, owner) => {
      const note = noteOf.get(String(owner))
      return note ? [note] : []
    })
    h.classify.mockResolvedValue({ kind: "spent", nullifier: new Fr(99) })
    const { runtime: r } = runtime({ escrows: vi.fn(async () => [a, b]) })
    expect((await r.candidates()).candidates).toEqual([
      {
        id: new Fr(11).toString(),
        amount: "5",
        kind: "escrow-note",
        owner: a.owner.address.toString(),
      },
      {
        id: new Fr(12).toString(),
        amount: "7",
        kind: "escrow-note",
        owner: b.owner.address.toString(),
      },
    ])
    expect(h.frozenNotes).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      a.owner.address,
      a.resolveSpendMetadata,
      undefined,
      { from: NO_FROM, additionalScopes: [a.owner.address] },
    )
    const recipient = EthAddress.random().toString()
    await r.build({ kind: "escrow-note", ids: [new Fr(11).toString()] }, recipient, 1n)
    expect(h.buildNotesRefund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ owner: a.owner, resolveSpendMetadata: a.resolveSpendMetadata }),
    )
    await expect(
      r.build(
        { kind: "escrow-note", ids: [new Fr(11).toString(), new Fr(12).toString()] },
        recipient,
        1n,
      ),
    ).rejects.toThrow("A frozen refund selection spans payment links")
  })

  it("never reads a failed payment link scan as empty, and does not memoize it", async () => {
    h.classify.mockResolvedValue({ kind: "spent", nullifier: new Fr(99) })
    const escrows = vi.fn().mockRejectedValueOnce(new Error("lane")).mockResolvedValue([])
    const { runtime: r } = runtime({ escrows })
    await expect(r.candidates()).rejects.toThrow("lane")
    await expect(r.candidates()).resolves.toMatchObject({ candidates: [] })
    expect(escrows).toHaveBeenCalledTimes(2)
  })

  it("refuses a stub refund circuit before reading the chain", async () => {
    for (const circuit of [h.notesCircuit, h.depositCircuit, h.unprocessedCircuit]) {
      const { runtime: r, options } = runtime()
      circuit.bytecode = undefined
      await expect(r.validate(EthAddress.random().toString())).rejects.toThrow(
        "A frozen refund circuit is a build stub",
      )
      expect(options.node.getNodeInfo).not.toHaveBeenCalled()
      circuit.bytecode = "0x"
    }
  })

  it("accepts any Aztec 5 source node and refuses another major", async () => {
    const validate = (nodeVersion: string) => {
      const { runtime: r, options } = runtime()
      const { address } = options.token
      Object.assign(options.portal, {
        getL2Portal: async () => address,
        getRollup: async () => address,
        getRollupVersion: async () => 1n,
        isFrozen: async () => true,
      })
      options.node.getNodeInfo.mockResolvedValue({
        nodeVersion,
        rollupVersion: 1,
        l1ContractAddresses: { rollupAddress: address },
      })
      return r.validate(address.toString())
    }
    await expect(validate("5.3.0-nightly.20261022")).resolves.toBeUndefined()
    await expect(validate("v5.2.0")).resolves.toBeUndefined()
    await expect(validate("6.0.0")).rejects.toThrow("does not match its pinned proof generation")
  })

  it("keeps a frozen deposit and a closed-tree unprocessed one, and drops one claimed before the freeze or refunded", async () => {
    h.classify.mockImplementation(async (_p, _i, _c, deposit: { messageLeafIndex: bigint }) => ({
      kind: ["frozen-deposit", "consumed", "refunded", "unprocessed-deposit"][
        Number(deposit.messageLeafIndex) - 1
      ],
      nullifier: new Fr(deposit.messageLeafIndex + 50n),
    }))
    const inbox = (inProgress: bigint) => ({
      getState: async () => ({ treeInProgress: inProgress }),
      getMessageSentEvents: async () => [{ args: { leaf: new Fr(4), checkpointNumber: 9n } }],
    })
    const found = await readRefundableFrozenDeposits({
      portal: {},
      inbox: inbox(10n),
      node: {},
      depositMetadata: {},
      descriptors: [1, 2, 3, 4, 1].map(descriptor),
    } as never)
    expect(found.map(({ kind, id }) => [kind, id])).toEqual([
      ["frozen-deposit", new Fr(51n).toString()],
      ["unprocessed-deposit", new Fr(54n).toString()],
    ])
    const deposits = async () => [1, 4].map(descriptor)
    // An unprocessed deposit waits while its Inbox tree is open: a later message would change the root.
    const open = runtime({ depositDescriptors: deposits, inbox: inbox(9n) }).runtime
    expect(await open.candidates()).toMatchObject({
      candidates: [{ id: new Fr(51n).toString(), amount: "1001", kind: "frozen-deposit" }],
      waiting: 1004n,
    })
    const closed = runtime({ depositDescriptors: deposits, inbox: inbox(10n) }).runtime
    expect(await closed.candidates()).toMatchObject({
      candidates: [
        { id: new Fr(51n).toString(), amount: "1001", kind: "frozen-deposit" },
        { id: new Fr(54n).toString(), amount: "1004", kind: "unprocessed-deposit" },
      ],
      waiting: 0n,
    })
  })

  it("never reads a failed classification or scan as empty, and does not memoize a failed scan", async () => {
    h.classify.mockRejectedValue(new Error("missing witness"))
    await expect(runtime().runtime.candidates()).rejects.toThrow("missing witness")

    h.classify.mockResolvedValue({ kind: "frozen-deposit", nullifier: Fr.ONE })
    const scan = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValue([descriptor(1)])
    const { runtime: r } = runtime({ depositDescriptors: scan })
    await expect(r.candidates()).rejects.toThrow("rpc down")
    expect((await r.candidates()).candidates).toHaveLength(1)
    await r.candidates()
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it("never reads a failed Inbox read as a waiting or refundable deposit", async () => {
    h.classify.mockResolvedValue({ kind: "unprocessed-deposit", nullifier: Fr.ONE })
    const inbox = {
      getState: async () => Promise.reject(new Error("l1 down")),
      getMessageSentEvents: async () => [],
    }
    await expect(runtime({ inbox }).runtime.candidates()).rejects.toThrow("l1 down")
    inbox.getState = async () => ({ treeInProgress: 99n } as never)
    await expect(runtime({ inbox }).runtime.candidates()).rejects.toThrow(
      "no message for the deposit",
    )
  })

  it("refuses a fresh scan whose sync resolves behind the source tip", async () => {
    h.classify.mockResolvedValue({ kind: "frozen-deposit", nullifier: Fr.ONE })
    const { runtime: r, options } = runtime()
    options.node.getBlockNumber.mockResolvedValue(11)
    await expect(r.candidates({ fresh: true })).rejects.toThrow("did not sync")
    options.node.getBlockNumber.mockResolvedValue(10)
    expect((await r.candidates({ fresh: true })).candidates).toHaveLength(1)
    expect(options.depositDescriptors).toHaveBeenLastCalledWith({ fresh: true })
  })
})

describe("nextFrozenSelfRefund", () => {
  const recipient = "0x00000000000000000000000000000000000000aa"
  const selfRuntime = (candidates: Array<{ id: string; amount: string }>, waiting = 0n) => ({
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n,
      waiting,
      candidates: candidates.map((c) => ({ ...c, kind: "note" as const })),
    })),
    build: vi.fn(async (selection: { ids: string[] }) => ({
      amount: 5n,
      operation: {
        target: EthAddress.fromString("0x00000000000000000000000000000000000000bb"),
        calldata: Buffer.from([0x12, 0x34]),
      },
    })),
  })

  it("proves a capped batch paid in full to the submitter, with no relayer tip", async () => {
    const rt = selfRuntime(
      [
        { id: "a", amount: "1" },
        { id: "b", amount: "2" },
        { id: "c", amount: "3" },
      ],
      7n,
    )
    const next = await nextFrozenSelfRefund(rt as never, recipient, { fresh: true })
    expect(rt.candidates).toHaveBeenCalledWith({ fresh: true })
    expect(rt.build).toHaveBeenCalledWith(
      { kind: "note", ids: expect.any(Array), amount: expect.any(BigInt) },
      recipient,
      0n,
    )
    expect(rt.build.mock.calls[0]![0].ids).toHaveLength(2)
    expect(next).toEqual({
      remaining: 6n,
      waiting: 7n,
      refund: {
        ids: rt.build.mock.calls[0]![0].ids,
        amount: 5n,
        to: "0x00000000000000000000000000000000000000bb",
        data: "0x1234",
      },
    })
  })

  it("builds nothing once no refundable batch is left", async () => {
    const rt = selfRuntime([], 7n)
    expect(await nextFrozenSelfRefund(rt as never, recipient)).toEqual({
      remaining: 0n,
      waiting: 7n,
    })
    expect(rt.build).not.toHaveBeenCalled()
  })
})
