// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/front-core", async () => ({ runMetadataMigration }))

const chain = vi.hoisted(() => ({
  state: "0xsigned-over" as string,
  uses: 0,
  order: [] as string[],
  bootstrap: vi.fn(async (_o: { refund?: unknown }) => ({
    payload: {} as { refund?: unknown },
    sendOptions: {},
  })),
}))
vi.mock("../../sdk/dist/services/metadataMigration.js", async (original) => ({
  ...(await original<typeof import("../../sdk/dist/services/metadataMigration.js")>()),
  readMetadataDestinationState: async () => chain.state,
}))
vi.mock("../../sdk/dist/services/migrationBootstrap.js", () => ({
  prepareMigrationBootstrap: chain.bootstrap,
  claimFpcIdentitySubscribed: async () => false,
}))
vi.mock("../../sdk/dist/services/claimSponsor.js", () => ({
  claimFpcSubscriptionUses: async () => chain.uses,
  hasClaimFpcSubscription: async () => false,
}))
vi.mock("@oxide/l1-contracts", async (original) => ({
  ...(await original<typeof import("@oxide/l1-contracts")>()),
  encodeUserRecordMetadata: () => "0xrecord",
  userRecordStateHash: () => "0xcurrent",
}))

import {
  MetadataMigrationService,
  type MetadataMigrationSource,
} from "../../sdk/dist/services/MetadataMigrationService.js"

const OWNER = "0x00000000000000000000000000000000000000a1"
const REGISTRY = "0x00000000000000000000000000000000000000a2"
const NAME_PORTAL = "0x00000000000000000000000000000000000000a3"
const FPC = "0x00000000000000000000000000000000000000a4"
const SIPA = "0x00000000000000000000000000000000000000a5"

function fixture(options: Record<string, unknown>) {
  const fpc = { equals: () => true, toString: () => FPC }
  const resolve = vi.fn(async () => ({
    recipientHash: { toString: () => "0xrecipient" },
    recoveryCommitment: { toString: () => "0xrecovery" },
    messageSecret: { toString: () => "0xsecret" },
  }))
  const service = new MetadataMigrationService({
    source: options.source as MetadataMigrationSource,
    owner: OWNER,
    record: { rollupVersion: 7n },
    destination: {
      token: "0x00000000000000000000000000000000000000b0",
      rollupVersion: 7n,
      metadataRegistry: REGISTRY,
      namePortal: NAME_PORTAL,
      implementation: SIPA,
    },
    bootstrap: { fpcAddress: fpc, user: fpc, railId: 0 },
    registered: { fpcAddress: fpc, user: fpc, railId: 1 },
    selfResolver: { resolve },
    wallet: { node: { getNodeInfo: async () => ({ rollupVersion: 7 }) } },
    client: { getBlockNumber: async () => 100n },
    nameClaim: async () => ({ kind: "nameClaim" }),
    ...options,
  } as never)
  return { service }
}

beforeEach(() => {
  chain.state = "0xsigned-over"
  chain.uses = 0
  chain.order = []
})

vi.mock("../../front-core/dist/core/migration/runMetadataMigration", async (original) => {
  const real = await original<
    typeof import("../../front-core/dist/core/migration/runMetadataMigration")
  >()
  return {
    runMetadataMigration: (controller: any, options: any) =>
      real.runMetadataMigration(controller, { ...options, pollMs: 0 }),
  }
})
vi.mock("../../sdk/dist/services/migrationDeposit.js", () => ({
  migrationSipaCoordinates: () => ({ day: 1, nonce: ++nonce }),
  resolveMigrationDeposit: async (_c: unknown, day: number, n: number) => ({
    sipaAddress: `0x${String(day * 1000 + n).padStart(40, "0")}`,
    resolution: { messageSecret: {} },
  }),
  migrationDepositCalls: async () => [],
  // A frozen batch is a direct deposit: a commitment per coordinate, announced on L2.
  migrationDirectCommitment: async (_c: unknown, day: number, n: number) => ({
    recipientCommitment: `0x${String(day * 1000 + n).padStart(64, "0")}`,
    sharedSecret: BigInt(day * 1000 + n),
  }),
  migrationDirectAnnouncementCalls: async () => [],
}))
vi.mock("../../sdk/dist/feePaymentMethod/claimSponsoredCall.js", () => ({
  buildClaimSponsorPayload: async (o: { innerCalls: unknown[] }) => ({ refund: o.innerCalls[0] }),
}))
vi.mock("../../sdk/dist/feePaymentMethod/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: () => ({}),
}))
import { FrozenMetadataMigrationSource } from "../../sdk/dist/services/FrozenMetadataMigrationSource.js"
import { MetadataMigrationController } from "../../front-core/dist/core/migration/MetadataMigrationController"
import { runMetadataMigration } from "../../front-core/dist/core/migration/runMetadataMigration"
import { runMigrationQueue } from "../src/features/migration/runMigrationQueue"
import { ApprovalGate } from "../../front-core/dist/core/migration/savedApprovals"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
let nonce = 0
const DAI = "0x00000000000000000000000000000000000000b0"
const SUSDS = "0x00000000000000000000000000000000000000b1"

function mixedFixture(route: "other-token" | "same-token") {
  nonce = 0
  const durable = new Map<string, string>()
  const storage = {
    getItem: async (k: string) => durable.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      durable.set(k, v)
    },
  }
  const spent = new Set<string>()
  const sent: string[] = []
  const approvals: string[] = []
  const operations = new Map<string, unknown>()
  const broadcaster = {
    methods: new Proxy(
      {},
      {
        get: () => (target: { toString(): string }) => ({
          request: async () => ({ calls: [operations.get(target.toString())] }),
        }),
      },
    ),
  }
  const caches = new Map<string, Map<string, unknown>>()
  const fpc = { equals: () => true, toString: () => FPC }
  chain.bootstrap.mockImplementation(async (o: { refund?: unknown }) => ({
    payload: { refund: o.refund },
    sendOptions: {},
  }))
  const apply = (operation: any) => {
    const id = operation.id ?? operation.calldata.toString()
    spent.add(id)
    sent.push(id)
  }
  const wallet = {
    node: {
      getNodeInfo: async () => ({ rollupVersion: 7 }),
      getTxReceipt: async () => ({ status: "mined", executionResult: "success" }),
    },
    sendTx: async (payload: any, options: any) => {
      await options.onTxHash(`0x${String(sent.length + 1).padStart(64, "0")}`)
      apply(payload.refund)
      chain.state = "0xcurrent"
      chain.uses = 1
    },
  }
  const client = {
    getBlockNumber: async () => 100n,
    call: async () => ({}),
    getLogs: async () => [],
    // The destination portal's per-transaction cap, which bounds each direct deposit.
    readContract: async () => 10n ** 30n,
  }
  const destination = {
    token: DAI,
    portal: OWNER,
    factory: OWNER,
    rollupVersion: 7n,
    chainId: 31337n,
    metadataRegistry: REGISTRY,
    namePortal: NAME_PORTAL,
    implementation: SIPA,
  }
  const make = (id: string, recoveryOnly = false) => {
    const gate = new ApprovalGate()
    const asset = id === "savings" && route === "other-token" ? SUSDS : DAI
    let saved = caches.get(id)
    if (!saved) caches.set(id, (saved = new Map()))
    // Each source's refund goes through its own route; the subsidy names the operation.
    const subsidy = `0x${Buffer.from(id).toString("hex").padStart(40, "0")}`
    let proven: { amount: bigint; operation: unknown } | undefined
    const sourceRuntime = {
      identity: id,
      migration: {
        executor: subsidy,
        subsidy,
        payoutToken: asset,
        sourcePortal: subsidy,
        destinationPortal: OWNER,
      },
      minimumMigratedAmount: async () => 0n,
      assertMigrationReady: async () => {},
      candidates: async () => ({
        candidates: spent.has(id) ? [] : [{ id, kind: "note", amount: "100" }],
        maxNotesPerBatch: 2,
        maxBatchAmount: 1000n,
      }),
      validate: async () => {},
      refunded: async () => spent.has(id),
      // Proofs live in this runtime's memory, as a source generation's do: a restart proves again.
      build: async () => {
        if (proven) return proven
        gate.check()
        approvals.push(id)
        const operation = {
          id,
          target: EthAddress.fromString(subsidy),
          payoutToken: EthAddress.fromString(asset),
          calldata: Buffer.from(id),
          // `L1OperationCondition.immediate()`: no condition on the relay.
          condition: { kind: 0, token: EthAddress.ZERO, recipient: EthAddress.ZERO },
        }
        operations.set(subsidy, operation)
        return (proven = { amount: 100n, operation })
      },
    }
    const source = new FrozenMetadataMigrationSource({
      runtime: sourceRuntime,
      broadcaster,
      destinationAsset: asset,
      destination: { ...destination, token: asset },
      owner: OWNER,
      registered: { user: fpc, policy: {} },
      client,
      wallet,
      batches: {
        get: async (k: string) => saved!.get(k),
        set: async (k: string, v: unknown) => {
          saved!.set(k, structuredClone(v))
        },
      },
      received: async () => true,
      directDepositClaimed: async () => 0n,
    } as never)
    const service = fixture({
      source,
      recoveryOnly,
      wallet,
      client,
      destination,
      ...(asset === SUSDS ? { depositDestination: { ...destination, token: SUSDS } } : {}),
      received: async () => true,
      swept: async () => true,
    }).service
    vi.spyOn(service as any, "attestation").mockResolvedValue({ message: undefined })
    const controller = new MetadataMigrationController(
      storage,
      service as never,
      id,
      undefined,
      gate,
    )
    return { source, service, controller, saved }
  }
  return { make, spent, sent, approvals, durable }
}

// The real queue, runner, controller, service and frozen planner execute together, each frozen
// source moving only funds through its migration route.
// RPC responses, proof construction and chain inclusion are simulated. This is not an E2E sandbox.
describe.each(["other-token", "same-token"] as const)("mixed sources via %s", (route) => {
  it("sends both sources when metadata and sponsorship are already current", async () => {
    chain.state = "0xcurrent"
    chain.uses = 1
    const f = mixedFixture(route)
    // Every frozen source moves only funds.
    const jobs = [f.make("dai", true), f.make("savings", true)]
    const result = await runMigrationQueue(jobs, {
      signal: AbortSignal.timeout(1500),
      onActive: () => () => {},
      onPrepared: () => {},
      onArriving: () => {},
    })
    console.log(
      JSON.stringify({ route, alreadyCurrent: true, result, sent: f.sent, approvals: f.approvals }),
    )
    expect(result).toBe(true)
    expect(f.sent).toEqual(["dai", "savings"])
    expect(f.approvals).toEqual(["dai", "savings"])
  })
  it("restarts the second source under the real approval gate", async () => {
    // Funds-only runs follow the registration: it is current here.
    chain.state = "0xcurrent"
    chain.uses = 1
    const f = mixedFixture(route)
    const first = f.make("dai", true),
      second = f.make("savings", true)
    await first.controller.advance(true, undefined, { prepareOnly: true })
    await second.controller.advance(true, undefined, { prepareOnly: true })
    await runMetadataMigration(first.controller, {
      signal: AbortSignal.timeout(1500),
      prompts: false,
      pollMs: 0,
      untilArriving: true,
    })
    const approvalsBefore = [...f.approvals]
    const restarted = f.make("savings", true)
    await restarted.controller.load()
    const result = await runMetadataMigration(restarted.controller, {
      signal: AbortSignal.timeout(1500),
      prompts: false,
      pollMs: 0,
      untilArriving: true,
    })
    console.log(
      JSON.stringify({ route, restart: true, result, sent: f.sent, approvals: f.approvals }),
    )
    expect(result?.phase).toBe("needsApproval")
    expect(result?.stale).toBeUndefined()
    expect(f.sent).toEqual(["dai"])
    expect(f.approvals).toEqual(approvalsBefore)
  })
})
