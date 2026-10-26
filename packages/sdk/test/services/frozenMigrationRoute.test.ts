import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { decodeMigrationPayload } from "@oxide/oxide-lib/migration_executor.js"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { keccak256 } from "viem"

const h = vi.hoisted(() => ({
  frozenNotes: vi.fn(),
  buildNotesRefund: vi.fn(async (_ctx: unknown, _args: unknown) => "0xabcd" as `0x${string}`),
  readTerms: vi.fn(),
  readState: vi.fn(),
}))
vi.mock("@oxide/refund-proof/frozen_notes_refund/artifact.js", () => ({
  RefundCircuit: { bytecode: "0x" },
}))
vi.mock("@oxide/refund-proof/frozen_deposits_refund/artifact.js", () => ({
  FrozenDepositsRefundCircuit: { bytecode: "0x" },
}))
vi.mock("@oxide/refund-proof/unprocessed_deposit_refund/artifact.js", () => ({
  UnprocessedDepositRefundCircuit: { bytecode: "0x" },
}))
vi.mock("@oxide/oxide-client/frozen_notes.js", () => ({
  getRefundableFrozenNotes: h.frozenNotes,
}))
vi.mock("@oxide/oxide-lib/hash.js", () => ({
  computeNoteNullifier: async (provenNoteHash: Fr) => provenNoteHash,
}))
vi.mock("@oxide/oxide-client/sign_migration.js", () => ({
  assertRefundOwner: async () => {},
  signMigrationOf: async () => ({ kind: "fallbackKey" }),
}))
vi.mock("@oxide/oxide-client/atlatl/refund.js", () => ({
  buildRefundFrozenNotesCalldata: h.buildNotesRefund,
}))
vi.mock("@oxide/l1-contracts/migration.js", async (original) => ({
  ...(await original<typeof import("@oxide/l1-contracts/migration.js")>()),
  readMigrationSubsidyTerms: h.readTerms,
  readMigrationSubsidyState: h.readState,
}))

const { FrozenRefundMigrationRuntime, migrationRouteFor } = await import(
  "../../src/services/FrozenRefundMigrationRuntime.js"
)
const { MigrationSubsidyNotReadyError } = await import(
  "../../src/services/FrozenMetadataMigrationSource.js"
)

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const SOURCE = addr("51")
const DEST = addr("de")
const EXECUTOR = addr("e1")
const SUBSIDY = addr("5b")
const DAI = addr("da")
const PLAIN = addr("9a")
const COMMITMENT = new Fr(1234n).toString() as `0x${string}`
const NOW = 10_000n
const OPERATION_EXECUTOR = addr("0e")
const OPERATION_EXECUTOR_CODE = "0x6080604052" as const

const route = {
  executor: EXECUTOR,
  subsidy: SUBSIDY,
  payoutToken: DAI,
  sourcePortal: SOURCE,
  destinationPortal: DEST,
  operationExecutor: OPERATION_EXECUTOR,
}

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
  sourcePortal: SOURCE,
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
const executorView = (over: Record<string, string> = {}) =>
  ({ SUBSIDY: SUBSIDY, SOURCE_PORTAL: SOURCE, DESTINATION_PORTAL: DEST, ...over } as Record<
    string,
    string
  >)

function makeRuntime(
  migration?: typeof route,
  over: Record<string, unknown> = {},
  executor = executorView(),
) {
  const portalAddress = EthAddress.fromString(SOURCE)
  const rollup = EthAddress.fromString(addr("77"))
  const tokenAddress = AztecAddress.fromBigIntUnsafe(5n)
  const owner = { address: { equals: () => true, toString: () => "owner" } }
  const client = {
    getBlock: vi.fn(async () => ({ number: 1n, timestamp: NOW, baseFeePerGas: 10n ** 9n })),
    getGasPrice: vi.fn(async () => 2n * 10n ** 9n),
    getCode: vi.fn(async (_: { address: string }) => OPERATION_EXECUTOR_CODE as `0x${string}`),
    readContract: vi.fn(
      async ({ address, functionName }: { address: string; functionName: string }) => {
        if (address.toLowerCase() !== EXECUTOR) throw new Error(`unexpected read of ${address}`)
        return executor[functionName]
      },
    ),
  }
  const options = {
    node: {
      getNodeInfo: async () => ({
        nodeVersion: "6.0.0",
        rollupVersion: 1,
        l1ContractAddresses: { rollupAddress: rollup },
      }),
      getBlockNumber: async () => 10,
    },
    pxe: {},
    token: { address: tokenAddress },
    portal: {
      address: portalAddress,
      client,
      getTxAmountCap: async () => 10n ** 24n,
      getUnderlying: async () => EthAddress.fromString(addr("55")),
      getL2Token: async () => tokenAddress,
      getRollup: async () => rollup,
      getRollupVersion: async () => 1n,
      isFrozen: async () => true,
    },
    rollup: rollup.toString(),
    rollupVersion: 1n,
    owner,
    resolveSpendMetadata: async () => ({ masterNullifierHidingKey: new Fr(9n) }),
    depositMetadata: { ownerAddressPreimage: { address: owner.address } },
    depositDescriptors: async () => [],
    executor: EthAddress.fromString(PLAIN),
    tipRecipient: EthAddress.fromString(addr("0e")),
    ...(migration ? { migration } : {}),
    ...over,
  }
  return { runtime: new FrozenRefundMigrationRuntime(options as never), client, options }
}

const NOTE_ID = new Fr(11n).toString()

beforeEach(() => {
  h.frozenNotes.mockReset()
  h.frozenNotes.mockResolvedValue([{ provenNoteHash: new Fr(11n), amount: new Fr(1_000n) }])
  h.buildNotesRefund.mockClear()
  h.readTerms.mockReset()
  h.readState.mockReset()
  mockStatus(status())
})

describe("migrationRouteFor", () => {
  const deployment = (variables: Record<string, string>) => ({
    bridges: [{ id: "brg-susds-v6", portal: DEST }],
    features: [
      {
        id: "fea-migration-susds",
        project: "migration",
        bridges: { destination: "brg-susds-v6" },
        contracts: { migrationExecutor: EXECUTOR, migrationExecutorSubsidy: SUBSIDY },
        variables,
      },
    ],
  })

  it("takes the executor route when the destination publishes a feature for the source portal", () => {
    const found = migrationRouteFor(
      deployment({
        sourcePortal: SOURCE.toUpperCase().replace("0X", "0x"),
        payoutToken: DAI,
      }) as never,
      SOURCE,
      DEST,
      OPERATION_EXECUTOR,
    )
    expect(found).toEqual(route)
  })

  it("keeps the plain route for a source without a feature, or with no destination deployment", () => {
    expect(
      migrationRouteFor(
        deployment({ sourcePortal: addr("99"), payoutToken: DAI }) as never,
        SOURCE,
        DEST,
        OPERATION_EXECUTOR,
      ),
    ).toBeUndefined()
    expect(
      migrationRouteFor({ bridges: [] } as never, SOURCE, DEST, OPERATION_EXECUTOR),
    ).toBeUndefined()
    expect(migrationRouteFor(undefined, SOURCE, DEST, OPERATION_EXECUTOR)).toBeUndefined()
  })

  it("refuses a feature that deposits into another portal", () => {
    expect(() =>
      migrationRouteFor(
        deployment({ sourcePortal: SOURCE, payoutToken: DAI }) as never,
        SOURCE,
        addr("01"),
        OPERATION_EXECUTOR,
      ),
    ).toThrow("does not deposit into the destination portal")
  })
})

describe("FrozenRefundMigrationRuntime on the migration route", () => {
  it("targets the subsidy, pays out in the feature's token, and deposits under the commitment with no tip", async () => {
    const { runtime } = makeRuntime(route)
    const built = await runtime.build(
      { kind: "note", ids: [NOTE_ID] },
      { recipientCommitment: COMMITMENT },
      0n,
    )

    expect(built.amount).toBe(1_000n)
    expect(built.operation.target.toString().toLowerCase()).toBe(SUBSIDY)
    expect(built.operation.payoutToken.toString().toLowerCase()).toBe(DAI)
    expect(built.operation.calldata.toString("hex")).toBe("abcd")
    expect(built.operation.condition).toEqual(L1OperationCondition.immediate())
    const { executorCall } = h.buildNotesRefund.mock.calls[0]![1] as {
      executorCall: { executor: EthAddress; userPayload: Buffer; relayerPayload: Buffer }
    }
    expect(executorCall.executor.toString().toLowerCase()).toBe(EXECUTOR)
    expect(executorCall.userPayload).toHaveLength(64)
    expect(executorCall.relayerPayload).toHaveLength(20)
    expect(executorCall.relayerPayload.equals(Buffer.alloc(20))).toBe(true)
    const payload = decodeMigrationPayload(executorCall.userPayload)
    expect(payload.recipientCommitment.toString()).toBe(COMMITMENT)
    expect(payload.relayerTip).toBe(0n)
  })

  it("refuses a tip on a commitment refund", async () => {
    const { runtime } = makeRuntime(route)
    await expect(
      runtime.build({ kind: "note", ids: [NOTE_ID] }, { recipientCommitment: COMMITMENT }, 1n),
    ).rejects.toThrow("pays no relayer tip")
  })

  it("refunds an address through the plain executor on a source with a route, with no subsidy read", async () => {
    const USER = addr("a1")
    const { runtime } = makeRuntime(route, { tipRecipient: EthAddress.fromString(USER) })
    // Nothing address-related depends on the subsidy: even a failing read does not matter.
    h.readTerms.mockRejectedValue(new Error("subsidy down"))
    h.readState.mockRejectedValue(new Error("subsidy down"))
    const built = await runtime.build({ kind: "note", ids: [NOTE_ID] }, addr("33"), 5n)

    expect(built.amount).toBe(1_000n)
    expect(built.operation.target.toString().toLowerCase()).toBe(SOURCE)
    expect(built.operation.payoutToken.toString().toLowerCase()).toBe(addr("55"))
    expect(built.operation.condition).toEqual(L1OperationCondition.immediate())
    const { executorCall } = h.buildNotesRefund.mock.calls[0]![1] as {
      executorCall: { executor: EthAddress; relayerPayload: Buffer }
    }
    expect(executorCall.executor.toString().toLowerCase()).toBe(PLAIN)
    expect(`0x${executorCall.relayerPayload.toString("hex")}`).toBe(USER)
    expect(h.readTerms).not.toHaveBeenCalled()
    expect(h.readState).not.toHaveBeenCalled()

    // A commitment on the same runtime still takes the migration route.
    mockStatus(status())
    const direct = await runtime.build(
      { kind: "note", ids: [NOTE_ID] },
      { recipientCommitment: COMMITMENT },
      0n,
    )
    expect(direct.operation.target.toString().toLowerCase()).toBe(SUBSIDY)
  })

  it("refuses an address on a source with no plain withdrawal executor", async () => {
    const { runtime } = makeRuntime(route, { executor: EthAddress.ZERO })
    await expect(runtime.build({ kind: "note", ids: [NOTE_ID] }, addr("33"), 0n)).rejects.toThrow(
      "This source has no plain withdrawal executor, so it cannot refund to an address",
    )
    expect(h.buildNotesRefund).not.toHaveBeenCalled()
  })

  it("refuses a commitment on a source with no route", async () => {
    const { runtime } = makeRuntime()
    await expect(
      runtime.build({ kind: "note", ids: [NOTE_ID] }, { recipientCommitment: COMMITMENT }, 0n),
    ).rejects.toThrow(
      "No migration route serves this source, so it cannot refund under a commitment",
    )
    expect(h.buildNotesRefund).not.toHaveBeenCalled()
  })

  it("keeps the plain route's operation for a source without a feature", async () => {
    const { runtime } = makeRuntime()
    expect(runtime.migration).toBeUndefined()
    const built = await runtime.build({ kind: "note", ids: [NOTE_ID] }, addr("33"), 10n)

    expect(built.operation.target.toString().toLowerCase()).toBe(SOURCE)
    expect(built.operation.payoutToken.toString().toLowerCase()).toBe(addr("55"))
    const { executorCall } = h.buildNotesRefund.mock.calls[0]![1] as {
      executorCall: { executor: EthAddress }
    }
    expect(executorCall.executor.toString().toLowerCase()).toBe(PLAIN)
    expect(h.readTerms).not.toHaveBeenCalled()
    expect(h.readState).not.toHaveBeenCalled()
  })

  it("keeps one identity whether the destination adds, changes or removes the route", () => {
    const plain = makeRuntime().runtime.identity
    expect(makeRuntime(route).runtime.identity).toBe(plain)
    expect(
      makeRuntime({ ...route, executor: addr("01"), subsidy: addr("02") }).runtime.identity,
    ).toBe(plain)
  })

  it("reads the subsidy once for validation and proofs, and again right before a broadcast", async () => {
    const { runtime } = makeRuntime(route)
    await runtime.validate(addr("55"))
    // Validation compares only the terms: it reads no state.
    expect(h.readState).not.toHaveBeenCalled()
    await runtime.build({ kind: "note", ids: [NOTE_ID] }, { recipientCommitment: COMMITMENT }, 0n)
    expect(await runtime.minimumMigratedAmount()).toBe(100n)
    expect(h.readState).toHaveBeenCalledTimes(1)

    await runtime.assertMigrationReady({ kind: "note", ids: [NOTE_ID] }, 1_000n)
    expect(h.readState).toHaveBeenCalledTimes(2)
  })

  it("keeps the terms it read first, and takes only the state from a fresh read", async () => {
    const { runtime } = makeRuntime(route)
    await runtime.validate(addr("55"))
    // A fresh read that also reports other terms changes nothing but the state.
    mockStatus(status({ executor: addr("01"), gasCeilings: { frozenNotes: 0n }, balance: 0n }))
    await expect(
      runtime.assertMigrationReady({ kind: "note", ids: [NOTE_ID] }, 1_000n),
    ).rejects.toThrow("The fund that pays for moves is low. Try again later.")
    await runtime.validate(addr("55"))
    expect(h.readState).toHaveBeenCalledTimes(1)
  })

  it("reads the state once more when the kept state fails, so a funded pot clears without a new runtime", async () => {
    const { runtime } = makeRuntime(route)
    mockStatus(status({ balance: 0n }))
    await runtime.validate(addr("55"))
    expect(h.readState).not.toHaveBeenCalled()

    const build = () =>
      runtime.build({ kind: "note", ids: [NOTE_ID] }, { recipientCommitment: COMMITMENT }, 0n)
    await expect(build()).rejects.toThrow("The fund that pays for moves is low. Try again later.")
    expect(h.readState).toHaveBeenCalledTimes(2)

    mockStatus(status())
    await expect(build()).resolves.toMatchObject({ amount: 1_000n })
    expect(h.readState).toHaveBeenCalledTimes(3)
    // The refreshed state is kept: the next check reads nothing.
    await build()
    expect(h.readState).toHaveBeenCalledTimes(3)
  })

  it("surfaces the subsidy's reasons when it would not pay the relayer", async () => {
    const { runtime } = makeRuntime(route)
    mockStatus(
      status({
        balance: 0n,
        priceFeed: { address: addr("fe"), answer: 3000n * 10n ** 8n, decimals: 8, updatedAt: 1n },
      }),
    )
    const error = await runtime
      .assertMigrationReady({ kind: "note", ids: [NOTE_ID] }, 50n)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MigrationSubsidyNotReadyError)
    const { reasons, message } = error as InstanceType<typeof MigrationSubsidyNotReadyError>
    expect(reasons).toEqual([
      "The migrated amount 50 is below the subsidy minimum 100.",
      "The price feed answer is stale, so the subsidy pays nothing.",
      expect.stringContaining("The subsidy balance 0 is below the estimated payout"),
    ])
    // The user sees short messages with no amounts; the raw reasons stay on the error.
    expect(message).toBe(
      "This amount is too small to move. Price data is out of date. Try again later. The fund that pays for moves is low. Try again later.",
    )
    expect(message).not.toMatch(/\d{2,}/)
  })

  it("proves nothing while the subsidy would not pay", async () => {
    const { runtime } = makeRuntime(route)
    mockStatus(status({ sourceFrozen: false }))
    await expect(
      runtime.build({ kind: "note", ids: [NOTE_ID] }, { recipientCommitment: COMMITMENT }, 0n),
    ).rejects.toThrow("The old version is not closed yet.")
    // Checked before the refund is proven, so no prompt or proof is wasted.
    expect(h.buildNotesRefund).not.toHaveBeenCalled()
  })

  it("refuses a subsidy that serves another executor, portal or payout token", async () => {
    for (const over of [
      { executor: addr("01") },
      { sourcePortal: addr("01") },
      { destinationPortal: addr("01") },
      { token: addr("01") },
    ]) {
      mockStatus(status(over))
      await expect(makeRuntime(route).runtime.validate(addr("55"))).rejects.toThrow(
        "does not serve this source and destination",
      )
    }
  })

  it("refuses a route whose operation executor has another code than the subsidy pays", async () => {
    const { runtime, client } = makeRuntime(route)
    client.getCode.mockResolvedValue("0x60806040ff")
    await expect(runtime.validate(addr("55"))).rejects.toThrow(
      "The migration subsidy does not pay the relayer of this deployment",
    )
    expect(client.getCode).toHaveBeenCalledWith({ address: OPERATION_EXECUTOR })
  })

  it("reads the operation executor's code, the subsidy's terms and the executor's terms once", async () => {
    const { runtime, client } = makeRuntime(route)
    await runtime.validate(addr("55"))
    await runtime.validate(addr("55"))
    expect(client.getCode).toHaveBeenCalledTimes(1)
    expect(h.readTerms).toHaveBeenCalledTimes(1)
    expect(client.readContract.mock.calls.map(([call]) => call.functionName).sort()).toEqual([
      "DESTINATION_PORTAL",
      "SOURCE_PORTAL",
      "SUBSIDY",
    ])
  })

  it("refuses an executor that names another subsidy, source portal or destination portal", async () => {
    for (const over of [
      { SUBSIDY: addr("01") },
      { SOURCE_PORTAL: addr("01") },
      { DESTINATION_PORTAL: addr("01") },
    ]) {
      await expect(
        makeRuntime(route, {}, executorView(over)).runtime.validate(addr("55")),
      ).rejects.toThrow("The migration executor does not use this subsidy, source and destination")
    }
  })
})
