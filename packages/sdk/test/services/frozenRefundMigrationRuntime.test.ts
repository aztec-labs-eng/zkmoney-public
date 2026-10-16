import { beforeEach, describe, expect, it, vi } from "vitest"
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import type { FrozenDepositDescriptor } from "@obsidion/core/types"

const h = vi.hoisted(() => ({
  notesCircuit: { bytecode: "0x" } as { bytecode?: string },
  depositCircuit: { bytecode: "0x" } as { bytecode?: string },
  unprocessedCircuit: { bytecode: "0x" } as { bytecode?: string },
  classify: vi.fn(),
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
  getRefundableFrozenNotes: async () => [],
}))

const { FrozenRefundMigrationRuntime, readRefundableFrozenDeposits } = await import(
  "../../src/services/FrozenRefundMigrationRuntime.js"
)

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
    portal: { address },
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
