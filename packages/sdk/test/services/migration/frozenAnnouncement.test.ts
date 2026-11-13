// The lone announcement of a refunded batch whose carrier never landed, and when a run completes.
import { describe, expect, it } from "vitest"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { FunctionCall, FunctionSelector, FunctionType } from "@aztec-labs/stdlib/abi"
import { TxExecutionResult, TxStatus, type TxHash } from "@aztec-labs/stdlib/tx"
import { DEFAULT_CONTRACTS, getHardcodedArtifact } from "@obsidion/contracts"
import type { MigrationFundingBatch } from "@obsidion/core/types"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import {
  KIND_BY_ANY,
  buildClaimFpcPolicy,
} from "../../../src/feePaymentMethod/claimFpc/claimSponsoredCall.js"
import {
  FrozenMetadataMigrationSource,
  MAX_MIGRATION_ANNOUNCEMENTS,
  MAX_MIGRATION_RESENDS,
  saveOperation,
} from "../../../src/services/migration/FrozenMetadataMigrationSource.js"
import { MigrationHaltedError } from "../../../src/services/migration/metadataMigration.js"
import { migrationDirectCommitment } from "../../../src/services/migration/migrationDeposit.js"
import { SipaSelfResolver } from "../../../src/services/sipa/sipaSelfResolve.js"

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const ROUTE = {
  executor: addr("e1"),
  subsidy: addr("5b"),
  payoutToken: addr("da"),
  sourcePortal: addr("51"),
  destinationPortal: addr("de"),
  operationExecutor: addr("0e"),
}
const USER = AztecAddress.fromNumberUnsafe(2)
const OWNER = addr("0a")
const AMOUNT = 100n
const DAY = 20_000
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const CARRIER = hash(1)
const ANNOUNCEMENT = hash(2)

type Receipt = { status: TxStatus; executionResult?: TxExecutionResult }
const DROPPED: Receipt = { status: TxStatus.DROPPED }
const PENDING: Receipt = { status: TxStatus.PENDING }
const PROPOSED: Receipt = { status: TxStatus.PROPOSED, executionResult: TxExecutionResult.SUCCESS }
const CHECKPOINTED: Receipt = {
  status: TxStatus.CHECKPOINTED,
  executionResult: TxExecutionResult.SUCCESS,
}

const interaction = (name: string) => ({
  request: async () => ({
    calls: [
      FunctionCall.from({
        name,
        to: AztecAddress.fromNumberUnsafe(3),
        selector: FunctionSelector.fromField(new Fr(1)),
        type: FunctionType.PRIVATE,
        isStatic: false,
        hideMsgSender: false,
        args: [],
      }),
    ],
  }),
})

/** A source with one sent batch whose carrier the network dropped; each send takes the next hash. */
async function fixture() {
  const saved = new Map<string, MigrationFundingBatch>()
  const receipts = new Map<string, Receipt>([[CARRIER, DROPPED]])
  const chain = { claimed: 0n, refunded: true }
  const selfResolver = new SipaSelfResolver({ stealthScalar: 11n, selfSipaKey: new Fr(7n) })
  let sends = 1
  const source = new FrozenMetadataMigrationSource({
    owner: OWNER,
    runtime: {
      identity: "frozen",
      migration: ROUTE,
      validate: async () => {},
      minimumMigratedAmount: async () => 1n,
      assertMigrationReady: async () => {},
      candidates: async () => ({ maxNotesPerBatch: 2, maxBatchAmount: 10n ** 30n, candidates: [] }),
      refunded: async () => chain.refunded,
    },
    directDepositClaimed: async () => chain.claimed,
    destinationAsset: addr("55"),
    destination: { portal: ROUTE.destinationPortal, factory: addr("fa"), rollupVersion: 5n },
    selfResolver,
    token: { methods: { notify_sipa_recipient: () => interaction("notify_sipa_recipient") } },
    broadcaster: {
      methods: new Proxy({}, { get: () => () => interaction("broadcast_l1_operation_2k") }),
    },
    registered: {
      fpcAddress: AztecAddress.fromNumberUnsafe(1),
      fpcArtifact: await getHardcodedArtifact(DEFAULT_CONTRACTS.claimFpc),
      railId: 0,
      policy: await buildClaimFpcPolicy([
        { kind: KIND_BY_ANY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: 1n },
      ]),
      user: USER,
    },
    client: {
      getBlockNumber: async () => 1n,
      call: async () => ({}),
      readContract: async () => 10n ** 30n,
    },
    wallet: {
      node: { getTxReceipt: async (tx: TxHash) => receipts.get(tx.toString()) ?? PENDING },
      sendTx: async (_payload: unknown, opts: { onTxHash(hash: string): Promise<void> }) =>
        opts.onTxHash(hash(++sends)),
    },
    batches: {
      get: async (id: string) => saved.get(id),
      set: async (id: string, batch: MigrationFundingBatch) => {
        saved.set(id, structuredClone(batch))
      },
    },
  } as never)
  const batch = async (nonce: number, over: Partial<MigrationFundingBatch> = {}) => {
    const { recipientCommitment } = await migrationDirectCommitment(
      { selfResolver, recipient: USER, recoveryAccount: OWNER },
      DAY,
      nonce,
    )
    return {
      binding: source.identity,
      recipient: recipientCommitment,
      amount: String(AMOUNT),
      exitFee: "0",
      fromBlock: "1",
      sourceSelection: [`n${nonce}`],
      sourceKind: "frozen-deposit",
      direct: {
        subsidy: ROUTE.subsidy,
        executor: ROUTE.executor,
        day: DAY,
        nonce,
        recipientCommitment,
      },
      ...over,
    } satisfies MigrationFundingBatch
  }
  saved.set("remaining-0", await batch(300_000, { broadcastTx: CARRIER }))
  return { source, saved, receipts, chain, batch, first: () => saved.get("remaining-0")! }
}

describe("a refunded batch whose carrier never landed", () => {
  it("is announced alone, and its carrier is not sent again", async () => {
    const f = await fixture()

    await f.source.reconcileRemaining()

    expect(f.first()).toMatchObject({
      refunded: true,
      broadcastTx: CARRIER,
      announcementTx: ANNOUNCEMENT,
      announcements: 1,
    })
    expect(f.first().resends).toBeUndefined()
  })

  it.each<[string, Receipt, number]>([
    ["waits for one not yet included", PENDING, 1],
    ["waits for one in a proposed block", PROPOSED, 1],
    ["sends another once one is dropped", DROPPED, 2],
  ])("%s", async (_, receipt, announcements) => {
    const f = await fixture()
    await f.source.reconcileRemaining()
    f.receipts.set(ANNOUNCEMENT, receipt)

    await f.source.reconcileRemaining()

    expect(f.first().announcements).toBe(announcements)
  })

  it("stops for the user once every announcement was dropped", async () => {
    const f = await fixture()
    for (let sent = 1; sent <= MAX_MIGRATION_ANNOUNCEMENTS; sent++) {
      await f.source.reconcileRemaining()
      f.receipts.set(f.first().announcementTx!, DROPPED)
    }

    await expect(f.source.reconcileRemaining()).rejects.toBeInstanceOf(MigrationHaltedError)

    expect(f.first().announcements).toBe(MAX_MIGRATION_ANNOUNCEMENTS)
  })

  it("is not announced while its refund has not run", async () => {
    const f = await fixture()
    f.chain.refunded = false
    // The carrier has no send left, so it is not sent again either.
    f.saved.set("remaining-0", { ...f.first(), resends: MAX_MIGRATION_RESENDS })

    await expect(f.source.reconcileRemaining()).rejects.toBeInstanceOf(MigrationHaltedError)

    expect(f.first().announcementTx).toBeUndefined()
  })

  it("holds the next batch's send while its announcement is not yet included", async () => {
    const f = await fixture()
    await f.source.reconcileRemaining()
    f.receipts.set(ANNOUNCEMENT, PENDING)
    const operation = saveOperation({
      target: EthAddress.fromString(ROUTE.subsidy),
      payoutToken: EthAddress.fromString(ROUTE.payoutToken),
      calldata: Buffer.from("1234", "hex"),
      condition: L1OperationCondition.immediate(),
    })
    f.saved.set("remaining-1", await f.batch(300_001, { approved: true, operation }))

    await f.source.recoverRemaining()
    expect(f.saved.get("remaining-1")!.broadcastTx).toBeUndefined()

    f.receipts.set(ANNOUNCEMENT, PROPOSED)
    await f.source.recoverRemaining()
    expect(f.saved.get("remaining-1")!.broadcastTx).toBe(hash(3))
  })
})

describe("a run's completion", () => {
  it.each<[string, Receipt, Receipt | undefined, boolean]>([
    ["a carrier on L1", CHECKPOINTED, undefined, true],
    ["a carrier in a proposed block", PROPOSED, undefined, false],
    ["a dropped carrier", DROPPED, undefined, false],
    ["a dropped carrier and an announcement in a proposed block", DROPPED, PROPOSED, false],
    ["a dropped carrier and an announcement on L1", DROPPED, CHECKPOINTED, true],
  ])("with %s", async (_, carrier, announcement, complete) => {
    const f = await fixture()
    f.chain.claimed = AMOUNT
    f.receipts.set(CARRIER, carrier)
    if (announcement) {
      f.saved.set("remaining-0", { ...f.first(), announcementTx: ANNOUNCEMENT })
      f.receipts.set(ANNOUNCEMENT, announcement)
    }

    expect(await f.source.remainingComplete()).toBe(complete)
    expect(!!f.first().announced).toBe(complete)
  })
})
