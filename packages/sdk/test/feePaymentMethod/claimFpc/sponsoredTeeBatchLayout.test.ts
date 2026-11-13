/**
 * The sponsored TEE batch's call layout and its MAX_SPONSORED_CALLS accounting, pinned at the
 * seam where the FPC payload is assembled: [account auth?, ...ops, ...teeUnsignedInteractions,
 * ...finalization requests, publish_da] — the TEE-unsigned riders (oxide `submit`'s seam of the
 * same name, carrying an escrow's L1-operation broadcast) and each withdrawal's finalization
 * request sit between the ops and `publish_da` and count against the 5-call budget. Only the sim shape is exercised; the finalized shape reuses the same assembler.
 * The last suite builds the real payload: which batches may carry intents without a signature.
 */
import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { FunctionCall, FunctionSelector, FunctionType } from "@aztec-labs/stdlib/abi"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { DEFAULT_CONTRACTS, getHardcodedArtifact } from "@obsidion/contracts"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"

import { buildSponsoredTeeOperation } from "../../../src/services/tee/sponsoredTeeOperation.js"
import { withdrawalRecoveryChunks } from "../../../src/oxide/withdrawal/plainWithdrawal.js"
import {
  KIND_BY_ADDRESS,
  KIND_BY_ANY,
  buildClaimFpcPolicy,
  buildClaimSponsorPayload,
} from "../../../src/feePaymentMethod/claimFpc/claimSponsoredCall.js"
import {
  CLAIM_FPC_BATCH_CAPS,
  claimFpcBatchGas,
  claimFpcSponsoredFee,
} from "../../../src/feePaymentMethod/claimFpc/gas/claimFpcBatchGas.js"
import { HOLDING_ADAPTERS } from "../../../src/oxide/holdings/adapters.js"
import { readHoldingRoute } from "../../../src/oxide/holdings/holdingDeployment.js"
import { buildMove } from "../../../src/oxide/holdings/moveRoute.js"
import { fakeChain, vaultHolding } from "../../oxide/holdings/holdingFixtures.js"
import { buildIntentCapsule } from "../../../src/feePaymentMethod/claimFpc/sponsoredCall.js"

const interaction = (name: string) => ({ request: async () => ({ calls: [{ name }] }) } as never)

const sponsorSpy = vi.fn<(opts: unknown) => Promise<{ shape: string }>>(async () => ({
  shape: "payload",
}))
const feeSpy = vi.fn<(policy: unknown, calls: unknown) => { shape: string }>(() => ({
  shape: "fee",
}))
const deps = {
  buildClaimSponsorPayload: sponsorSpy,
  buildClaimSubscribePayload: sponsorSpy,
  claimFpcSponsoredFee: feeSpy,
} as never

const addr = (n: number) => AztecAddress.fromNumberUnsafe(n)
const EXECUTOR = EthAddress.fromNumber(0xe0)
// Every size tier answers with one call; oxide's encoder picks the tier.
const broadcaster = {
  methods: new Proxy({}, { get: () => () => interaction("broadcast_finalization_request") }),
}

const withdrawOp = (relayerTip = 10n, proverTip = 0n) => ({
  kind: "withdraw",
  from: addr(2),
  executor: EXECUTOR,
  userPayload: encodePlainWithdrawalPayload({ recipient: EthAddress.fromNumber(0xa1), relayerTip }),
  amount: 1_000n,
  proverTip,
  finalizationRequestBroadcastParams: {
    broadcaster,
    portal: EthAddress.fromNumber(0xb0),
    payoutToken: EthAddress.fromNumber(0xb1),
  },
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
    plainWithdrawal: { executor: EXECUTOR, fee: 0n },
    ...over,
  } as never)

const ctx = { wallet: {}, node: {} } as never
const build = (over: Record<string, unknown> = {}) =>
  buildSponsoredTeeOperation(ctx, args(over), deps)

describe("buildSponsoredTeeOperation batch layout", () => {
  it("slots TEE-unsigned riders between the ops and publish_da", async () => {
    sponsorSpy.mockClear()
    feeSpy.mockClear()
    const result = await build({
      teeUnsignedInteractions: [interaction("broadcast_l1_operation_2k")],
    })

    expect(result.payload).toEqual({ shape: "payload" })
    const assembled = sponsorSpy.mock.calls[0]![0] as unknown as {
      innerCalls: { name: string }[]
      classWitnesses: unknown[]
    }
    // Sim shape (publish_da joins at finalize): auth, op, unsigned, finalization request — in
    // oxide submit's order.
    expect(assembled.innerCalls.map((c) => c.name)).toEqual([
      "authorize_intents",
      "withdraw",
      "broadcast_l1_operation_2k",
      "broadcast_finalization_request",
    ])
    // Riders match by address or ByAny — no class witness.
    expect(assembled.classWitnesses).toEqual([{ leaf: 0 }, undefined, undefined, undefined])
    // The declared fee prices the burn at the recovery chunks it emits, the rider, and the
    // publish_da the finalized batch appends.
    const [auth, burn, ...rest] = assembled.innerCalls
    expect(feeSpy.mock.calls[0]![1]).toEqual([
      auth,
      { ...burn, recoveryChunks: 1 },
      ...rest,
      { name: "publish_da" },
    ])
  })

  it("counts riders against MAX_SPONSORED_CALLS", async () => {
    // auth + op + rider + finalization request + publish_da fills the budget exactly.
    await expect(build({ teeUnsignedInteractions: [interaction("a")] })).resolves.toBeDefined()
    await expect(
      build({ teeUnsignedInteractions: [interaction("a"), interaction("b")] }),
    ).rejects.toThrow(/6 calls.*at most 5/)
  })
})

describe("buildSponsoredTeeOperation per-call pricing", () => {
  // Names each broadcast by its size tier, as the real Broadcaster does.
  const tiered = {
    methods: new Proxy({}, { get: (_, method) => () => interaction(String(method)) }),
  }
  const fourChunkBurn = {
    ...withdrawOp(),
    recoveryMemo: Buffer.alloc(800, 7),
    finalizationRequestBroadcastParams: {
      ...withdrawOp().finalizationRequestBroadcastParams,
      broadcaster: tiered,
    },
  }
  const accountCall = { call: { name: "authorize_intents" }, classWitness: { leaf: 0 } }

  it.each([
    ["with", accountCall],
    ["without", undefined],
  ])("prices a four-chunk burn at its four chunks %s the account call", async (_, account) => {
    expect(withdrawalRecoveryChunks(fourChunkBurn as never)).toBe(4)
    const policy = await buildClaimFpcPolicy([
      { kind: KIND_BY_ADDRESS, target: new Fr(0x101n), selector: new Fr(0x202n), max_fee: 1n },
    ])
    sponsorSpy.mockClear()
    const result = await buildSponsoredTeeOperation(
      ctx,
      args({ operations: [fourChunkBurn], accountCall: account, policy }),
      { ...(deps as object), claimFpcSponsoredFee } as never,
    )
    const { innerCalls } = sponsorSpy.mock.calls[0]![0] as unknown as {
      innerCalls: { name: string }[]
    }
    const sent = [...innerCalls, { name: "publish_da" }]
    const at = (recoveryChunks: number) =>
      claimFpcBatchGas(sent.map((c) => (c.name === "withdraw" ? { ...c, recoveryChunks } : c)))
    const { gasLimits } = (result as { sendOpts: { fee: ReturnType<typeof claimFpcSponsoredFee> } })
      .sendOpts.fee.gasSettings
    expect({ daGas: gasLimits.daGas, l2Gas: gasLimits.l2Gas }).toEqual(at(4))
    expect(at(4).l2Gas).toBeGreaterThan(at(2).l2Gas)
  })
})

describe("a vault move's burn under the open policy every network commits", () => {
  const tiered = {
    methods: new Proxy({}, { get: (_, method) => () => interaction(String(method)) }),
  }
  const accountCall = { call: { name: "authorize_intents" }, classWitness: { leaf: 0 } }
  /** The largest vault burn measured on a mainnet fork: a `Psm` move sponsored by the ClaimFPC. */
  const MEASURED = { l2Gas: 962_501, daGas: 5_600 }

  /** A move into a USDS vault whose memo is the shortest that makes its burn emit `chunks`. */
  const burnOf = async (chunks: number) => {
    const route = await readHoldingRoute(
      fakeChain() as never,
      HOLDING_ADAPTERS,
      vaultHolding("DaiUsds"),
    )
    for (let length = 0; ; length += 8) {
      const { operation, recoveryChunks } = buildMove(route, {
        direction: "in",
        minOut: 1n,
        conversionMinOut: 1n,
        recipientCommitment: `0x${"01".repeat(32)}`,
        from: addr(2),
        amount: 10n ** 21n,
        proverTip: 0n,
        relayerTip: 10n ** 18n,
        recovery: { salt: new Fr(3n), account: `0x${"0a".repeat(20)}` },
        recoveryMemo: Buffer.alloc(length, 7),
      })
      if (recoveryChunks === chunks) {
        const broadcast = {
          ...withdrawOp().finalizationRequestBroadcastParams,
          broadcaster: tiered,
        }
        return { ...operation, finalizationRequestBroadcastParams: broadcast }
      }
    }
  }

  it.each(
    [4, 5, 6].flatMap((chunks) => [
      [chunks, "with", accountCall],
      [chunks, "without", undefined],
    ]),
  )("fits the batch caps at %i chunks, %s the account call", async (chunks, _, account) => {
    const policy = await buildClaimFpcPolicy([
      { kind: KIND_BY_ANY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: 1n },
    ])
    sponsorSpy.mockClear()
    const result = await buildSponsoredTeeOperation(
      ctx,
      args({ operations: [await burnOf(chunks as number)], accountCall: account, policy }),
      { ...(deps as object), claimFpcSponsoredFee } as never,
    )
    const { innerCalls } = sponsorSpy.mock.calls[0]![0] as unknown as {
      innerCalls: { name: string }[]
    }
    const metered = claimFpcBatchGas(
      [...innerCalls, { name: "publish_da" }].map((call) =>
        call.name === "withdraw" ? { ...call, recoveryChunks: chunks as number } : call,
      ),
    )
    // The model bounds a real burn, and the caps bound the model.
    expect(metered.daGas).toBeGreaterThanOrEqual(MEASURED.daGas)
    expect(metered.l2Gas).toBeGreaterThanOrEqual(MEASURED.l2Gas)
    expect(metered.daGas).toBeLessThanOrEqual(CLAIM_FPC_BATCH_CAPS.daGas)
    expect(metered.l2Gas).toBeLessThanOrEqual(CLAIM_FPC_BATCH_CAPS.l2Gas)
    const { gasLimits } = (result as { sendOpts: { fee: ReturnType<typeof claimFpcSponsoredFee> } })
      .sendOpts.fee.gasSettings
    expect({ daGas: gasLimits.daGas, l2Gas: gasLimits.l2Gas }).toEqual(CLAIM_FPC_BATCH_CAPS)
  })
})

describe("buildSponsoredTeeOperation plain withdrawals", () => {
  it("refuses a withdrawal without the deployment's plain withdrawal executor", async () => {
    sponsorSpy.mockClear()
    await expect(build({ plainWithdrawal: undefined })).rejects.toThrow(
      /needs the deployment's plain withdrawal executor/,
    )
    expect(sponsorSpy).not.toHaveBeenCalled()
  })

  it("refuses a relayer tip the executor's fee leaves it unable to pay", async () => {
    // 1_000 minus a 985 prover tip leaves the executor 15; its 6 fee leaves 9, below the 10 tip.
    const plainWithdrawal = { executor: EXECUTOR, fee: 6n }
    await expect(build({ operations: [withdrawOp(10n, 985n)], plainWithdrawal })).rejects.toThrow(
      /relayer tip 10 exceeds the amount after the fee 9/,
    )
    await expect(
      build({ operations: [withdrawOp(9n, 985n)], plainWithdrawal }),
    ).resolves.toBeDefined()
  })

  it("refuses a withdrawal that does not broadcast its finalization request", async () => {
    const silent = { ...withdrawOp(), finalizationRequestBroadcastParams: undefined }
    await expect(build({ operations: [silent] })).rejects.toThrow(
      /must broadcast its finalization request/,
    )
  })

  it("checks the withdrawals an outer call declares", async () => {
    const outerCall = {
      kind: "outerCall",
      interaction: interaction("claim_to_l1"),
      withdrawals: [withdrawOp(2_000n)],
    }
    await expect(build({ operations: [outerCall], plainWithdrawal: undefined })).rejects.toThrow(
      /needs the deployment's plain withdrawal executor/,
    )
    await expect(build({ operations: [outerCall] })).rejects.toThrow(
      /relayer tip 2000 exceeds the amount after the fee 1000/,
    )
  })

  it("leaves a withdrawal through another executor unchecked", async () => {
    const other = { ...withdrawOp(2_000n), executor: EthAddress.fromNumber(0xe1) }
    await expect(build({ operations: [other] })).resolves.toBeDefined()
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
