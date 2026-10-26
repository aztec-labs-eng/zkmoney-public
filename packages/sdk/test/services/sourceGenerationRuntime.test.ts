import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { SourceExecutorCall, SourceRefundRuntime } from "@obsidion/core/types"
import { L1OperationConditionKind } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { decodeMigrationPayload } from "@oxide/oxide-lib/migration_executor.js"
import { keccak256 } from "viem"

const h = vi.hoisted(() => ({ readTerms: vi.fn(), readState: vi.fn() }))
vi.mock("@oxide/l1-contracts/migration.js", async (original) => ({
  ...(await original<typeof import("@oxide/l1-contracts/migration.js")>()),
  readMigrationSubsidyTerms: h.readTerms,
  readMigrationSubsidyState: h.readState,
}))

const { frozenRuntimeFromSourceGeneration } = await import(
  "../../src/services/sourceGenerationRuntime.js"
)
const { MigrationSubsidyNotReadyError } = await import(
  "../../src/services/FrozenMetadataMigrationSource.js"
)

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const PORTAL = addr("11")
const DAI = addr("22")
const RECIPIENT = addr("33")
const DEST = addr("de")
const EXECUTOR = addr("e1")
const SUBSIDY = addr("5b")
const COMMITMENT = new Fr(1234n).toString() as `0x${string}`
const NOW = 10_000n

const PLAIN_CALL: SourceExecutorCall = {
  executor: addr("9a"),
  userPayload: `0x${"01".repeat(64)}`,
  relayerPayload: `0x${"02".repeat(64)}`,
}

function source(calldata = "0xabcd", amount = "500"): SourceRefundRuntime {
  return {
    identity: "v5-identity",
    validate: vi.fn(async () => {}),
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 10,
      maxBatchAmount: "2583000000000000000000",
      candidates: [{ id: "0x01", amount, kind: "note" as const }],
    })),
    plainExecutorCall: vi.fn(async () => PLAIN_CALL),
    build: vi.fn(async () => ({
      amount,
      operation: { target: PORTAL, payoutToken: DAI, calldata },
    })),
    refunded: vi.fn(async () => true),
  }
}

const route = {
  executor: EXECUTOR,
  subsidy: SUBSIDY,
  payoutToken: DAI,
  sourcePortal: PORTAL,
  destinationPortal: DEST,
  operationExecutor: addr("0e"),
}
const OPERATION_EXECUTOR_CODE = "0x6080604052"

const status = (over: Record<string, unknown> = {}) => ({
  subsidy: SUBSIDY,
  token: DAI,
  tokenDecimals: 18,
  balance: 10n ** 21n,
  config: {
    targetRelayerProfit: 10n ** 18n,
    maxSubsidyPerOperation: 10n ** 20n,
    minMigratedAmount: 100n,
  },
  sourcePortal: PORTAL,
  sourceFrozen: true,
  destinationPortal: DEST,
  executor: EXECUTOR,
  operationExecutorCodeHash: keccak256(OPERATION_EXECUTOR_CODE),
  gasCeilings: { withdrawal: 1n, frozenNotes: 500_000n, frozenDeposit: 1n, unprocessedDeposit: 1n },
  freshBalanceGas: 30_000n,
  priceFeed: { address: addr("fe"), answer: 3000n * 10n ** 8n, decimals: 8, updatedAt: NOW - 60n },
  ...over,
})

const TERM_FIELDS = [
  "subsidy",
  "token",
  "tokenDecimals",
  "sourcePortal",
  "destinationPortal",
  "executor",
  "operationExecutorCodeHash",
  "gasCeilings",
  "freshBalanceGas",
] as const
/** Split a merged status fixture into the two reads of the split oxide API. */
const mockStatus = (s: Record<string, unknown>) => {
  const feed = s.priceFeed as {
    address: string
    decimals: number
    answer: bigint
    updatedAt: bigint
  }
  h.readTerms.mockResolvedValue({
    ...Object.fromEntries(TERM_FIELDS.map((k) => [k, s[k]])),
    priceFeed: { address: feed.address, decimals: feed.decimals },
  })
  h.readState.mockResolvedValue({
    balance: s.balance,
    config: s.config,
    sourceFrozen: s.sourceFrozen,
    priceFeed: { answer: feed.answer, updatedAt: feed.updatedAt },
  })
}

/** What the `MigrationExecutor` reports about itself. */
const EXECUTOR_VIEW: Record<string, string> = {
  SUBSIDY,
  SOURCE_PORTAL: PORTAL,
  DESTINATION_PORTAL: DEST,
}

const migration = () => ({
  route,
  client: {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName in EXECUTOR_VIEW ? EXECUTOR_VIEW[functionName] : undefined,
    ),
    getBlock: vi.fn(async () => ({ number: 1n, timestamp: NOW, baseFeePerGas: 10n ** 9n })),
    getGasPrice: vi.fn(async () => 2n * 10n ** 9n),
    getCode: vi.fn(async () => OPERATION_EXECUTOR_CODE),
  } as never,
})

const note = { kind: "note" as const, ids: ["0x01"] }

beforeEach(() => {
  h.readTerms.mockReset()
  h.readState.mockReset()
  mockStatus(status())
})

describe("frozenRuntimeFromSourceGeneration", () => {
  it("reads amounts back as bigints and passes plain arguments through", async () => {
    const plain = source()
    const runtime = frozenRuntimeFromSourceGeneration(plain)
    expect(runtime.identity).toBe("v5-identity")
    expect(runtime.migration).toBeUndefined()
    expect(runtime.assertMigrationReady).toBeUndefined()
    await expect(runtime.candidates({ fresh: true })).resolves.toMatchObject({
      maxBatchAmount: 2583000000000000000000n,
    })
    expect(plain.candidates).toHaveBeenCalledWith({ fresh: true })
    await runtime.validate(DAI as never)
    expect(plain.validate).toHaveBeenCalledWith(DAI)
    await expect(runtime.refunded(["0x01"])).resolves.toBe(true)
  })

  it("reads waiting deposits back as a bigint and keeps each payment link's escrow", async () => {
    const plain = source()
    vi.mocked(plain.candidates).mockResolvedValueOnce({
      maxNotesPerBatch: 10,
      maxBatchAmount: "100",
      waiting: "7",
      candidates: [],
    })
    await expect(frozenRuntimeFromSourceGeneration(plain).candidates()).resolves.toEqual({
      maxNotesPerBatch: 10,
      maxBatchAmount: 100n,
      waiting: 7n,
      candidates: [],
    })
    const link = { id: "0x02", amount: "4", kind: "escrow-note" as const, owner: "0xescrow" }
    vi.mocked(plain.candidates).mockResolvedValueOnce({
      maxNotesPerBatch: 10,
      maxBatchAmount: "100",
      candidates: [link],
    })
    const read = await frozenRuntimeFromSourceGeneration(plain).candidates()
    expect(read.candidates).toEqual([link])
    expect(read).not.toHaveProperty("waiting")
  })

  it("refunds an address through the generation's plain executor call", async () => {
    const plain = source()
    const built = await frozenRuntimeFromSourceGeneration(plain).build(note, RECIPIENT, 3n)
    expect(plain.plainExecutorCall).toHaveBeenCalledWith(RECIPIENT, "3")
    expect(plain.build).toHaveBeenCalledWith(note, PLAIN_CALL)
    expect(built.amount).toBe(500n)
    expect(built.operation.target.toString()).toBe(PORTAL)
    expect(built.operation.payoutToken.toString()).toBe(DAI)
    expect(built.operation.calldata).toEqual(Buffer.from("abcd", "hex"))
    expect(built.operation.condition.kind).toBe(L1OperationConditionKind.Immediate)
  })

  it("refuses a commitment without a migration route", async () => {
    const plain = source()
    await expect(
      frozenRuntimeFromSourceGeneration(plain).build(note, { recipientCommitment: COMMITMENT }, 0n),
    ).rejects.toThrow(/No migration route serves this source/)
    expect(plain.build).not.toHaveBeenCalled()
  })

  it("checks on this side that the amount covers the tip", async () => {
    await expect(
      frozenRuntimeFromSourceGeneration(source("0xabcd", "3")).build(note, RECIPIENT, 3n),
    ).rejects.toThrow(/cannot cover its relayer tip/)
    const plain = source()
    await expect(
      frozenRuntimeFromSourceGeneration(plain).build(note, RECIPIENT, -1n),
    ).rejects.toThrow(/cannot cover its relayer tip/)
    expect(plain.build).not.toHaveBeenCalled()
  })

  it("refuses calldata or an executor call that is not hex", async () => {
    await expect(
      frozenRuntimeFromSourceGeneration(source("abcd")).build(note, RECIPIENT, 3n),
    ).rejects.toThrow(/malformed calldata/)
    const plain = source()
    vi.mocked(plain.plainExecutorCall).mockResolvedValueOnce({ ...PLAIN_CALL, userPayload: "01" })
    await expect(
      frozenRuntimeFromSourceGeneration(plain).build(note, RECIPIENT, 3n),
    ).rejects.toThrow(/malformed executor call/)
    expect(plain.build).not.toHaveBeenCalled()
  })

  it("does not open another source approval after the upgrade queue is prepared", async () => {
    const plain = source()
    const runtime = frozenRuntimeFromSourceGeneration(plain, () => {
      throw new Error("approval required")
    })
    await expect(runtime.build(note, RECIPIENT, 3n)).rejects.toThrow("approval required")
    expect(plain.build).not.toHaveBeenCalled()
  })
})

describe("frozenRuntimeFromSourceGeneration on a migration route", () => {
  it("refunds a commitment through the migration executor with no tip", async () => {
    const plain = source()
    const runtime = frozenRuntimeFromSourceGeneration(plain, undefined, migration())
    expect(runtime.migration).toEqual(route)
    // The route is bound per batch, so the generation's identity stays.
    expect(runtime.identity).toBe("v5-identity")
    const built = await runtime.build(note, { recipientCommitment: COMMITMENT }, 0n)
    expect(plain.plainExecutorCall).not.toHaveBeenCalled()
    const [, call] = vi.mocked(plain.build).mock.calls[0]!
    expect(call.executor.toLowerCase()).toBe(EXECUTOR)
    const userPayload = Buffer.from(call.userPayload.slice(2), "hex")
    expect(userPayload).toHaveLength(64)
    expect(decodeMigrationPayload(userPayload)).toEqual({
      recipientCommitment: Fr.fromString(COMMITMENT),
      relayerTip: 0n,
    })
    expect(call.relayerPayload).toBe(`0x${"00".repeat(20)}`)
    expect(built.amount).toBe(500n)
    expect(built.operation.target.toString()).toBe(SUBSIDY)
    expect(built.operation.payoutToken.toString()).toBe(DAI)
    expect(built.operation.calldata).toEqual(Buffer.from("abcd", "hex"))
  })

  it("refunds an address through the plain executor with a route present, with no subsidy read", async () => {
    const plain = source()
    h.readTerms.mockRejectedValue(new Error("subsidy down"))
    h.readState.mockRejectedValue(new Error("subsidy down"))
    const runtime = frozenRuntimeFromSourceGeneration(plain, undefined, migration())
    const built = await runtime.build(note, RECIPIENT, 3n)

    expect(plain.plainExecutorCall).toHaveBeenCalledWith(RECIPIENT, "3")
    expect(vi.mocked(plain.build).mock.calls[0]![1]).toEqual(PLAIN_CALL)
    expect(built.operation.target.toString()).toBe(PORTAL)
    expect(built.operation.payoutToken.toString()).toBe(DAI)
    expect(built.operation.condition.kind).toBe(L1OperationConditionKind.Immediate)
    expect(h.readTerms).not.toHaveBeenCalled()
    expect(h.readState).not.toHaveBeenCalled()
  })

  it("refuses a tip on a commitment, and a refund of another portal", async () => {
    const runtime = frozenRuntimeFromSourceGeneration(source(), undefined, migration())
    await expect(runtime.build(note, { recipientCommitment: COMMITMENT }, 1n)).rejects.toThrow(
      /pays no relayer tip/,
    )
    const other = source()
    vi.mocked(other.build).mockResolvedValueOnce({
      amount: "500",
      operation: { target: addr("44"), payoutToken: DAI, calldata: "0xabcd" },
    })
    await expect(
      frozenRuntimeFromSourceGeneration(other, undefined, migration()).build(
        note,
        { recipientCommitment: COMMITMENT },
        0n,
      ),
    ).rejects.toThrow(/route's source portal/)
  })

  it("validates the subsidy against the route", async () => {
    await frozenRuntimeFromSourceGeneration(source(), undefined, migration()).validate(DAI)
    mockStatus(status({ executor: addr("e2") }))
    await expect(
      frozenRuntimeFromSourceGeneration(source(), undefined, migration()).validate(DAI),
    ).rejects.toThrow(/does not serve this source/)
  })

  it("reports a subsidy that does not pay, and its minimum", async () => {
    mockStatus(status({ sourceFrozen: false }))
    const runtime = frozenRuntimeFromSourceGeneration(source(), undefined, migration())
    await expect(runtime.minimumMigratedAmount!()).resolves.toBe(100n)
    await expect(runtime.assertMigrationReady!(note, 500n)).rejects.toBeInstanceOf(
      MigrationSubsidyNotReadyError,
    )
    await expect(
      runtime.build(note, { recipientCommitment: COMMITMENT }, 0n),
    ).rejects.toBeInstanceOf(MigrationSubsidyNotReadyError)
  })

  it("checks the subsidy for the selection's amount before any approval or proof", async () => {
    mockStatus(status({ sourceFrozen: false }))
    const plain = source()
    const beforeBuild = vi.fn()
    const runtime = frozenRuntimeFromSourceGeneration(plain, beforeBuild, migration())
    await expect(
      runtime.build(note, { recipientCommitment: COMMITMENT }, 0n),
    ).rejects.toBeInstanceOf(MigrationSubsidyNotReadyError)
    expect(plain.candidates).toHaveBeenCalled()
    expect(beforeBuild).not.toHaveBeenCalled()
    expect(plain.build).not.toHaveBeenCalled()
  })

  it("checks the amount from the candidates: below the minimum, or gone, nothing is proven", async () => {
    const small = source("0xabcd", "50")
    await expect(
      frozenRuntimeFromSourceGeneration(small, undefined, migration()).build(
        note,
        { recipientCommitment: COMMITMENT },
        0n,
      ),
    ).rejects.toThrow("This amount is too small to move.")
    expect(small.build).not.toHaveBeenCalled()

    const gone = source()
    await expect(
      frozenRuntimeFromSourceGeneration(gone, undefined, migration()).build(
        { kind: "note", ids: ["0x09"] },
        { recipientCommitment: COMMITMENT },
        0n,
      ),
    ).rejects.toThrow("no longer refundable")
    expect(gone.build).not.toHaveBeenCalled()
  })

  it("refuses a proof whose amount is not the amount it checked", async () => {
    const plain = source()
    vi.mocked(plain.build).mockResolvedValueOnce({
      amount: "499",
      operation: { target: PORTAL, payoutToken: DAI, calldata: "0xabcd" },
    })
    await expect(
      frozenRuntimeFromSourceGeneration(plain, undefined, migration()).build(
        note,
        { recipientCommitment: COMMITMENT },
        0n,
      ),
    ).rejects.toThrow("not the selection's amount")
  })

  it("refuses an executor that does not name the route's subsidy", async () => {
    const m = migration()
    vi.mocked(
      (m.client as { readContract: ReturnType<typeof vi.fn> }).readContract,
    ).mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === "SUBSIDY" ? addr("01") : EXECUTOR_VIEW[functionName],
    )
    await expect(
      frozenRuntimeFromSourceGeneration(source(), undefined, m).validate(DAI),
    ).rejects.toThrow(/migration executor does not use this subsidy/)
  })
})
