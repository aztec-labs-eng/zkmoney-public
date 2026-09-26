import { describe, expect, it, vi } from "vitest"
import { EthAddress } from "@aztec/aztec.js/addresses"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { TxHash } from "@aztec/stdlib/tx"
import { assertPlainWithdrawals } from "@oxide/oxide-client/l2_operations.js"
import { getUserPayloadHash } from "@oxide/oxide-lib/content_hash.js"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal.js"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"

const AMOUNT = 10n ** 18n

const {
  instance,
  resolveSpendMetadata,
  buildSponsoredTeeOperation,
  findEscrowDepositTx,
  claimToL1,
  planPayout,
} = vi.hoisted(() => ({
  instance: {
    address: { toString: () => "0xescrow" },
    initializationHash: {},
    currentContractClassId: { equals: () => true },
  },
  resolveSpendMetadata: vi.fn(),
  buildSponsoredTeeOperation: vi.fn(async () => ({
    payload: {},
    sendOpts: { additionalScopes: [] },
  })),
  findEscrowDepositTx: vi.fn(),
  claimToL1: vi.fn(() => ({ __fake: "claimToL1" })),
  planPayout: vi.fn(),
}))
vi.mock("@aztec/stdlib/contract", () => ({
  getContractInstanceFromInstantiationParams: async () => instance,
}))
vi.mock("@aztec/aztec.js/contracts", () => ({
  Contract: {
    at: () => ({
      address: instance.address,
      methods: {
        claim_to_l1: claimToL1,
        // A 1-token escrow note: `data` packs the amount in its top 16 bytes.
        sync_note: () => ({
          simulate: async () => ({
            result: {
              data: new Fr(AMOUNT << 128n),
              refundable_until: Fr.ZERO,
              token_address: AztecAddress.ZERO,
            },
          }),
        }),
      },
    }),
  },
}))
vi.mock("@obsidion/contracts", () => ({
  DEFAULT_CONTRACTS: { paylinkDirect: "paylinkDirect", oxideToken: "oxideToken" },
  ensureContractRegisteredInPXE: vi.fn(),
}))
vi.mock("../claimSponsor.js", () => ({
  chainInfoFields: async () => ({ chainId: new Fr(31337n), version: new Fr(1n) }),
  registerSponsorFpc: async () => ({}),
  contractClassWitness: async () => ({}),
  linkChainInfo: async () => ({ chainId: 31337, rollupVersion: 1 }),
}))
vi.mock("../sponsoredTeeOperation.js", () => ({ buildSponsoredTeeOperation }))
vi.mock("../plainWithdrawal.js", () => ({ planPayout }))
vi.mock("./paylinkClaimSubmit.js", () => ({ buildOperationCall: vi.fn() }))
vi.mock("./paylinkKeys.js", () => ({
  derivePaylinkKeys: async () => ({ publicKeys: {}, secretKey: {} }),
  registerPaylinkContractWithKeys: vi.fn(),
  registerEscrowTagSecret: vi.fn(),
}))
vi.mock("./paylinkRecovery.js", () => ({ findEscrowDepositTx }))
vi.mock("./paylinkSpendMetadata.js", () => ({
  makePaylinkSpendMetadataResolver: resolveSpendMetadata,
}))

const { exitPaylinkWithVoucher } = await import("./paylinkVoucher.js")

const RECIPIENT = EthAddress.fromString("0x2222222222222222222222222222222222222222")
const EXECUTOR = EthAddress.fromString("0x3333333333333333333333333333333333333333")
const PLAIN_WITHDRAWAL = { executor: EXECUTOR, fpcFundingCut: 0n, frozen: false }
const RELEASE = { __fake: "releaseBroadcast" }
const WITHDRAWAL = {
  tuple: { l2Token: AztecAddress.ZERO.toString() },
  portal: { fpcFundingCut: 0n, frozen: false },
}
planPayout.mockImplementation(async (_wallet, _service, _token, burn) => ({
  plainWithdrawal: PLAIN_WITHDRAWAL,
  userPayload: encodePlainWithdrawalPayload({
    recipient: burn.recipient,
    relayerTip: WITHDRAW_RELAYER_TIP,
  }),
  meta: [],
  broadcasts: [RELEASE],
}))

const params = { paylinkType: "paylinkDirect", classId: {}, chainId: 31337, rollupVersion: 1 }
const getArtifactForContract = vi.fn(async () => ({}))
const contractService = { getArtifactForContract }
const wallet = {
  registerSender: vi.fn(),
  node: {},
  sendTx: vi.fn(async () => ({ receipt: { txHash: "0xexit", blockNumber: 1 } })),
}
const exit = (proverTip?: bigint, tokenAddress = AztecAddress.ZERO) =>
  exitPaylinkWithVoucher({
    params,
    tokenAddress,
    withdrawal: WITHDRAWAL,
    proverTip,
    wallet,
    contractService,
    sponsor: {},
    l1Recipient: RECIPIENT,
  } as never)

const lastTeeArgs = () =>
  (vi.mocked(buildSponsoredTeeOperation).mock.lastCall as unknown as [unknown, any])[1]

describe("voucher exit", () => {
  it("anchors the token artifact lookup to the withdrawal source", async () => {
    findEscrowDepositTx.mockResolvedValue(undefined)
    const tokenAddress = AztecAddress.ZERO

    await expect(exit(0n, tokenAddress)).resolves.toMatchObject({ txHash: "0xexit" })

    expect(getArtifactForContract).toHaveBeenCalledWith("oxideToken", tokenAddress)
  })

  it.each([undefined, new TxHash(new Fr(123))])(
    "anchors the note metadata on the deposit tx found on chain (%s)",
    async (txHash) => {
      findEscrowDepositTx.mockResolvedValue(txHash ? { txHash, l2BlockNumber: 3 } : undefined)
      await expect(exit()).resolves.toMatchObject({ txHash: "0xexit", amount: AMOUNT })
      expect(resolveSpendMetadata).toHaveBeenLastCalledWith(instance, txHash, expect.any(Object))
      // The escrow note sizes the burn; the link carries no amount.
      expect(lastTeeArgs()).toMatchObject({ expectedWithdrawalAmount: AMOUNT })
    },
  )

  it("burns the escrow note through the plain executor and rides the release broadcast", async () => {
    findEscrowDepositTx.mockResolvedValue(undefined)
    await exit(3n)

    expect(planPayout).toHaveBeenLastCalledWith(
      wallet,
      contractService,
      AztecAddress.ZERO,
      { from: instance.address, recipient: RECIPIENT, amount: AMOUNT, proverTip: 3n },
      WITHDRAWAL,
    )
    const userPayload = encodePlainWithdrawalPayload({
      recipient: RECIPIENT,
      relayerTip: WITHDRAW_RELAYER_TIP,
    })
    expect(claimToL1).toHaveBeenLastCalledWith(EXECUTOR, getUserPayloadHash(userPayload), 3n)
    const args = lastTeeArgs()
    expect(args.operations).toHaveLength(1)
    expect(args.operations[0]).toMatchObject({
      kind: "outerCall",
      interaction: { __fake: "claimToL1" },
      withdrawals: [{ executor: EXECUTOR, userPayload, amount: AMOUNT, proverTip: 3n }],
    })
    expect(args.plainWithdrawal).toBe(PLAIN_WITHDRAWAL)
    expect(args.teeUnsignedInteractions).toEqual([RELEASE])
  })

  it("defaults the prover tip to zero", async () => {
    findEscrowDepositTx.mockResolvedValue(undefined)
    await exit()
    expect(planPayout.mock.lastCall![3]).toMatchObject({ proverTip: 0n })
    expect(claimToL1.mock.lastCall).toEqual([EXECUTOR, expect.any(Fr), 0n])
  })

  // The batch's relayer-tip check runs over the declared withdrawals, so they must carry the tips.
  it("declares the burn so the batch refuses tips the escrow note cannot cover", async () => {
    findEscrowDepositTx.mockResolvedValue(undefined)
    const check = (proverTip: bigint) =>
      exit(proverTip).then(() => {
        const args = lastTeeArgs()
        assertPlainWithdrawals(args.operations[0].withdrawals, {
          plainWithdrawalExecutor: args.plainWithdrawal.executor,
          fpcFundingCut: args.plainWithdrawal.fpcFundingCut,
          portalFrozen: args.plainWithdrawal.frozen,
        })
      })
    await expect(check(AMOUNT - WITHDRAW_RELAYER_TIP)).resolves.toBeUndefined()
    await expect(check(AMOUNT - WITHDRAW_RELAYER_TIP + 1n)).rejects.toThrow(/relayer tip/)
  })

  it("refuses a token that differs from the escrow note before constructing a burn", async () => {
    buildSponsoredTeeOperation.mockClear()
    planPayout.mockClear()
    await expect(exit(0n, AztecAddress.fromStringUnsafe(new Fr(123).toString()))).rejects.toThrow(
      "note token differs",
    )
    expect(planPayout).not.toHaveBeenCalled()
    expect(buildSponsoredTeeOperation).not.toHaveBeenCalled()
  })
})
