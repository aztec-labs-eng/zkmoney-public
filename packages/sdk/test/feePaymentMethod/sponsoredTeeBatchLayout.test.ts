/**
 * The sponsored TEE batch's call layout and its MAX_SPONSORED_CALLS accounting, pinned at the
 * seam where the FPC payload is assembled: [account auth?, ...ops, ...teeUnsignedInteractions,
 * publish_da] — the TEE-unsigned riders (oxide `submit`'s seam of the same name, carrying the
 * withdrawal's L1-operation broadcast) sit between the ops and `publish_da` and count against the
 * 5-call budget. Only the sim shape is exercised; the finalized shape reuses the same assembler.
 * The last suite builds the real payload: which batches may carry intents without a signature.
 */
import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/foundation/eth-address"
import { FunctionCall, FunctionSelector, FunctionType } from "@aztec/stdlib/abi"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { DEFAULT_CONTRACTS, getHardcodedArtifact } from "@obsidion/contracts"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal.js"

const { sponsorSpy, feeSpy } = vi.hoisted(() => ({
  sponsorSpy: vi.fn(async (_opts: unknown) => ({ shape: "payload" })),
  feeSpy: vi.fn((_policy: unknown, _calls: unknown) => ({ shape: "fee" })),
}))
vi.mock("../../src/feePaymentMethod/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/feePaymentMethod/index.js")>()),
  buildClaimSponsorPayload: sponsorSpy,
  claimFpcSponsoredFee: feeSpy,
}))

import { buildSponsoredTeeOperation } from "../../src/services/sponsoredTeeOperation.js"
import {
  KIND_BY_ANY,
  buildClaimFpcPolicy,
  buildClaimSponsorPayload,
} from "../../src/feePaymentMethod/claimSponsoredCall.js"
import { buildIntentCapsule } from "../../src/feePaymentMethod/sponsoredCall.js"

const interaction = (name: string) => ({ request: async () => ({ calls: [{ name }] }) } as never)

const addr = (n: number) => AztecAddress.fromNumberUnsafe(n)
const EXECUTOR = EthAddress.fromNumber(0xe0)

const withdrawOp = (relayerTip = 10n) => ({
  kind: "withdraw",
  from: addr(2),
  executor: EXECUTOR,
  userPayload: encodePlainWithdrawalPayload({ recipient: EthAddress.fromNumber(0xa1), relayerTip }),
  amount: 1_000n,
  proverTip: 0n,
})

const args = (over: Record<string, unknown> = {}) =>
  ({
    fpcAddress: addr(1),
    fpcArtifact: {},
    railId: 0,
    policy: {},
    user: addr(2),
    tokenContract: { address: addr(3) },
    signer: {},
    operations: [withdrawOp()],
    buildOperationCall: () => interaction("withdraw"),
    operationClassWitnesses: [undefined],
    accountCall: { call: { name: "authorize_intents" }, classWitness: { leaf: 0 } },
    plainWithdrawal: { executor: EXECUTOR, fpcFundingCut: 0n, frozen: false },
    ...over,
  } as never)

const ctx = { wallet: {}, node: {} } as never

describe("buildSponsoredTeeOperation batch layout", () => {
  it("slots TEE-unsigned riders between the ops and publish_da", async () => {
    sponsorSpy.mockClear()
    feeSpy.mockClear()
    const result = await buildSponsoredTeeOperation(
      ctx,
      args({ teeUnsignedInteractions: [interaction("broadcast_l1_operation_2k")] }),
    )

    expect(result.payload).toEqual({ shape: "payload" })
    const assembled = sponsorSpy.mock.calls[0]![0] as unknown as {
      innerCalls: { name: string }[]
      classWitnesses: unknown[]
    }
    // Sim shape (publish_da joins at finalize): auth, op, unsigned — in oxide submit's order.
    expect(assembled.innerCalls.map((c) => c.name)).toEqual([
      "authorize_intents",
      "withdraw",
      "broadcast_l1_operation_2k",
    ])
    // Riders match by address or ByAny — no class witness.
    expect(assembled.classWitnesses).toEqual([{ leaf: 0 }, undefined, undefined])
    // The declared fee prices the rider and the publish_da the finalized batch appends.
    expect(feeSpy.mock.calls[0]![1]).toEqual([...assembled.innerCalls, { name: "publish_da" }])
  })

  it("counts riders against MAX_SPONSORED_CALLS", async () => {
    // auth + op + 2 riders + publish_da fills the budget exactly.
    await expect(
      buildSponsoredTeeOperation(
        ctx,
        args({ teeUnsignedInteractions: [interaction("a"), interaction("b")] }),
      ),
    ).resolves.toBeDefined()
    await expect(
      buildSponsoredTeeOperation(
        ctx,
        args({ teeUnsignedInteractions: [interaction("a"), interaction("b"), interaction("c")] }),
      ),
    ).rejects.toThrow(/6 calls.*at most 5/)
  })
})

describe("buildSponsoredTeeOperation plain withdrawals", () => {
  it("refuses a withdrawal without the deployment's plain withdrawal executor", async () => {
    sponsorSpy.mockClear()
    await expect(
      buildSponsoredTeeOperation(ctx, args({ plainWithdrawal: undefined })),
    ).rejects.toThrow(/needs the deployment's plain withdrawal executor/)
    expect(sponsorSpy).not.toHaveBeenCalled()
  })

  it("refuses a relayer tip the executor's share after the funding cut cannot pay", async () => {
    // 1_000 minus a 995 cut leaves the executor 5, below the 10 tip.
    const cut = { executor: EXECUTOR, fpcFundingCut: 995n, frozen: false }
    await expect(buildSponsoredTeeOperation(ctx, args({ plainWithdrawal: cut }))).rejects.toThrow(
      /relayer tip 10 exceeds executor amount 5/,
    )
    // A frozen portal takes no cut.
    await expect(
      buildSponsoredTeeOperation(ctx, args({ plainWithdrawal: { ...cut, frozen: true } })),
    ).resolves.toBeDefined()
  })

  it("checks the withdrawals an outer call declares", async () => {
    const outerCall = {
      kind: "outerCall",
      interaction: interaction("claim_to_l1"),
      withdrawals: [withdrawOp(2_000n)],
    }
    await expect(
      buildSponsoredTeeOperation(
        ctx,
        args({ operations: [outerCall], plainWithdrawal: undefined }),
      ),
    ).rejects.toThrow(/needs the deployment's plain withdrawal executor/)
    await expect(
      buildSponsoredTeeOperation(ctx, args({ operations: [outerCall] })),
    ).rejects.toThrow(/relayer tip 2000 exceeds executor amount 1000/)
  })

  it("leaves a withdrawal through another executor unchecked", async () => {
    const other = { ...withdrawOp(2_000n), executor: EthAddress.fromNumber(0xe1) }
    await expect(
      buildSponsoredTeeOperation(ctx, args({ operations: [other] })),
    ).resolves.toBeDefined()
  })
})

describe("sponsored payload intents", () => {
  const callTo = (to: AztecAddress) =>
    FunctionCall.from({
      name: "call",
      to,
      selector: FunctionSelector.fromField(new Fr(1)),
      type: FunctionType.PRIVATE,
      isStatic: false,
      hideMsgSender: false,
      args: [],
      returnTypes: [],
    })
  const intentHashes = [new Fr(7), new Fr(8)]
  const opts = async (
    innerCalls: FunctionCall[],
    over: { intentsAccount?: AztecAddress } = {},
  ) => ({
    fpcAddress: addr(1),
    fpcArtifact: await getHardcodedArtifact(DEFAULT_CONTRACTS.claimFpc),
    railId: 0,
    policy: await buildClaimFpcPolicy([
      { kind: KIND_BY_ANY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: 1n },
    ]),
    user: addr(2),
    innerCalls,
    intentHashes,
    ...over,
  })

  it("carries intents an earlier batch authorized without calling the account", async () => {
    const payload = await buildClaimSponsorPayload(await opts([callTo(addr(3))]))
    expect(payload.capsules).toEqual([buildIntentCapsule(addr(2), intentHashes)])
    expect(payload.authWitnesses).toEqual([])
  })

  it.each<[string, { intentsAccount?: AztecAddress }]>([
    ["the user", {}],
    ["the intents account", { intentsAccount: addr(4) }],
  ])("refuses a batch that calls %s without the signature", async (_, over) => {
    const account = over.intentsAccount ?? addr(2)
    await expect(
      buildClaimSponsorPayload(await opts([callTo(account), callTo(addr(3))], over)),
    ).rejects.toThrow("intentHashes provided without the combined auth witness")
  })
})
