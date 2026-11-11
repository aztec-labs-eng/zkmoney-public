// @vitest-environment node
/** A move retried by the user, over the real driver and flow, still reaches done. */
import { createPace } from "@obsidion/core/cadence"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { RotationDriver, type BackupRotationRecord } from "@obsidion/front-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OWNER, makeFlowDeps, receipt, sent, signedRecord, word } from "../../support/backupAdd"

type Made = ReturnType<typeof makeFlowDeps>

const driver = new RotationDriver()
afterEach(() => driver.stop())

const flush = async (rounds = 1) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Past the re-root, its funding swept, with nothing moved yet. */
const rerooted = (): BackupRotationRecord =>
  signedRecord({
    phase: "rerooted",
    ...sent(5, { outcome: "swept" }),
    sweep: { index: "1", blockHash: word(0x90), credited: "1400" },
  })

function start(made: Made) {
  driver.start({
    store: made.store,
    deps: async () => made.deps,
    owns: () => true,
    pollMs: 0,
    pace: createPace(),
  })
}

/** Finalizes every transaction and approves each chunk the driver waits on, until the record is done. */
async function settleMove(made: Made, cap = 40) {
  for (let i = 0; i < cap; i++) {
    if ((await made.store.get(OWNER))?.phase === "done") return
    const drive = driver.drive(OWNER)
    if (drive?.resume?.wait === "approval" && !drive.approving) void driver.approve(OWNER)
    for (const hash of made.world.receipts.keys()) {
      made.world.receipts.set(hash, receipt(TxStatus.FINALIZED))
    }
    await flush()
  }
}

describe("a retried backup move", () => {
  it("keeps watching a retried chunk whose send failed after its hash", async () => {
    const made = makeFlowDeps()
    const send = vi.mocked(made.deps.move.send)
    const late = word(0x1f0)
    send.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    send.mockImplementationOnce(async (_token, _amount, onTxHash) => {
      await onTxHash(late, { expiresAtMs: 5000 })
      made.world.receipts.set(late, receipt(TxStatus.PENDING))
      throw new Error("wait timed out")
    })
    await made.store.put(rerooted())
    start(made)
    await flush(5)
    expect(driver.drive(OWNER)?.resume?.wait).toBe("approval")
    await driver.approve(OWNER).catch(() => {})
    await flush(5)
    await driver.retry(OWNER).catch(() => {})
    expect(send).toHaveBeenCalledTimes(2)
    await settleMove(made)
    expect((await made.store.get(OWNER))?.phase).toBe("done")
  })

  it("keeps watching the move when a retry overtakes the resume its own phase change started", async () => {
    const made = makeFlowDeps()
    // The retry plans first; the resume plans once the retry's send is out, so its write is refused.
    let retryPlans!: () => void
    let resumePlans!: () => void
    let sends!: () => void
    const retryPlanned = new Promise<void>((resolve) => (retryPlans = resolve))
    const resumePlanned = new Promise<void>((resolve) => (resumePlans = resolve))
    const sending = new Promise<void>((resolve) => (sends = resolve))
    let shapes = 0
    vi.mocked(made.deps.move.shape).mockImplementation(async () => {
      const call = ++shapes
      if (call === 1) await retryPlanned
      if (call === 2) await resumePlanned
      return made.world.shape
    })
    const send = vi.mocked(made.deps.move.send)
    const live = send.getMockImplementation()!
    send.mockImplementationOnce(async (...args: Parameters<typeof live>) => {
      resumePlans()
      await sending
      return live(...args)
    })
    await made.store.put({
      ...rerooted(),
      phase: "attention",
      attention: "move",
      suspended: "rerooted",
    })
    start(made)
    await flush(5)
    const retried = driver.retry(OWNER).catch(() => {})
    retryPlans()
    await flush(10)
    sends()
    await retried
    await settleMove(made)
    expect((await made.store.get(OWNER))?.phase).toBe("done")
    expect(shapes).toBeGreaterThanOrEqual(2)
  })
})
