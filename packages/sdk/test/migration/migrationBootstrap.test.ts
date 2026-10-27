import { describe, expect, it, vi } from "vitest"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import {
  encodeL1OperationCalldata,
  L1OperationCondition,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import type { Address } from "viem"

vi.mock("@oxide/oxide-client/broadcaster_calls.js", () => ({
  broadcastL1Operation: vi.fn(() => ({ request: async () => ({ calls: [{ to: "broadcast" }] }) })),
}))
vi.mock("../../src/services/claimSponsor.js", () => ({ hasClaimFpcSubscription: vi.fn() }))
vi.mock("../../src/feePaymentMethod/claimSponsoredCall.js", () => ({
  buildClaimSubscribePayload: vi.fn(async () => ({ rail: "subscribe" })),
  buildClaimSponsorPayload: vi.fn(async () => ({ rail: "sponsor" })),
}))
vi.mock("../../src/feePaymentMethod/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: vi.fn(() => ({})),
}))

import { broadcastL1Operation } from "@oxide/oxide-client/broadcaster_calls.js"
import {
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
} from "../../src/feePaymentMethod/claimSponsoredCall.js"
import { hasClaimFpcSubscription } from "../../src/services/claimSponsor.js"
import type { PreparedRecordUpdate } from "../../src/services/metadataMigration.js"
import {
  prepareMigrationBootstrap,
  type MigrationBootstrapOptions,
} from "../../src/services/migrationBootstrap.js"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const user = AztecAddress.fromBigIntUnsafe(12n)
const fpcAddress = AztecAddress.fromBigIntUnsafe(14n)

function fixture() {
  const recordUpdate = {
    update: {
      owner: addr(11),
      namePortalRecipient: fpcAddress.toString(),
      record: { l2Address: user.toString() },
    },
    operation: {
      target: EthAddress.fromString(addr(30)),
      payoutToken: EthAddress.fromString(addr(17)),
      calldata: Buffer.alloc(900, 1),
      condition: L1OperationCondition.immediate(),
    },
  } as unknown as PreparedRecordUpdate
  const findLeavesIndexes = vi.fn(async () => [undefined] as (bigint | undefined)[])
  const args: MigrationBootstrapOptions = {
    wallet: { node: { findLeavesIndexes } } as never,
    recordUpdate,
    broadcaster: { broadcaster: true } as never,
    sponsorship: { kind: "bootstrap", gate: { kind: "nameClaim" } as never },
    fpc: { fpcAddress, user, railId: 1 } as never,
  }
  vi.mocked(broadcastL1Operation).mockClear()
  vi.mocked(buildClaimSubscribePayload).mockClear()
  vi.mocked(buildClaimSponsorPayload).mockClear()
  vi.mocked(hasClaimFpcSubscription).mockReset()
  return { args, recordUpdate, findLeavesIndexes }
}

const noPayload = () => {
  expect(broadcastL1Operation).not.toHaveBeenCalled()
  expect(buildClaimSubscribePayload).not.toHaveBeenCalled()
  expect(buildClaimSponsorPayload).not.toHaveBeenCalled()
}

describe("migration bootstrap preparation", () => {
  it("broadcasts only the record update on the unspent bootstrap rail", async () => {
    const { args, recordUpdate, findLeavesIndexes } = fixture()
    const prepared = await prepareMigrationBootstrap(args)
    expect(findLeavesIndexes).toHaveBeenCalledOnce()
    expect(broadcastL1Operation).toHaveBeenCalledOnce()
    expect(broadcastL1Operation).toHaveBeenCalledWith(args.broadcaster, recordUpdate.operation)
    expect(prepared.innerCalls).toEqual([{ to: "broadcast" }])
    expect(prepared.payload).toEqual({ rail: "subscribe" })
    expect(buildClaimSubscribePayload).toHaveBeenCalledWith(
      expect.objectContaining({ innerCalls: prepared.innerCalls, gate: { kind: "nameClaim" } }),
    )
    expect(buildClaimSponsorPayload).not.toHaveBeenCalled()
    expect(prepared.sendOptions).toMatchObject({
      from: NO_FROM,
      sendMessagesAs: user,
      additionalScopes: [user],
    })
    const tier = encodeL1OperationCalldata(recordUpdate.operation.calldata)
    expect(prepared.metrics).toEqual({
      topLevelCalls: 1,
      recordBytes: 900,
      recordMethod: tier.tier.method,
    })
  })

  it("puts setup calls before the broadcast", async () => {
    const { args } = fixture()
    const prepared = await prepareMigrationBootstrap({
      ...args,
      setupCalls: [{ to: "setup" } as never],
    })
    expect(prepared.innerCalls).toEqual([{ to: "setup" }, { to: "broadcast" }])
    expect(prepared.metrics.topLevelCalls).toBe(2)
  })

  it("prepares on the registered rail without reading the bootstrap allowance", async () => {
    const { args, findLeavesIndexes } = fixture()
    vi.mocked(hasClaimFpcSubscription).mockResolvedValue(true)
    const prepared = await prepareMigrationBootstrap({
      ...args,
      sponsorship: { kind: "registered" },
    })
    expect(prepared.payload).toEqual({ rail: "sponsor" })
    expect(prepared.innerCalls).toEqual([{ to: "broadcast" }])
    expect(findLeavesIndexes).not.toHaveBeenCalled()
    expect(buildClaimSubscribePayload).not.toHaveBeenCalled()
  })

  it("refuses a bootstrap gate other than NameClaim", async () => {
    const { args } = fixture()
    const sponsorship = { kind: "bootstrap", gate: { kind: "password" } } as never
    await expect(prepareMigrationBootstrap({ ...args, sponsorship })).rejects.toThrow("NameClaim")
    noPayload()
  })

  it("refuses an identity that already spent its bootstrap allowance", async () => {
    const { args, findLeavesIndexes } = fixture()
    findLeavesIndexes.mockResolvedValue([0n])
    await expect(prepareMigrationBootstrap(args)).rejects.toThrow("already spent")
    noPayload()
  })

  it("refuses the registered rail without a subscription", async () => {
    const { args } = fixture()
    vi.mocked(hasClaimFpcSubscription).mockResolvedValue(false)
    await expect(
      prepareMigrationBootstrap({ ...args, sponsorship: { kind: "registered" } }),
    ).rejects.toThrow("no registered sponsorship subscription")
    noPayload()
  })

  it("refuses a record that names another account than the sponsored one", async () => {
    const { args } = fixture()
    const fpc = { ...args.fpc, user: AztecAddress.fromBigIntUnsafe(98n) }
    await expect(prepareMigrationBootstrap({ ...args, fpc })).rejects.toThrow(
      "must name the same account",
    )
    noPayload()
  })

  it("refuses a record update that notifies another FPC", async () => {
    const { args } = fixture()
    const fpc = { ...args.fpc, fpcAddress: AztecAddress.fromBigIntUnsafe(97n) }
    await expect(prepareMigrationBootstrap({ ...args, fpc })).rejects.toThrow(
      "different destination FPC",
    )
    noPayload()
  })
})
