/**
 * Wiring guard for the paylink burns to L1: the plain payout, its finalization request, any escrow
 * run and the burned amount reach the TEE batch builders unchanged. Everything past interaction
 * building is stubbed; the ClaimFPC sandbox suite covers the real burn.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { getUserPayloadHash } from "@oxide/oxide-lib/content_hash.js"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import {
  PROOF_FIELD_COUNT,
  VKEY_FIELD_COUNT,
  ZKJWT_PUBLIC_INPUT_COUNT,
} from "@obsidion/core/constants"

const INSTANCE_ADDR = AztecAddress.fromBigIntUnsafe(33n)
const USER_ADDR = AztecAddress.fromBigIntUnsafe(11n)
const TOKEN_ADDR = AztecAddress.fromBigIntUnsafe(44n)
const FPC_ADDR = AztecAddress.fromBigIntUnsafe(55n)

const {
  claimSpy,
  claimToL1Spy,
  runSpy,
  withdrawSpy,
  syncNote,
  prepareSubmit,
  BROADCASTER,
  ESCROW_AMOUNT,
} = vi.hoisted(() => {
  const ESCROW_AMOUNT = 3_000_000_000_000_000_000n
  const runSpy = vi.fn(() => ({ __fake: "escrowRunBroadcast" }))
  return {
    claimSpy: vi.fn(() => ({ __fake: "claimInteraction" })),
    claimToL1Spy: vi.fn(() => ({ __fake: "claimToL1Interaction" })),
    runSpy,
    BROADCASTER: { methods: { broadcast_l1_operation_2k: runSpy } },
    withdrawSpy: vi.fn(() => ({ with: () => ({ __fake: "withdrawCall" }) })),
    // A 3-token escrow note: `data` packs the amount in its top 16 bytes.
    syncNote: () => ({
      simulate: async () => ({
        result: {
          hash: 0n,
          sender_hash: 0n,
          data: ESCROW_AMOUNT << 128n,
          refundable_until: 0n,
          oidc_key_registry: 0n,
          vkey_hash: 0n,
          token_address: 44n,
        },
      }),
    }),
    prepareSubmit: vi.fn(async () => ({
      initFn: vi.fn(),
      buildResult: vi.fn(),
      sendOptions: {},
    })),
    ESCROW_AMOUNT,
  }
})

// The deployment's broadcaster: registration is a PXE write, and an escrow run rides the smallest tier.
vi.mock("@obsidion/contracts", async (importActual) => ({
  ...(await importActual<typeof import("@obsidion/contracts")>()),
  ensureContractRegisteredInPXE: vi.fn(async () => undefined),
  BroadcasterContract: { at: vi.fn(() => BROADCASTER) },
}))

vi.mock("@aztec-labs/aztec.js/contracts", async (importActual) => {
  const actual = await importActual<typeof import("@aztec-labs/aztec.js/contracts")>()
  return {
    ...actual,
    Contract: {
      ...(actual.Contract as object),
      at: vi.fn(() => ({
        address: INSTANCE_ADDR,
        artifact: { functions: [] },
        methods: { claim: claimSpy, claim_to_l1: claimToL1Spy, sync_note: syncNote },
      })),
    },
  }
})

vi.mock("../../src/services/paylink/paylinkKeys.js", () => ({
  derivePaylinkKeys: vi.fn(async () => ({ __fake: "keys" })),
  registerEscrowTagSecret: vi.fn(async () => undefined),
}))

vi.mock("../../src/services/claimSponsor.js", () => ({
  chainInfoFields: vi.fn(async () => ({ chainId: new Fr(31337n), version: new Fr(1n) })),
  contractClassWitness: vi.fn(async () => ({ __fake: "classWitness" })),
  registerSponsorFpc: vi.fn(async () => ({ __fake: "fpcArtifact" })),
  authorizeSponsoredBatch: vi.fn(async () => ({
    accountCall: { __fake: "accountCall" },
    intentHashes: [Fr.fromString("0xa11ce")],
    combinedAuthWitness: { __fake: "authwit" },
  })),
}))

vi.mock("../../src/services/paylink/paylinkClaimSubmit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/services/paylink/paylinkClaimSubmit.js")>()),
  preparePaylinkClaimSubmit: prepareSubmit,
}))

vi.mock("../../src/services/sponsoredTeeOperation.js", () => ({
  buildSponsoredTeeOperation: vi.fn(async () => ({
    payload: { __fake: "payload" },
    sendOpts: {
      additionalScopes: [INSTANCE_ADDR],
      finalize: { __fake: "finalize" },
      fee: { __fake: "fee" },
    },
  })),
}))

vi.mock("../../src/feePaymentMethod/sponsoredCall.js", () => ({
  computeIntentsOnlyAuthWitHash: vi.fn(async () => Fr.ZERO),
}))

vi.mock("@aztec-labs/aztec.js/authorization", () => ({
  computeAuthWitMessageHash: vi.fn(async () => Fr.fromString("0xa11ce")),
}))

import type { ClaimSponsorContext } from "../../src/services/claimSponsor.js"
import { PaylinkService } from "../../src/services/PaylinkService.js"
import { ObsidionAccount } from "../../src/obsidion/alpha/account/ObsidionAccount.js"
import { buildSponsoredTeeOperation } from "../../src/services/sponsoredTeeOperation.js"
import { DEFAULT_CONTRACTS } from "@obsidion/contracts"
import { paylinkL1Caller } from "../../src/services/paylink/paylinkL1Claim.js"
import { plainUserPayload, type WithdrawalOptions } from "../../src/services/plainWithdrawal.js"
import type { WithdrawOperation } from "../../src/oxide/plainWithdrawal.js"

function makeAccount() {
  const account = Object.create(ObsidionAccount.prototype) as ObsidionAccount
  return Object.assign(account, {
    getAddress: () => USER_ADDR,
    getAuthProvider: () => ({ createAuthWit: vi.fn(async () => ({ __fake: "authwit" })) }),
  })
}

function makeService() {
  const sendTx = vi.fn(async (_payload: unknown, _opts: unknown) => ({
    receipt: { txHash: { toString: () => "0xabc" }, blockNumber: 7 },
  }))
  const wallet: any = { node: {}, sendTx, registerSender: vi.fn(async () => undefined) }
  const tokenService: any = {
    tokenAddress: TOKEN_ADDR,
    getTokenContract: vi.fn(async () => ({
      address: TOKEN_ADDR,
      methods: { withdraw: withdrawSpy },
    })),
  }
  const service = new PaylinkService(
    wallet,
    makeAccount(),
    tokenService,
    {
      getArtifactForContract: vi.fn(async () => ({ __fake: "artifact" })),
      getArtifactForInstance: vi.fn(async () => ({ __fake: "broadcasterArtifact" })),
    } as any,
    undefined,
    { __fake: "teeSigner" } as any,
  )
  ;(service as any).reconstructPaylinkContract = vi.fn(async () => ({
    contract: {
      address: INSTANCE_ADDR,
      artifact: { functions: [] },
      methods: { claim_to_l1: claimToL1Spy, sync_note: syncNote },
    },
    instance: {
      address: INSTANCE_ADDR,
      initializationHash: Fr.ZERO,
      publicKeys: { __fake: "publicKeys" },
    },
    keys: { __fake: "keys" },
    depositTxHash: undefined,
  }))
  ;(service as any).payoutMeta = vi.fn(async () => [])
  return { service, sendTx }
}

const sponsor: ClaimSponsorContext = {
  fpcAddress: FPC_ADDR,
  fpcArtifact: { __fake: "fpcArtifact" } as any,
  railId: 1,
  gate: "nameClaim",
  policy: { __fake: "policy" } as any,
}

const linkParams = {
  secret: Fr.fromString("0x77"),
  paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
  classId: Fr.fromString("0xc1a55"),
  chainId: 31337,
  fallbackKeyHash: Fr.fromString("0x5"),
  rollupVersion: 1,
}

const ESCROW = EthAddress.fromString(`0x${"5a".repeat(20)}`)
const PORTAL = EthAddress.fromString(`0x${"11".repeat(20)}`)
const DAI = EthAddress.fromString(`0x${"22".repeat(20)}`)
const EXECUTOR = EthAddress.fromString(`0x${"33".repeat(20)}`)
const withdrawal: WithdrawalOptions = {
  // An executor that takes no fee.
  l1: { readContract: async () => 0n } as never,
  tuple: {
    portal: PORTAL.toString(),
    token: DAI.toString(),
    l2Token: TOKEN_ADDR.toString(),
    plainWithdrawalExecutor: EXECUTOR.toString(),
    l2Broadcaster: AztecAddress.fromBigIntUnsafe(66n).toString(),
  },
}
const FINALIZATION_REQUEST = { broadcaster: BROADCASTER, portal: PORTAL, payoutToken: DAI }

/** The withdrawal the escrow's nested `claim_to_l1` burn declares. */
function escrowBurn(userPayload: Buffer, proverTip: bigint): WithdrawOperation {
  return {
    kind: "withdraw",
    from: INSTANCE_ADDR,
    executor: EXECUTOR,
    userPayload,
    amount: ESCROW_AMOUNT,
    proverTip,
    finalizationRequestBroadcastParams: FINALIZATION_REQUEST as never,
    recoveryMemo: Buffer.alloc(0),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("claimSponsoredPaylinkToL1 wiring", () => {
  it("burns the escrow note through the plain executor and requests its finalization", async () => {
    const { service, sendTx } = makeService()

    const result = await service.claimSponsoredPaylinkToL1(
      linkParams,
      ESCROW,
      { proverTip: 7n, withdrawal },
      sponsor,
      { operationId: "op-1" },
    )

    expect(result).toEqual({ txHash: "0xabc", blockNumber: 7 })
    const userPayload = plainUserPayload(ESCROW)
    expect(claimToL1Spy).toHaveBeenCalledWith(EXECUTOR, getUserPayloadHash(userPayload), 7n)
    const args = vi.mocked(buildSponsoredTeeOperation).mock.calls[0]![1]
    expect(args.railId).toBe(sponsor.railId)
    expect(args.policy).toBe(sponsor.policy)
    // A plain burn broadcasts nothing of its own; the TEE batch appends its finalization request.
    expect(args.teeUnsignedInteractions).toEqual([])
    expect(runSpy).not.toHaveBeenCalled()
    expect(args.plainWithdrawal).toEqual({ executor: EXECUTOR, fee: 0n })
    expect(args.operations).toMatchObject([
      {
        kind: "outerCall",
        interaction: { __fake: "claimToL1Interaction" },
        withdrawals: [escrowBurn(userPayload, 7n)],
      },
    ])
    // The escrow note sizes the burn; the finalizer must refuse a note that burns anything else.
    expect(args.expectedWithdrawalAmount).toBe(ESCROW_AMOUNT)
    const opts = sendTx.mock.calls[0]![1] as any
    expect(opts.sendMessagesAs).toBe(USER_ADDR)
    expect(opts.kind).toBe("paylink-claim")
    expect(opts.operationId).toBe("op-1")
  })

  it("broadcasts only the run of the escrow the burn pays", async () => {
    const { service } = makeService()
    const factory = EthAddress.fromString(`0x${"fa".repeat(20)}`)
    const userPayload = encodePlainWithdrawalPayload({ recipient: ESCROW, relayerTip: 3n })
    const l1Operation = {
      target: factory,
      payoutToken: DAI,
      calldata: Buffer.from("c0ffee", "hex"),
      condition: L1OperationCondition.balance(DAI, ESCROW),
    }

    await service.claimSponsoredPaylinkToL1(
      linkParams,
      ESCROW,
      {
        proverTip: 7n,
        withdrawal: {
          ...withdrawal,
          escrow: { escrow: ESCROW, userPayload, l1Operation, withdrawalFee: 0n },
        },
      },
      sponsor,
    )

    expect(claimToL1Spy).toHaveBeenCalledWith(EXECUTOR, getUserPayloadHash(userPayload), 7n)
    expect(runSpy).toHaveBeenCalledTimes(1)
    const [target, payoutToken] = runSpy.mock.calls[0] as unknown[]
    expect(target).toBe(factory)
    expect(payoutToken).toBe(DAI)
    const args = vi.mocked(buildSponsoredTeeOperation).mock.calls[0]![1]
    expect(args.teeUnsignedInteractions).toEqual([{ __fake: "escrowRunBroadcast" }])
    expect(args.operations[0]).toMatchObject({ withdrawals: [escrowBurn(userPayload, 7n)] })
  })

  it("email: passes a proof bound to the payout through to claim_to_l1", async () => {
    const { service } = makeService()
    const userPayload = plainUserPayload(ESCROW)
    const zkProof = {
      vkey: Array.from({ length: VKEY_FIELD_COUNT }, () => "0x01"),
      proof: Array.from({ length: PROOF_FIELD_COUNT }, () => "0x01"),
      public_inputs: [
        (await paylinkL1Caller({ executor: EXECUTOR, userPayload })).toString(),
        ...Array.from({ length: ZKJWT_PUBLIC_INPUT_COUNT - 1 }, () => "0x00"),
      ],
    }

    await service.claimSponsoredPaylinkToL1(
      { ...linkParams, paylinkType: DEFAULT_CONTRACTS.paylinkEmail },
      ESCROW,
      { proverTip: 0n, withdrawal },
      sponsor,
      { zkProof },
    )

    const args = claimToL1Spy.mock.calls[0] as unknown[]
    expect(args).toHaveLength(11)
    expect(args.slice(8)).toEqual([EXECUTOR, getUserPayloadHash(userPayload), 0n])
    expect(buildSponsoredTeeOperation).toHaveBeenCalledTimes(1)
  })

  it("email: rejects a proof bound to another recipient before anything is built", async () => {
    const { service } = makeService()
    const zkProof = {
      vkey: Array.from({ length: VKEY_FIELD_COUNT }, () => "0x01"),
      proof: Array.from({ length: PROOF_FIELD_COUNT }, () => "0x01"),
      public_inputs: [
        (
          await paylinkL1Caller({
            executor: EXECUTOR,
            userPayload: plainUserPayload(EthAddress.fromString(`0x${"6b".repeat(20)}`)),
          })
        ).toString(),
        ...Array.from({ length: ZKJWT_PUBLIC_INPUT_COUNT - 1 }, () => "0x00"),
      ],
    }

    await expect(
      service.claimSponsoredPaylinkToL1(
        { ...linkParams, paylinkType: DEFAULT_CONTRACTS.paylinkEmail },
        ESCROW,
        { proverTip: 0n, zkProof, withdrawal },
        sponsor,
      ),
    ).rejects.toThrow(/not bound to the withdrawal payout/)
    expect(claimToL1Spy).not.toHaveBeenCalled()
    expect(buildSponsoredTeeOperation).not.toHaveBeenCalled()
  })
})

describe("claimPaylinkToL1 wiring", () => {
  it("declares the escrow's burn and its plain executor to the claim submit", async () => {
    const { service } = makeService()
    ;(service as any).sendAndWait = vi.fn(async () => "sent")

    await service.claimPaylinkToL1(linkParams, { l1Recipient: ESCROW, proverTip: 7n, withdrawal })

    const userPayload = plainUserPayload(ESCROW)
    expect(claimToL1Spy).toHaveBeenCalledWith(EXECUTOR, getUserPayloadHash(userPayload), 7n)
    const args = (prepareSubmit.mock.calls[0] as unknown[])[0] as any
    expect(args.interaction).toEqual({ __fake: "claimToL1Interaction" })
    expect(args.teeUnsignedInteractions).toEqual([])
    expect(args.withdrawal).toEqual({
      declared: escrowBurn(userPayload, 7n),
      plainWithdrawal: { executor: EXECUTOR, fee: 0n },
    })
  })
})

describe("claimSponsoredPaylink with a same-batch withdraw", () => {
  it("burns from the claimer through the plain executor and requests its finalization", async () => {
    const { service } = makeService()
    const amount = 10n ** 18n

    await service.claimSponsoredPaylink(linkParams, sponsor, {
      withdraw: { l1Recipient: ESCROW, amount, proverTip: 2n, withdrawal },
    })

    const userPayload = plainUserPayload(ESCROW)
    const args = vi.mocked(buildSponsoredTeeOperation).mock.calls[0]![1]
    expect(args.operations).toHaveLength(2)
    // The claim pays the account on L2; only the withdraw burns.
    expect(args.operations[0]).toMatchObject({ kind: "outerCall", withdrawals: undefined })
    expect(args.operations[1]).toMatchObject({
      kind: "withdraw",
      from: USER_ADDR,
      executor: EXECUTOR,
      userPayload,
      amount,
      proverTip: 2n,
      finalizationRequestBroadcastParams: FINALIZATION_REQUEST,
      authwitNonce: expect.any(Fr),
    })
    expect(args.plainWithdrawal).toEqual({ executor: EXECUTOR, fee: 0n })
    expect(args.teeUnsignedInteractions).toEqual([])
  })
})
