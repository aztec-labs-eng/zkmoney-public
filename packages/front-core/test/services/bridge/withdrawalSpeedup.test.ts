import { describe, expect, it, vi } from "vitest"
import type { L1RollupConstants } from "@aztec/stdlib/epoch-helpers"
import { MAX_RPC_CHECKPOINTS_DATA_LEN } from "@aztec/stdlib/interfaces/api-limit"
import type { PublicClient } from "viem"

import {
  DEFAULT_PROOF_LATENCY,
  WithdrawalSpeedupEstimator,
  estimateWithdrawalSpeedup,
  type ProofCalibration,
  type WithdrawalSpeedupNode,
} from "../../../src/core/services/bridge/withdrawalSpeedup"

const GENESIS = 1_000_000
const SLOT = 72
const EPOCH_SLOTS = 32
const EPOCH = SLOT * EPOCH_SLOTS

const constants: L1RollupConstants = {
  l1StartBlock: 0n,
  l1GenesisTime: BigInt(GENESIS),
  slotDuration: SLOT,
  epochDuration: EPOCH_SLOTS,
  ethereumSlotDuration: 12,
  proofSubmissionEpochs: 1,
  targetCommitteeSize: 48,
  rollupManaLimit: 1e9,
}

const start = (epoch: number) => GENESIS + epoch * EPOCH
/** A landing known exactly. */
const at = (seconds: number) => ({ expected: seconds, earliest: seconds, latest: seconds })
const fallback: ProofCalibration = { ...DEFAULT_PROOF_LATENCY, confidence: "fallback" }

describe("estimateWithdrawalSpeedup", () => {
  it("bounds an early-epoch tip by the unproven predecessor's projected proof", () => {
    const now = start(10) + SLOT
    const estimate = estimateWithdrawalSpeedup({
      constants,
      now,
      landing: at(60),
      calibration: fallback,
    })
    expect(estimate.epoch).toBe(10)
    // Both ETAs run from the landing, 60 s out.
    expect(now + 60 + estimate.standardEtaSeconds).toBe(start(11) + 900)
    expect(now + 60 + estimate.tippedEtaSeconds).toBe(start(10) + 900)
    expect(estimate.speedupSeconds).toBe(EPOCH)
    expect(estimate.confidence).toBe("fallback")
  })

  it("proves an early-epoch prefix right away once the predecessor is proven", () => {
    const now = start(10) + SLOT
    const estimate = estimateWithdrawalSpeedup({
      constants,
      now,
      landing: at(60),
      predecessorProvenAt: now,
      calibration: fallback,
    })
    // Lands in the epoch's second slot; the partial proof follows the landing by its latency.
    expect(estimate.checkpointIndex).toBe(2)
    expect(now + 60 + estimate.tippedEtaSeconds).toBe(start(10) + 132 + 180)
    expect(estimate.speedupSeconds).toBe(start(11) + 900 - (start(10) + 312))
  })

  it("takes the worst speedup over a landing window inside one epoch", () => {
    const now = start(10) + SLOT
    const estimate = estimateWithdrawalSpeedup({
      constants,
      now,
      landing: { expected: 60, earliest: 30, latest: 600 },
      predecessorProvenAt: now,
      calibration: fallback,
    })
    const atLatest = estimateWithdrawalSpeedup({
      constants,
      now,
      landing: at(600),
      predecessorProvenAt: now,
      calibration: fallback,
    })
    expect(estimate.speedupSeconds).toBe(start(11) + 900 - (start(10) + 312))
    expect(estimate.worstSpeedupSeconds).toBe(atLatest.speedupSeconds)
    expect(estimate.worstSpeedupSeconds).toBeGreaterThan(0)
  })

  it("still buys the full proof's latency for certain when the window reaches the epoch's end", () => {
    const now = start(10) + EPOCH - 400
    const estimate = estimateWithdrawalSpeedup({
      constants,
      now,
      // Expected mid-way; slow enough and it lands in the epoch's last second.
      landing: { expected: 100, earliest: 60, latest: 600 },
      predecessorProvenAt: now,
      calibration: fallback,
    })
    expect(estimate.epoch).toBe(10)
    expect(estimate.speedupSeconds).toBeGreaterThan(0)
    // The worst case lands in the epoch's last second: its partial proof lands 180 s later, the
    // full proof 900 s after the epoch ends.
    expect(estimate.worstSpeedupSeconds).toBe(900 - 179)
  })

  it("gains the full proof's latency for a burn in the epoch's last slot", () => {
    const now = start(10) + EPOCH - 30
    const estimate = estimateWithdrawalSpeedup({
      constants,
      now,
      landing: at(20),
      predecessorProvenAt: now,
      calibration: fallback,
    })
    expect(estimate.epoch).toBe(10)
    expect(now + 20 + estimate.tippedEtaSeconds).toBe(start(11) - 10 + 180)
    expect(estimate.speedupSeconds).toBe(900 - 170)
  })

  it("treats a burn landing after the epoch ends as early in the next one", () => {
    const now = start(10) + EPOCH - 30
    const estimate = estimateWithdrawalSpeedup({
      constants,
      now,
      landing: at(120),
      calibration: fallback,
    })
    expect(estimate.epoch).toBe(11)
    expect(now + 120 + estimate.standardEtaSeconds).toBe(start(12) + 900)
    // Bound by epoch 10's full proof.
    expect(now + 120 + estimate.tippedEtaSeconds).toBe(start(11) + 900)
    expect(estimate.speedupSeconds).toBe(EPOCH)
  })
})

/** One checkpoint per slot: checkpoint c sits in slot c and lands 60 s into it. */
const landed = (c: number) => GENESIS + c * SLOT + 60
const lastOf = (epoch: number) => epoch * EPOCH_SLOTS + EPOCH_SLOTS - 1

function mockNode(chainTip: number, proven: number) {
  const checkpoint = (c: number) => ({
    checkpointNumber: c,
    header: { slotNumber: c },
    l1: { timestamp: BigInt(landed(c)) },
  })
  const node = {
    getL1Constants: vi.fn(async () => constants),
    getL1ContractAddresses: vi.fn(async () => ({
      rollupAddress: { toString: () => "0x00000000000000000000000000000000000000aa" },
    })),
    getCheckpointNumber: vi.fn(async () => proven),
    getCheckpointsData: vi.fn(async (query: { from: number; limit: number }) => {
      const out = []
      for (let c = query.from; c < query.from + query.limit && c <= chainTip; c++)
        out.push(checkpoint(c))
      return out
    }),
  }
  return node as typeof node & WithdrawalSpeedupNode
}

function mockClient(proofs: { checkpoint: number; at: number }[], latest = 0) {
  const logs = proofs.map((p, i) => ({
    args: { checkpointNumber: BigInt(p.checkpoint) },
    blockNumber: BigInt(9_000 + i),
  }))
  const client = {
    getBlockNumber: vi.fn(async () => 10_000n),
    getContractEvents: vi.fn(async () => logs),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint; blockTag?: "latest" }) => ({
      timestamp: BigInt(
        blockNumber === undefined ? latest : proofs[Number(blockNumber) - 9_000].at,
      ),
    })),
  }
  return client as typeof client & PublicClient
}

const FULL_PROOFS = [
  { checkpoint: lastOf(3), at: start(4) + 800 },
  { checkpoint: lastOf(4), at: start(5) + 900 },
  { checkpoint: lastOf(5), at: start(6) + 1300 },
]
const PROOFS = [
  ...FULL_PROOFS,
  // Waits on epoch 5's proof: 350 s after it, at index 4.
  { checkpoint: 6 * EPOCH_SLOTS + 3, at: start(6) + 1300 + 350 },
  // Same epoch, so latency runs from landing: 550 s at index 25.
  { checkpoint: 6 * EPOCH_SLOTS + 24, at: landed(6 * EPOCH_SLOTS + 24) + 550 },
  { checkpoint: lastOf(6), at: start(7) + 1000 },
  // Waits on epoch 6's proof: 330 s at index 1.
  { checkpoint: 7 * EPOCH_SLOTS, at: start(7) + 1000 + 330 },
]

describe("WithdrawalSpeedupEstimator", () => {
  it("calibrates both latencies from recent L1 proofs", async () => {
    const node = mockNode(7 * EPOCH_SLOTS + 10, lastOf(6))
    const publicClient = mockClient(PROOFS)
    const estimator = new WithdrawalSpeedupEstimator(
      { node, publicClient },
      { now: () => start(7) + 2000 },
    )

    expect(await estimator.calibrate()).toEqual({
      fullProofSeconds: 950,
      // Median of 350, 550 and 330.
      partialProofSeconds: 350,
      confidence: "measured",
    })
    expect(publicClient.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "L2ProofVerified",
        fromBlock: 10_000n - 6n * 192n,
        toBlock: 10_000n,
      }),
    )
  })

  it("falls back when there are too few partial-proof samples", async () => {
    const node = mockNode(6 * EPOCH_SLOTS + 10, lastOf(5))
    const estimator = new WithdrawalSpeedupEstimator({
      node,
      publicClient: mockClient(FULL_PROOFS),
    })
    expect(await estimator.calibrate()).toEqual({
      ...DEFAULT_PROOF_LATENCY,
      fullProofSeconds: 900,
      confidence: "fallback",
    })
  })

  it("reads the most recent proofs when the window spans more checkpoints than one read", async () => {
    const node = mockNode(7 * EPOCH_SLOTS + 10, lastOf(6))
    const proofs = [
      { checkpoint: 5, at: start(1) },
      { checkpoint: 5 + MAX_RPC_CHECKPOINTS_DATA_LEN, at: start(7) },
    ]
    await new WithdrawalSpeedupEstimator({ node, publicClient: mockClient(proofs) }).calibrate()
    expect(node.getCheckpointsData).toHaveBeenCalledWith({
      from: 7,
      limit: MAX_RPC_CHECKPOINTS_DATA_LEN,
    })
  })

  it("skips a partial proof whose preceding proof it could not read", async () => {
    const node = mockNode(7 * EPOCH_SLOTS + 10, lastOf(6))
    const proofs = [
      // First in the window: the proof it waited on is outside it, so its latency is unknown.
      { checkpoint: 6 * EPOCH_SLOTS + 3, at: start(6) + 5_000 },
      { checkpoint: lastOf(6), at: start(7) + 1000 },
      { checkpoint: 7 * EPOCH_SLOTS, at: start(7) + 1000 + 330 },
    ]
    const estimator = new WithdrawalSpeedupEstimator(
      { node, publicClient: mockClient(proofs) },
      { minSamples: 1 },
    )
    expect(await estimator.calibrate()).toEqual({
      fullProofSeconds: 1000,
      partialProofSeconds: 330,
      confidence: "measured",
    })
  })

  it("caches calibration and never caches a failed read", async () => {
    let now = start(7)
    const node = mockNode(7 * EPOCH_SLOTS + 10, lastOf(6))
    const publicClient = mockClient(PROOFS)
    publicClient.getContractEvents.mockRejectedValueOnce(new Error("rpc down"))
    const estimator = new WithdrawalSpeedupEstimator({ node, publicClient }, { now: () => now })

    expect(await estimator.calibrate()).toEqual(fallback)
    expect((await estimator.calibrate()).confidence).toBe("measured")
    now += 299
    await estimator.calibrate()
    expect(publicClient.getContractEvents).toHaveBeenCalledTimes(2)
    now += 1
    await estimator.calibrate()
    expect(publicClient.getContractEvents).toHaveBeenCalledTimes(3)
  })

  it("reads whether the predecessor epoch is proven, on the chain's clock", async () => {
    const now = start(7) + SLOT
    // The device clock is far off; the latest L1 block says where the chain is.
    const clientWithoutProofs = mockClient([], now)

    const proven = new WithdrawalSpeedupEstimator(
      { node: mockNode(7 * EPOCH_SLOTS + 1, lastOf(6)), publicClient: clientWithoutProofs },
      { now: () => 0 },
    )
    const provenEstimate = await proven.estimate(at(60))
    expect(provenEstimate.epoch).toBe(7)
    expect(now + 60 + provenEstimate.tippedEtaSeconds).toBe(start(7) + 132 + 180)

    const unproven = new WithdrawalSpeedupEstimator(
      {
        node: mockNode(7 * EPOCH_SLOTS + 1, 6 * EPOCH_SLOTS + 5),
        publicClient: clientWithoutProofs,
      },
      { now: () => 0 },
    )
    const unprovenEstimate = await unproven.estimate(at(60))
    expect(now + 60 + unprovenEstimate.tippedEtaSeconds).toBe(start(7) + 900)
    expect(unprovenEstimate.confidence).toBe("fallback")
  })
})
