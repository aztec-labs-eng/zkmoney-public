import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"

const chain = vi.hoisted(() => ({
  recordCurrent: false,
  uses: 1,
  /** A subscription note whose allowance may be spent; defaults to having uses left. */
  subscribed: undefined as boolean | undefined,
  /** The account's key subscribed on the registered rail, as of the node's latest block. */
  registrationSubscribed: false,
  /** ...and as of the block the wallet's note read is anchored at. */
  registrationSeen: false,
  result: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}))
vi.mock("../../src/services/metadataMigration.js", async (original) => ({
  ...(await original<typeof import("../../src/services/metadataMigration.js")>()),
  readMetadataDestinationState: async () => (chain.recordCurrent ? "0xcurrent" : "0xstale"),
  restoreRecordUpdate: async (raw: string) => JSON.parse(raw),
}))
vi.mock("@oxide/l1-contracts", async (original) => ({
  ...(await original<typeof import("@oxide/l1-contracts")>()),
  userRecordStateHash: () => "0xcurrent",
  encodeUserRecordMetadata: () => "0xrecord",
  readNameOf: async () => `0x${"09".repeat(32)}`,
  getBootstrapOwner: async () => "0x00000000000000000000000000000000000000b2",
}))
vi.mock("@oxide/oxide-client/record_update.js", async (original) => ({
  ...(await original<typeof import("@oxide/oxide-client/record_update.js")>()),
  readRecordUpdateResult: chain.result,
}))
vi.mock("../../src/services/claimSponsor.js", () => ({
  claimFpcSubscriptionUses: async () => chain.uses,
  hasClaimFpcSubscription: async () => chain.subscribed ?? chain.uses > 0,
}))
vi.mock("../../src/services/migrationDeposit.js", async (original) => ({
  ...(await original<typeof import("../../src/services/migrationDeposit.js")>()),
  resolveMigrationDeposit: async () => ({}),
  migrationDepositCalls: async () => [],
}))
vi.mock("../../src/feePaymentMethod/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: () => ({}),
}))
vi.mock("../../src/feePaymentMethod/claimSponsoredCall.js", async (original) => ({
  ...(await original<typeof import("../../src/feePaymentMethod/claimSponsoredCall.js")>()),
  buildClaimSponsorPayload: async () => ({}),
  buildClaimSubscribePayload: async () => ({}),
}))
vi.mock("../../src/services/registrationMessage.js", () => ({
  registrationInbox: () => ({}),
  findRegistrationMessage: async () => ({ status: "ready", leafIndex: 0 }),
}))
vi.mock("../../src/services/migrationBootstrap.js", () => ({
  prepareMigrationBootstrap: vi.fn(),
  claimFpcIdentitySubscribed: async () => true,
  claimFpcRegistrationSubscribed: async (...args: unknown[]) =>
    args[4] === undefined ? chain.registrationSubscribed : chain.registrationSeen,
}))

import { MigrationHaltedError, StalePlanError } from "../../src/services/metadataMigration.js"
import {
  MetadataMigrationService,
  type MetadataMigrationSource,
} from "../../src/services/MetadataMigrationService.js"

beforeEach(() => {
  chain.recordCurrent = false
  chain.uses = 1
  chain.subscribed = undefined
  chain.registrationSubscribed = false
  chain.registrationSeen = false
  chain.result.mockReset()
})

function service(recordCurrent: boolean) {
  chain.recordCurrent = recordCurrent
  const quote = vi.fn(async () => ({ movable: 1n, stranded: 0n, waiting: 0n }))
  const source = {
    fundsOnly: true,
    state: async () => "frozen",
    quote,
  } as unknown as MetadataMigrationSource
  const destination = { token: "0x0000000000000000000000000000000000000001" }
  return {
    service: new MetadataMigrationService({ source, registered: {}, destination } as never),
    quote,
  }
}

describe("a frozen source's quote", () => {
  it("counts one approval per batch and charges no fee", async () => {
    const f = service(false)
    f.quote.mockResolvedValue({ movable: 9n, stranded: 0n, waiting: 0n, batches: 2 } as never)
    expect(await f.service.quote()).toMatchObject({ movable: 9n, approvals: 2, fees: 0n })
    expect(f.quote).toHaveBeenCalledWith()
  })

  it("keeps the source's own approval count, which skips a link's batch", async () => {
    const f = service(false)
    f.quote.mockResolvedValue({
      movable: 9n,
      stranded: 0n,
      waiting: 0n,
      batches: 2,
      approvals: 1,
    } as never)
    expect(await f.service.quote()).toMatchObject({ approvals: 1, fees: 0n })
  })

  it("is movable exactly when the quote moves something", async () => {
    const f = service(false)
    expect(await f.service.movable()).toBe(true)
    f.quote.mockResolvedValue({ movable: 0n, stranded: 4n, waiting: 0n })
    expect(await f.service.movable()).toBe(false)
  })
})

it("counts the record update as one approval until the record is current with recurring sponsorship", async () => {
  const f = service(false)
  expect(await f.service.consentApprovals()).toBe(1)
  chain.recordCurrent = true
  expect(await f.service.consentApprovals()).toBe(0)
  chain.uses = 0
  chain.subscribed = false
  expect(await f.service.consentApprovals()).toBe(1)
})

describe("a saved plan", () => {
  const fpc = AztecAddress.fromBigIntUnsafe(14n)
  const bootstrapTx = `0x${"0b".repeat(32)}`
  const update = { userOpHash: "0xop" }
  const ran = { txHash: "0x01", notification: { key: "0x02", index: 0n } }

  function observing(fundsOnly = false) {
    const source = {
      identity: fundsOnly ? "frozen-source" : "no-source-deployment",
      fundsOnly,
      state: async () => (fundsOnly ? "frozen" : "empty"),
      remainingSent: async () => false,
      remainingComplete: async () => true,
      recoverRemaining: vi.fn(async () => {}),
    }
    const client = {}
    const receipt = vi.fn(
      async (): Promise<{ status: TxStatus; executionResult?: TxExecutionResult }> => ({
        status: TxStatus.PROPOSED,
        executionResult: TxExecutionResult.SUCCESS,
      }),
    )
    const sendTx = vi.fn(async () => {})
    const service = new MetadataMigrationService({
      source,
      client,
      owner: "0x00000000000000000000000000000000000000a1",
      record: {},
      destination: {
        token: "0x00000000000000000000000000000000000000b0",
        nameRegistry: "0x00000000000000000000000000000000000000a2",
        namePortal: "0x00000000000000000000000000000000000000a3",
        chainId: 1n,
        rollupVersion: 7n,
      },
      bootstrap: { fpcAddress: fpc, user: fpc, railId: 0 },
      registered: { fpcAddress: fpc, user: fpc, railId: 1 },
      registrationKeyProof: () => ({ keyWitness: new Uint8Array(32) }),
      wallet: {
        sendTx,
        pxe: {
          getSyncedBlockHeader: async () => ({
            globalVariables: { blockNumber: 10 },
            hash: async () => "0xanchor",
          }),
        },
        getSnapshot: async (read: () => Promise<unknown>) => ({
          value: await read(),
          anchorBlock: 10,
        }),
        simulateTx: async () => {
          throw new Error("allowance exhausted")
        },
        node: {
          getNodeInfo: async () => ({
            rollupVersion: 7,
            l1ContractAddresses: { inboxAddress: "0x00000000000000000000000000000000000000c1" },
          }),
          getTxReceipt: receipt,
        },
      },
    } as never)
    const plan = async (fields: Record<string, unknown> = {}) =>
      JSON.stringify({
        binding: await service.binding(),
        day: 1,
        nonce: 2,
        fromBlock: "100",
        sourceState: "empty",
        recordUpdate: JSON.stringify({ update }),
        ...fields,
      })
    const observe = async (published = true) =>
      service.observe({ plan: await plan(), ...(published ? { bootstrapTx } : {}) })
    return { service, source, client, plan, observe, receipt, sendTx }
  }

  describe("observed before recurring sponsorship", () => {
    beforeEach(() => {
      chain.uses = 0
    })

    it.each([
      ["failed", { status: "failed", txHash: "0x01", revertReason: "0x" }, "failed on Ethereum"],
      ["lost its nonce to another operation", { status: "not-run", nonceUsed: true }, "changed"],
      [
        "ran, but its record was overwritten",
        { status: "succeeded", ...ran, recordHeld: false },
        "changed",
      ],
    ])("halts on an update that %s", async (_, result, message) => {
      chain.result.mockResolvedValue(result)
      const observed = observing().observe()
      await expect(observed).rejects.toBeInstanceOf(MigrationHaltedError)
      await expect(observed).rejects.toMatchObject({ halt: "reverted" })
      await expect(observed).rejects.toThrow(message)
    })

    it("reads again when the update lands between the reader's log and nonce reads", async () => {
      chain.result
        .mockResolvedValueOnce({ status: "not-run", nonceUsed: true })
        .mockResolvedValueOnce({ status: "succeeded", ...ran, recordHeld: true })
      expect(await observing().observe()).toMatchObject({ metadataSettled: true })
      expect(chain.result).toHaveBeenCalledTimes(2)
    })

    it("waits on an update not yet run whose nonce is unused", async () => {
      chain.result.mockResolvedValue({ status: "not-run", nonceUsed: false })
      const f = observing()
      expect(await f.observe()).toMatchObject({
        bootstrapStatus: "included",
        metadataSettled: false,
        messagesReady: false,
        recurringSponsorship: false,
        complete: false,
      })
      expect(chain.result).toHaveBeenCalledWith(f.client, update, { fromBlock: 100n })
    })

    it("reports a bootstrap the node dropped as dropped", async () => {
      chain.result.mockResolvedValue({ status: "not-run", nonceUsed: false })
      const f = observing()
      f.receipt.mockResolvedValue({ status: TxStatus.DROPPED })
      expect(await f.observe()).toMatchObject({ bootstrapStatus: "dropped" })
    })

    it("settles an update that ran and whose record holds", async () => {
      chain.result.mockResolvedValue({ status: "succeeded", ...ran, recordHeld: true })
      expect(await observing().observe()).toMatchObject({
        metadataSettled: true,
        messagesReady: true,
        complete: false,
      })
    })

    it("reads only the record before publication", async () => {
      expect(await observing().observe(false)).toMatchObject({ metadataSettled: false })
      chain.recordCurrent = true
      expect(await observing().observe(false)).toMatchObject({ metadataSettled: true })
      expect(chain.result).not.toHaveBeenCalled()
    })
  })

  describe("observed after recurring sponsorship", () => {
    it("stays settled while the subscription's allowance is spent", async () => {
      chain.uses = 0
      chain.subscribed = true
      chain.result.mockResolvedValue({ status: "succeeded", ...ran, recordHeld: false })
      expect(await observing().observe()).toMatchObject({
        metadataSettled: true,
        recurringSponsorship: false,
      })
    })

    it("stays settled once the update ran, even when its record no longer holds", async () => {
      chain.result.mockResolvedValue({ status: "succeeded", ...ran, recordHeld: false })
      expect(await observing().observe()).toMatchObject({
        metadataSettled: true,
        recurringSponsorship: true,
        complete: true,
      })
    })

    it("settles on a current record whatever the update shows", async () => {
      chain.recordCurrent = true
      chain.result.mockResolvedValue({ status: "failed", txHash: "0x01", revertReason: "0x" })
      expect(await observing().observe()).toMatchObject({ metadataSettled: true })
    })
  })

  describe("activating sponsorship", () => {
    beforeEach(() => {
      chain.recordCurrent = true
    })

    it("sends nothing once the account holds the registered rail's note", async () => {
      chain.registrationSubscribed = true
      chain.subscribed = true
      const f = observing()
      await f.service.subscribe(await f.plan(), async () => {})
      expect(f.sendTx).not.toHaveBeenCalled()
    })

    it("sends nothing while the note read's anchor has not seen the key's subscription", async () => {
      chain.registrationSubscribed = true
      chain.subscribed = false
      const f = observing()
      await f.service.subscribe(await f.plan(), async () => {})
      expect(f.sendTx).not.toHaveBeenCalled()
    })

    it("stops without sending when the key subscribed but this account holds no note", async () => {
      chain.registrationSubscribed = true
      chain.registrationSeen = true
      chain.subscribed = false
      const f = observing()
      await expect(f.service.subscribe(await f.plan(), async () => {})).rejects.toThrow(
        "already subscribed",
      )
      expect(f.sendTx).not.toHaveBeenCalled()
    })

    it("subscribes when the key has not", async () => {
      chain.subscribed = false
      const f = observing()
      await f.service.subscribe(await f.plan(), async () => {})
      expect(f.sendTx).toHaveBeenCalledTimes(1)
    })
  })

  it("recovers the planned batches only with recurring sponsorship", async () => {
    const f = observing(true)
    const signal = new AbortController().signal
    const gate = vi.fn()
    const raw = await f.plan({ recoveryOnly: true, sourceState: "frozen", recordUpdate: undefined })
    chain.uses = 0
    await expect(f.service.recoverRemaining(raw, signal, gate as never)).rejects.toThrow(
      "Recurring sponsorship is not available",
    )
    expect(f.source.recoverRemaining).not.toHaveBeenCalled()
    chain.uses = 1
    await f.service.recoverRemaining(raw, signal, gate as never)
    expect(f.source.recoverRemaining).toHaveBeenCalledWith(signal, gate)
  })

  it("restores a funds-only plan saved with empty metadata fields", async () => {
    const f = observing(true)
    const raw = await f.plan({
      recoveryOnly: true,
      sourceState: "frozen",
      recordUpdate: undefined,
      intentData: "0x",
      proofs: "0x",
    })
    chain.recordCurrent = true
    expect(await f.service.observe({ plan: raw })).toMatchObject({
      metadataSettled: true,
      recurringSponsorship: true,
      complete: true,
    })
  })

  it("stops a plan that signed a metadata-update SIPA as stale", async () => {
    const f = observing()
    const raw = await f.plan({ recordUpdate: undefined, intentData: "0x01", proofs: "0x02" })
    await expect(f.service.observe({ plan: raw, bootstrapTx })).rejects.toBeInstanceOf(
      StalePlanError,
    )
  })
})
