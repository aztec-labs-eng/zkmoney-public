/**
 * The self-finalize call builder, off-chain. oxide-client's recovery and portal calldata builders are
 * mocked at their module boundary; the sdk's wiring around them — which withdrawal it picks, the
 * executor gate, the withdrawal id, the relayer payload, the cheap refusals before the enclave signs,
 * and the failure classification — runs for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { encodeFunctionData, type Hex, type PublicClient } from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { TxHash } from "@aztec-labs/stdlib/tx"
import { OxidePortalAbi } from "@oxide/l1-contracts"
import { EnclaveUnavailable } from "@oxide/oxide-client/errors.js"
import { decodeExecutorRelayerPayload } from "@oxide/oxide-lib/executor.js"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { OxideTokenContract } from "@obsidion/contracts"

const mocks = vi.hoisted(() => ({
  recoverWithdrawals: vi.fn(),
  buildWithdrawalFinalizationCalldata: vi.fn(),
  resolveTxCheckpointArchive: vi.fn(),
}))

vi.mock("@oxide/oxide-client/withdrawal_recovery.js", () => ({
  recoverWithdrawals: mocks.recoverWithdrawals,
}))
vi.mock("@oxide/oxide-client/atlatl/withdrawal_finalization.js", () => ({
  buildWithdrawalFinalizationCalldata: mocks.buildWithdrawalFinalizationCalldata,
}))
vi.mock("@oxide/oxide-client/archive_ref.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveTxCheckpointArchive: mocks.resolveTxCheckpointArchive,
}))

const { buildWithdrawFinalizationCall, WithdrawFinalizationError } = await import(
  "../../src/oxide/withdrawFinalizationCall.js"
)
const { computeWithdrawalId } = await import("../../src/oxide/burnWithdrawals.js")

const PORTAL = ("0x" + "11".repeat(20)) as Hex
const EXECUTOR = ("0x" + "e0".repeat(20)) as Hex
const RECIPIENT = ("0x" + "44".repeat(20)) as Hex
const TIP_RECIPIENT = ("0x" + "7a".repeat(20)) as Hex
const BURN_TX = ("0x" + "0a".repeat(32)) as Hex
const OWNER = AztecAddress.fromBigIntUnsafe(77n)
const ARCHIVE_ROOT = new Fr(0xa11cen)

const PORTAL_DOMAIN = {
  l1Portal: EthAddress.fromString(PORTAL),
  l2Token: AztecAddress.fromBigIntUnsafe(0x0bn),
  teeRegistry: EthAddress.fromString("0x" + "12".repeat(20)),
  rollupVersion: 3n,
  l1ChainId: 11155111n,
}

function recovered(messageHash: Fr, executor: Hex = EXECUTOR) {
  return {
    txHash: TxHash.fromString(BURN_TX),
    finalizationData: {
      executor: EthAddress.fromString(executor),
      amount: 1_234n,
      proverTip: 7n,
      randomness: new Fr(0x1234n),
      withdrawalSignature: { sLo: new Fr(1n), sHi: new Fr(2n), rLo: new Fr(3n), rHi: new Fr(4n) },
      userPayload: encodePlainWithdrawalPayload({
        recipient: EthAddress.fromString(RECIPIENT),
        relayerTip: 100n,
      }),
    },
    contentHash: new Fr(0xc0n),
    messageHash,
    withdrawalIndex: 0,
    messageIndexInTx: 0,
  }
}

const FIRST = recovered(new Fr(0x51n))
const SECOND = recovered(new Fr(0x52n))
const idOf = (withdrawal: { messageHash: Fr }) =>
  computeWithdrawalId(TxHash.fromString(BURN_TX), withdrawal.messageHash).toString() as Hex

/** The portal `withdraw` calldata the enclave signs for `withdrawalId`. */
function portalWithdraw(withdrawalId: Hex): Hex {
  return encodeFunctionData({
    abi: OxidePortalAbi,
    functionName: "withdraw",
    args: [
      {
        content: {
          executor: EXECUTOR,
          userPayloadHash: `0x${"00".repeat(32)}`,
          amount: 1n,
          proverTip: 0n,
          randomness: 0n,
        },
        userPayload: "0x",
        relayerPayload: "0x",
        epochNumber: 0n,
        numCheckpointsInEpoch: 0n,
        leafIndex: 0n,
        path: [],
        checkpointNumber: 0n,
        withdrawalId,
        teeSignature: "0x",
      },
    ],
  })
}

interface ScenarioOptions {
  withdrawals?: unknown[]
  failures?: { txHash: TxHash; reason: string }[]
  /** Absent means the outbox has no covering root yet. */
  witness?: unknown
  spent?: boolean
  executor?: Hex
}

function scenario(options: ScenarioOptions = {}) {
  mocks.recoverWithdrawals.mockResolvedValue({
    withdrawals: options.withdrawals ?? [FIRST],
    failures: options.failures ?? [],
  })
  const node = {
    getL2ToL1MembershipWitness: vi.fn(async () =>
      "witness" in options ? options.witness : { leafIndex: 6n },
    ),
  }
  const wallet = { getPrivateEvents: vi.fn() }
  const signer = { signWithdrawalFinalization: vi.fn() }
  const l1 = { readContract: vi.fn(async () => options.spent ?? false) }
  return {
    node,
    wallet,
    signer,
    l1,
    deps: {
      node: node as never,
      wallet,
      signer: signer as never,
      portal: PORTAL_DOMAIN,
      executor: options.executor ?? EXECUTOR,
      l1: l1 as unknown as PublicClient,
    },
  }
}

const ARGS = { burnTxHash: BURN_TX, owner: OWNER, tipRecipient: TIP_RECIPIENT }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveTxCheckpointArchive.mockResolvedValue(ARCHIVE_ROOT)
  mocks.buildWithdrawalFinalizationCalldata.mockImplementation(async (_ctx, args) =>
    portalWithdraw(idOf(args.withdrawal)),
  )
})

describe("buildWithdrawFinalizationCall", () => {
  it("returns the portal's `withdraw` for the burn's recovered withdrawal", async () => {
    const call = await buildWithdrawFinalizationCall(scenario().deps, ARGS)

    expect(call.to).toBe(PORTAL)
    expect(call.withdrawalId).toBe(idOf(FIRST))
    expect(call.data).toBe(portalWithdraw(idOf(FIRST)))
  })

  it("recovers the owner's withdrawals of the burn tx from the token's recovery events", async () => {
    const s = scenario()
    await buildWithdrawFinalizationCall(s.deps, ARGS)

    expect(mocks.recoverWithdrawals).toHaveBeenCalledWith({
      wallet: s.wallet,
      chain: s.node,
      portal: PORTAL_DOMAIN,
      owner: OWNER,
      recoveryEventMetadata: OxideTokenContract.events.WithdrawalRecoveryChunk,
      filter: { txHash: TxHash.fromString(BURN_TX) },
    })
  })

  it("has the enclave sign the withdrawal against the archive of the burn's checkpoint", async () => {
    const s = scenario()
    await buildWithdrawFinalizationCall(s.deps, ARGS)

    expect(mocks.resolveTxCheckpointArchive).toHaveBeenCalledWith(
      s.node,
      TxHash.fromString(BURN_TX),
    )
    expect(s.node.getL2ToL1MembershipWitness).toHaveBeenCalledWith(
      TxHash.fromString(BURN_TX),
      FIRST.messageHash,
    )
    const [ctx, args] = mocks.buildWithdrawalFinalizationCalldata.mock.calls[0]!
    expect(ctx).toMatchObject({ chain: s.node, signer: s.signer, l2Token: PORTAL_DOMAIN.l2Token })
    expect(ctx.portal.address).toBe(PORTAL_DOMAIN.l1Portal)
    expect(await ctx.portal.getRollupVersion()).toBe(PORTAL_DOMAIN.rollupVersion)
    expect(ctx.portal.getChainId()).toBe(PORTAL_DOMAIN.l1ChainId)
    expect(args).toMatchObject({ withdrawal: FIRST, archiveRoot: ARCHIVE_ROOT })
  })

  it("pays the relayer tip to the caller's tip recipient", async () => {
    await buildWithdrawFinalizationCall(scenario().deps, ARGS)
    const [, built] = mocks.buildWithdrawalFinalizationCalldata.mock.calls[0]!
    const { tipRecipient } = decodeExecutorRelayerPayload(built.relayerPayload)
    expect(tipRecipient.equals(EthAddress.fromString(TIP_RECIPIENT))).toBe(true)
  })

  it("finalizes the withdrawal the index names", async () => {
    const call = await buildWithdrawFinalizationCall(
      scenario({ withdrawals: [FIRST, SECOND] }).deps,
      {
        ...ARGS,
        withdrawalIndex: 1,
      },
    )

    expect(call.withdrawalId).toBe(idOf(SECOND))
    expect(mocks.buildWithdrawalFinalizationCalldata.mock.calls[0]![1].withdrawal).toBe(SECOND)
  })

  it("names the index when the burn recovered no such withdrawal", async () => {
    await expect(
      buildWithdrawFinalizationCall(scenario().deps, { ...ARGS, withdrawalIndex: 2 }),
    ).rejects.toThrow(/recovered 1 withdrawals; no index 2/)
  })

  it("refuses a burn whose recovery data does not verify against the tx", async () => {
    const s = scenario({
      withdrawals: [],
      failures: [{ txHash: TxHash.fromString(BURN_TX), reason: "did not attest withdrawal" }],
    })
    await expect(buildWithdrawFinalizationCall(s.deps, ARGS)).rejects.toThrow(
      /did not attest withdrawal/,
    )
    expect(s.l1.readContract).not.toHaveBeenCalled()
  })

  it("refuses a burn through another executor than its record's before the enclave signs", async () => {
    const s = scenario({ executor: ("0x" + "e1".repeat(20)) as Hex })
    await expect(buildWithdrawFinalizationCall(s.deps, ARGS)).rejects.toThrow(
      /does not withdraw through executor 0xe1e1/,
    )
    expect(mocks.buildWithdrawalFinalizationCalldata).not.toHaveBeenCalled()
  })

  it("refuses an enclave signature over a different withdrawal id", async () => {
    mocks.buildWithdrawalFinalizationCalldata.mockResolvedValue(portalWithdraw(idOf(SECOND)))
    await expect(buildWithdrawFinalizationCall(scenario().deps, ARGS)).rejects.toThrow(
      /withdrawal ID does not match/,
    )
  })

  describe("failure classification", () => {
    it("reports an already-released withdrawal before the outbox read or the enclave", async () => {
      const s = scenario({ spent: true })
      const err = await buildWithdrawFinalizationCall(s.deps, ARGS).catch((e) => e)
      expect(err).toBeInstanceOf(WithdrawFinalizationError)
      expect(err.reason).toBe("already-finalized")
      expect(s.l1.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: PORTAL,
          functionName: "$isWithdrawalSpent",
          args: [idOf(FIRST)],
        }),
      )
      expect(s.node.getL2ToL1MembershipWitness).not.toHaveBeenCalled()
      expect(mocks.buildWithdrawalFinalizationCalldata).not.toHaveBeenCalled()
    })

    it("reports a burn whose epoch is not proven yet, and never calls the enclave", async () => {
      const s = scenario({ witness: undefined })
      const err = await buildWithdrawFinalizationCall(s.deps, ARGS).catch((e) => e)
      expect(err).toBeInstanceOf(WithdrawFinalizationError)
      expect(err.reason).toBe("not-yet-finalizable")
      // The signature replays the burn checkpoint's blocks; nothing runs that speculatively.
      expect(mocks.buildWithdrawalFinalizationCalldata).not.toHaveBeenCalled()
    })

    it("reports an unreachable enclave off the vendored error type, keeping the cause", async () => {
      const cause = new EnclaveUnavailable("no healthy enclave", { status: 503 })
      mocks.buildWithdrawalFinalizationCalldata.mockRejectedValue(cause)
      const err = await buildWithdrawFinalizationCall(scenario().deps, ARGS).catch((e) => e)
      expect(err).toBeInstanceOf(WithdrawFinalizationError)
      expect(err.reason).toBe("enclave-unavailable")
      expect(err.cause).toBe(cause)
    })

    it("propagates an enclave refusal rather than dressing it as an outage", async () => {
      const cause = new Error("enclave rejected the finalization")
      mocks.buildWithdrawalFinalizationCalldata.mockRejectedValue(cause)
      await expect(buildWithdrawFinalizationCall(scenario().deps, ARGS)).rejects.toBe(cause)
    })
  })
})
