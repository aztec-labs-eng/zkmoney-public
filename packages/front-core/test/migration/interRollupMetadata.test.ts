// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress, EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { TxExecutionResult, TxStatus } from "@aztec/stdlib/tx"
import { privateKeyToAccount } from "viem/accounts"
import { zeroHash, type Address, type Hex } from "viem"
import {
  decodeMetadataUpdateIntentData,
  decodeUserRecordMetadata,
  userRecordStateHash,
} from "@oxide/l1-contracts"
import {
  MetadataMigrationService,
  type MetadataMigrationServiceOptions,
} from "../../../sdk/src/services/MetadataMigrationService.js"
import {
  FrozenMetadataMigrationSource,
  type FrozenMigrationRuntime,
  type FrozenRefundCandidate,
} from "../../../sdk/src/services/FrozenMetadataMigrationSource.js"
import { SipaSelfResolver } from "../../../sdk/src/services/sipaSelfResolve.js"
import { selfSipaResolverKeys } from "../../src/oxide/oxideAccountKeys"
import { MetadataMigrationController } from "../../src/core/migration/MetadataMigrationController"
import { WITHDRAW_RELAYER_TIP as TIP } from "@obsidion/core/constants"
import type { MigrationFundingBatch } from "@obsidion/core/types"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"

// Real wallet codecs, bootstrap assembly, source adapter and durable driver. Contract responses
// and source proofs are synthetic. This does not implement or claim compatibility with Aztec v6.
const chain = vi.hoisted(() => ({
  recurring: false,
  attestation: false,
  /** The SIPAs whose every sweep the deposit rail has claimed. */
  received: new Set<string>(),
  subscribe: vi.fn(async (args) => ({ calls: args.innerCalls, gate: args.gate })),
  sponsor: vi.fn(async (args) => ({ calls: args.innerCalls })),
}))
vi.mock("../../../sdk/src/feePaymentMethod/claimSponsoredCall.js", () => ({
  buildClaimSubscribePayload: chain.subscribe,
  buildClaimSponsorPayload: chain.sponsor,
}))
vi.mock("../../../sdk/src/feePaymentMethod/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: () => ({}),
}))
vi.mock("../../../sdk/src/services/claimSponsor.js", () => ({
  claimFpcSubscriptionUses: async () => (chain.recurring ? 10 : 0),
  hasClaimFpcSubscription: async () => chain.recurring,
}))
vi.mock("../../../sdk/src/services/registrationMessage.js", () => ({
  REGISTRATION_MESSAGE_SECRET: 1,
  registrationInbox: () => ({}),
  findRegistrationMessage: async () =>
    chain.attestation ? { status: "consumable", leafIndex: 3n } : undefined,
}))
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const field = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex
const token = addr(50),
  metadataSipa = addr(60),
  depositSipa = addr(61),
  sourcePortal = addr(70),
  depositSubsidy = addr(71)

function fixture() {
  const destination = {
    chainId: 31337n,
    rollupVersion: 60001n,
    nameRegistry: addr(1),
    metadataRegistry: addr(2),
    controller: addr(3),
    factory: addr(4),
    portal: addr(5),
    implementation: addr(6),
    namePortal: addr(7),
    token,
    depositSubsidy,
    operationExecutor: addr(72),
  }
  const user = AztecAddress.fromStringUnsafe(field(12)),
    fpcAddress = AztecAddress.fromStringUnsafe(field(14))
  const resolver = new SipaSelfResolver(selfSipaResolverKeys(new Fr(123n)))
  const record = {
    l2Address: field(12),
    rollupVersion: 60001n,
    publicKey: resolver.userPublicKey,
    resolverOperator: addr(13),
  }
  const state = {
    hash: zeroHash as Hex,
    registry: destination.metadataRegistry,
    bootstrapSpent: false,
    included: false,
  }
  const readContract = vi.fn(
    async ({
      address,
      functionName,
      args,
    }: {
      address: Address
      functionName: string
      args?: any[]
    }) => {
      switch (functionName) {
        case "accountMetadataRegistry":
          return state.registry
        case "registrationController":
          return destination.controller
        case "implementationFor":
          return args?.[1] === 3 ? destination.implementation : addr(8)
        case "nameOf":
          return field(9)
        case "metadataStateHash":
          return state.hash
        case "predictSIPA":
          return args?.[0] === destination.implementation ? metadataSipa : depositSipa
        case "depositFee":
          return address === destination.implementation ? 5n : 2n
        case "FPC_FUNDING_CUT":
          return 0n
        // The deposit subsidy deploys and sweeps the SIPA it derives from these.
        case "PORTAL":
          return destination.portal
        case "SIPA_FACTORY":
          return destination.factory
        case "ROLLUP_VERSION":
          return destination.rollupVersion
        case "isValidSignature":
          return "0x1626ba7e"
        default:
          throw new Error(`Unexpected destination read ${functionName}`)
      }
    },
  )
  const client = {
    getChainId: async () => 31337,
    getBlockNumber: async () => 1n,
    readContract,
    getCode: async () => "0x",
    call: vi.fn(async () => ({})),
  }
  const sends: any[] = []
  const wallet = {
    node: {
      getNodeInfo: vi.fn(async () => ({
        rollupVersion: 60001,
        l1ContractAddresses: {
          rollupAddress: EthAddress.fromString(addr(90)),
          inboxAddress: EthAddress.fromString(addr(91)),
        },
      })),
      findLeavesIndexes: async () => [state.bootstrapSpent ? { index: 1n } : undefined],
      getTxReceipt: async () =>
        state.included
          ? { status: TxStatus.PROVEN, executionResult: TxExecutionResult.SUCCESS }
          : { status: TxStatus.DROPPED },
    },
    sendTx: vi.fn(async (payload, options) => {
      await options.onTxHash(field(80 + sends.length))
      sends.push(payload)
      return { txHash: field(79 + sends.length) }
    }),
  }
  const calls = {
    methods: new Proxy(
      {},
      {
        get:
          (_target, name: string) =>
          (...args: any[]) => ({ request: async () => ({ calls: [{ name, args }] }) }),
      },
    ),
  }
  const spent = new Set<string>()
  const candidates: FrozenRefundCandidate[] = [
    { id: "first", amount: String(30n * TIP), kind: "note" },
    { id: "last", amount: String(20n * TIP), kind: "note" },
  ]
  const runtime: FrozenMigrationRuntime = {
    identity: JSON.stringify({
      rollup: addr(92),
      rollupVersion: 50001,
      portal: sourcePortal,
      generation: "source-test-runtime",
    }),
    validate: vi.fn(async () => {}),
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 1,
      maxBatchAmount: 1000n * TIP,
      candidates: candidates.filter((c) => !spent.has(c.id)),
    })),
    build: vi.fn(async ({ ids }, _recipient, _tip) => ({
      amount: BigInt(candidates.find((c) => c.id === ids[0])!.amount),
      operation: {
        target: EthAddress.fromString(sourcePortal),
        payoutToken: EthAddress.fromString(token),
        calldata: Buffer.from(field(ids[0] === "first" ? 100 : 101).slice(2), "hex"),
        condition: L1OperationCondition.immediate(),
      },
    })),
    refunded: vi.fn(async (ids: string[]) => ids.every((id) => spent.has(id))),
  }
  const batches = new Map<string, MigrationFundingBatch>()
  const tokenService = { ensureSweptDeposit: vi.fn(async () => {}) }
  const received = async (sipa: string) => chain.received.has(sipa)
  // This chain claims a sweep as it lands.
  const swept = received
  const registered = { user, fpcAddress, railId: 2, policy: {}, fpcArtifact: {} }
  const makeSource = () =>
    new FrozenMetadataMigrationSource({
      runtime,
      destinationAsset: token,
      client,
      wallet,
      destination,
      owner: addr(11),
      selfResolver: resolver,
      token: calls,
      tokenService,
      broadcaster: calls,
      registered,
      received,
      swept,
      batches: {
        get: async (id: string) => structuredClone(batches.get(id)),
        set: async (id: string, batch: MigrationFundingBatch) => {
          batches.set(id, structuredClone(batch))
        },
      },
    } as unknown as ConstructorParameters<typeof FrozenMetadataMigrationSource>[0])
  const signConsent = vi.fn((hash: Hex) => privateKeyToAccount(field(123)).sign({ hash }))
  const options = {
    client,
    wallet,
    destination,
    owner: addr(11),
    record,
    selfResolver: resolver,
    token: calls,
    broadcaster: calls,
    tokenService,
    bootstrap: { ...registered, railId: 1 },
    registered,
    received,
    swept,
    nameClaim: async () => ({ kind: "nameClaim" }),
    bindingWitness: async () => ({}),
    signConsent,
  }
  let raw: string | null = null
  const storage = {
    getItem: async () => raw,
    setItem: async (_key: string, value: string) => {
      raw = value
    },
  }
  const make = () => {
    const source = makeSource()
    const service = new MetadataMigrationService({
      ...options,
      source,
    } as unknown as MetadataMigrationServiceOptions)
    return {
      source,
      service,
      controller: new MetadataMigrationController(storage, service, "future-rollup"),
    }
  }
  return {
    ...make(),
    make,
    state,
    options,
    runtime,
    batches,
    spent,
    candidates,
    sends,
    tokenService,
    signConsent,
    readContract,
    wallet,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  chain.recurring = chain.attestation = false
  chain.received.clear()
})

describe("inter-rollup wallet behavior against a synthetic future destination", () => {
  it("restarts through frozen refunds, new metadata, subscription and an ordinary remaining deposit", async () => {
    const f = fixture()
    let { controller } = f
    // What the quote says moves is what the run refunds below: both notes.
    const quoted = await f.service.quote()
    expect(quoted).toMatchObject({ movable: 50n * TIP, stranded: 0n, waiting: 0n, batches: 2 })
    await controller.advance(true)
    expect(controller.getSnapshot()?.error).toBeUndefined()
    expect(f.sends).toHaveLength(1)
    const intent = decodeMetadataUpdateIntentData(
      JSON.parse(controller.getSnapshot()!.plan!).intentData,
    )
    expect(intent).toMatchObject({
      owner: addr(11),
      metadataRegistry: addr(2),
      rollupVersion: 60001n,
      namePortal: addr(7),
      namePortalRecipient: field(14),
      expectedStateHash: zeroHash,
    })
    expect(decodeUserRecordMetadata(intent.metadata)).toEqual(f.options.record)
    // The bootstrap takes the smallest covering batch, so later batches stay affordable.
    expect(f.runtime.build).toHaveBeenCalledWith({ kind: "note", ids: ["last"] }, metadataSipa, TIP)
    // The source refund, the metadata SIPA's event, and its deploy-and-sweep through the subsidy.
    expect(f.sends[0].calls.map((call: any) => call.name)).toEqual([
      expect.stringContaining("broadcast_l1_operation"),
      "notify_sipa_recipient",
      expect.stringContaining("broadcast_l1_operation"),
    ])
    expect(f.sends[0].gate.kind).toBe("nameClaim")
    expect(f.sends[0].calls[0].args[0].toString()).toBe(sourcePortal)
    expect(f.sends[0].calls[1].args[2]).toBe(false)
    expect(f.sends[0].calls[2].args[0].toString()).toBe(depositSubsidy)
    controller = f.make().controller
    await controller.load()
    await controller.advance()
    expect(f.sends).toHaveLength(1)
    expect(f.signConsent).toHaveBeenCalledTimes(1)
    f.state.included = f.state.bootstrapSpent = true
    await controller.advance()
    expect(controller.getSnapshot()?.phase).toBe("awaitingMessages")
    expect(chain.sponsor).not.toHaveBeenCalled()
    // The published refund is still on the source until it executes, and counts once.
    expect((await f.service.quote({ firstBatchSettled: true })).movable).toBe(50n * TIP)
    f.spent.add("last")
    expect((await f.service.quote({ firstBatchSettled: true })).movable).toBe(30n * TIP)
    f.state.hash = userRecordStateHash(f.options.record)
    chain.received.add(metadataSipa)
    await controller.advance()
    expect(f.sends).toHaveLength(1) // Deposit alone cannot activate registration.
    chain.attestation = true
    await controller.advance()
    expect(f.sends).toHaveLength(2)
    expect(f.sends[1].gate.kind).toBe("registration")
    controller = f.make().controller
    await controller.load()
    await controller.advance()
    expect(f.sends).toHaveLength(2)
    chain.recurring = true
    await controller.advance()
    expect(controller.getSnapshot()?.phase).toBe("recovering")
    expect(f.sends).toHaveLength(3)
    expect(f.runtime.build).toHaveBeenCalledWith({ kind: "note", ids: ["first"] }, depositSipa, TIP)
    expect(f.sends[2].calls.map((call: any) => call.name)).toEqual([
      expect.stringContaining("broadcast_l1_operation"),
      "notify_sipa_recipient",
      expect.stringContaining("broadcast_l1_operation"),
    ])
    expect(chain.sponsor).toHaveBeenCalledTimes(1)
    expect(f.sends[2].calls[0].args[0].toString()).toBe(sourcePortal)
    expect(f.sends[2].calls[1].args[2]).toBe(true)
    expect(f.sends[2].calls[2].args[0].toString()).toBe(depositSubsidy)
    expect(f.signConsent).toHaveBeenCalledTimes(1)
    f.spent.add("first")
    controller = f.make().controller
    await controller.load()
    await controller.advance()
    // Every planned batch is sent; source spentness is not a receipt.
    expect(controller.getSnapshot()?.phase).toBe("arriving")
    expect(f.sends).toHaveLength(3)
    chain.received.add(depositSipa)
    await controller.advance()
    await controller.advance()
    expect(controller.getSnapshot()).toMatchObject({ phase: "done", allowance: "registered" })
    // The rail claims; the migration only reads.
    expect(f.tokenService.ensureSweptDeposit).not.toHaveBeenCalled()
    expect(f.batches.get("remaining-0")?.received).toBe(true)
    expect(f.readContract.mock.calls.some(([call]) => call.functionName === "userRecords")).toBe(
      false,
    )
    // The proof runtime has no transaction submission API; all three sends use the destination.
    expect(f.wallet.sendTx).toHaveBeenCalledTimes(3)
    const refunded = new Set(vi.mocked(f.runtime.build).mock.calls.flatMap(([batch]) => batch.ids))
    const amount = (id: string) => BigInt(f.candidates.find((c) => c.id === id)!.amount)
    expect([...refunded].reduce((sum, id) => sum + amount(id), 0n)).toBe(quoted.movable)
  })
  it("proves every batch up front and sends them in one pass when the record is already current", async () => {
    const f = fixture()
    f.state.hash = userRecordStateHash(f.options.record)
    chain.recurring = true
    await f.controller.advance(true)
    expect(f.controller.getSnapshot()?.error).toBeUndefined()
    expect(f.controller.getSnapshot()?.phase).toBe("recovering")
    expect(f.runtime.build).toHaveBeenCalledTimes(2)
    expect(f.sends).toHaveLength(2)
    expect(f.signConsent).toHaveBeenCalledTimes(1)
  })

  it("holds an unmigrated account to the metadata fee and a settled one to the ordinary fee", async () => {
    // Metadata fee 5, ordinary fee 2, read on chain: no local migration record exists.
    const f = fixture()
    f.candidates.splice(0, 2, { id: "deposit", amount: String(TIP + 4n), kind: "frozen-deposit" })
    expect(await f.service.movable()).toBe(false)
    f.state.hash = userRecordStateHash(f.options.record)
    chain.recurring = true
    expect(await f.service.movable()).toBe(true)
    chain.recurring = false
    f.candidates[0]!.amount = String(TIP + 6n)
    expect(await f.service.movable()).toBe(true)
  })

  it("quotes a remainder between the two fees as movable once the first refund has settled", async () => {
    // Metadata fee 5, ordinary fee 2: recurring sponsorship is not active yet.
    const f = fixture()
    f.candidates.splice(0, 2, { id: "rest", amount: String(TIP + 4n), kind: "note" })
    expect(await f.service.quote()).toMatchObject({ movable: 0n, stranded: TIP + 4n, waiting: 0n })
    expect((await f.service.quote({ firstBatchSettled: true })).movable).toBe(TIP + 4n)
  })

  it("rejects a destination node mismatch before consent or source proving", async () => {
    const f = fixture()
    f.wallet.node.getNodeInfo.mockResolvedValue({ rollupVersion: 50001 } as never)
    await expect(f.service.prepare()).rejects.toThrow("different destination rollup")
    expect(f.signConsent).not.toHaveBeenCalled()
    expect(f.runtime.build).not.toHaveBeenCalled()
  })
  it("rejects a changed registry before publishing a prepared batch", async () => {
    const f = fixture()
    const plan = await f.service.prepare()
    f.state.registry = addr(200)
    await expect(f.service.broadcast(plan, vi.fn())).rejects.toThrow(
      "registry or controller changed",
    )
    expect(f.sends).toHaveLength(0)
  })
  it("does not use a new registry to renew the spent bootstrap allowance", async () => {
    const f = fixture()
    f.state.bootstrapSpent = true
    await f.controller.advance(true)
    expect(f.controller.getSnapshot()?.error).toContain("allowance is already spent")
    expect(f.sends).toHaveLength(0)
  })
  it("rejects a saved plan when the destination metadata coordinates change", async () => {
    const f = fixture()
    const plan = await f.service.prepare()
    f.options.record.resolverOperator = addr(200)
    await expect(f.make().service.broadcast(plan, vi.fn())).rejects.toThrow(
      "account or deployment changed",
    )
    expect(f.sends).toHaveLength(0)
  })
})
