/**
 * Unit tests for `ServiceBase.sendAndWait`'s `silent` option.
 *
 * `silent: true` is the seam that lets `PaylinkService.createPaylinkContract`
 * route through the shared `sendAndWait` abstraction while staying
 * behavior-neutral vs. the legacy direct `wallet.sendTx(NO_WAIT)` path it
 * replaced — that path emitted NONE of `sendAndWait`'s progress/status
 * events. These tests pin the suppression so a future edit can't silently
 * (pun intended) start emitting a tracked-tx queue row / Mining-complete /
 * reset for paylink-create.
 *
 * Suppressed under `silent: true` (asserted below):
 *   1. the four `emit("status", ...)` events
 *      (PROVING_AND_SENDING / MINING / SUCCESS / FAILED)
 *   2. the wait-phase `provingProgress.emitStageComplete(Mining)`
 *   3. the catch-block `provingProgress.emitReset()` on BOTH error paths
 *
 * The non-silent regression guard pins that omitting `silent` keeps every
 * one of those emissions firing for the rest of the SDK's flows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { TxHash } from "@aztec/stdlib/tx"
import { QueueStatus } from "@obsidion/core/constants"
import { provingProgress, ProvingStage } from "@obsidion/proving-progress"
import { ServiceBase } from "../../src/services/ServiceBase.js"
import { waitForTx } from "@aztec/aztec.js/node"

// Replace only `waitForTx` (the wait-phase mining await) so the test never
// touches a real node; preserve the rest of the module.
vi.mock("@aztec/aztec.js/node", async (importActual) => {
  const actual = await importActual<typeof import("@aztec/aztec.js/node")>()
  return { ...actual, waitForTx: vi.fn() }
})

const FAKE_TX_HASH = TxHash.fromString("0x" + "11".repeat(32))
const FAKE_FROM = { toString: () => "0xfrom" } as never

// Minimal interaction stub: `sendAndWait` only calls `.send(...)` on it (the
// profile branch is gated behind `instanceof ContractFunctionInteraction`, so
// a plain object is correctly skipped when `profile` is unset).
function makeInteraction(sendImpl?: () => Promise<unknown>) {
  return {
    send:
      sendImpl ??
      vi.fn().mockResolvedValue({
        txHash: FAKE_TX_HASH,
        offchainMessages: [],
        offchainEffects: [],
      }),
  }
}

function makeService() {
  // `wallet.node` is only forwarded to the (mocked) `waitForTx`.
  const service = new ServiceBase({ node: {} } as never)
  const statusEvents: QueueStatus[] = []
  service.on("status", (status: QueueStatus) => statusEvents.push(status))
  return { service, statusEvents }
}

const buildResult = ({ txHash, receipt }: { txHash: string; receipt: unknown }) => ({
  txHash,
  receipt,
})

const sendOptions = { from: FAKE_FROM }

describe("ServiceBase.sendAndWait — silent option", () => {
  let resetSpy: ReturnType<typeof vi.spyOn>
  let stageCompleteSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.mocked(waitForTx)
      .mockReset()
      .mockResolvedValue({} as never)
    resetSpy = vi.spyOn(provingProgress, "emitReset").mockImplementation(() => {})
    stageCompleteSpy = vi.spyOn(provingProgress, "emitStageComplete").mockImplementation(() => {})
  })

  it("silent happy path: emits no status events, no Mining-complete, no reset", async () => {
    const { service, statusEvents } = makeService()
    const initFn = async () => ({ interaction: makeInteraction() })

    const result = (service as never as ServiceBase)["sendAndWait"](initFn, buildResult, {
      sendOptions,
      kind: "paylink-create",
      silent: true,
    })

    const sent = await result.sentTx
    const final = await result.txPromise

    expect(sent.txHash).toBe(FAKE_TX_HASH.toString())
    expect(final.txHash).toBe(FAKE_TX_HASH.toString())
    expect(statusEvents).toEqual([])
    expect(stageCompleteSpy).not.toHaveBeenCalled()
    expect(resetSpy).not.toHaveBeenCalled()
  })

  it("silent init/send error: emits no status events and no reset", async () => {
    const { service, statusEvents } = makeService()
    const initFn = async () => ({
      interaction: makeInteraction(() => Promise.reject(new Error("send boom"))),
    })

    const result = (service as never as ServiceBase)["sendAndWait"](initFn, buildResult, {
      sendOptions,
      kind: "paylink-create",
      silent: true,
    })
    result.txPromise.catch(() => {})

    await expect(result.sentTx).rejects.toThrow("send boom")
    expect(statusEvents).toEqual([])
    expect(resetSpy).not.toHaveBeenCalled()
  })

  it("silent wait-phase error: emits no status events and no reset", async () => {
    vi.mocked(waitForTx).mockRejectedValue(new Error("mining boom"))
    const { service, statusEvents } = makeService()
    const initFn = async () => ({ interaction: makeInteraction() })

    const result = (service as never as ServiceBase)["sendAndWait"](initFn, buildResult, {
      sendOptions,
      kind: "paylink-create",
      silent: true,
    })

    // sentTx still resolves (send succeeded); only the wait phase fails.
    await expect(result.sentTx).resolves.toMatchObject({ txHash: FAKE_TX_HASH.toString() })
    await expect(result.txPromise).rejects.toThrow("mining boom")
    expect(statusEvents).toEqual([])
    expect(resetSpy).not.toHaveBeenCalled()
  })

  it("non-silent regression guard: still emits status + Mining-complete", async () => {
    const { service, statusEvents } = makeService()
    const initFn = async () => ({ interaction: makeInteraction() })

    const result = (service as never as ServiceBase)["sendAndWait"](initFn, buildResult, {
      sendOptions,
      kind: "send",
    })

    await result.txPromise

    expect(statusEvents).toEqual([
      QueueStatus.PROVING_AND_SENDING,
      QueueStatus.MINING,
      QueueStatus.SUCCESS,
    ])
    expect(stageCompleteSpy).toHaveBeenCalledWith(ProvingStage.Mining, undefined)
    expect(resetSpy).not.toHaveBeenCalled()
  })

  // The two error-branch guards below mirror the happy-path regression guard:
  // they pin that omitting `silent` keeps the FAILED status + `emitReset()`
  // firing on each catch block. Without them, a future edit that widened the
  // `if (!options?.silent)` suppression into the error paths would slip past
  // the success-only guard above.

  it("non-silent init/send error: still emits FAILED + reset", async () => {
    const { service, statusEvents } = makeService()
    const initFn = async () => ({
      interaction: makeInteraction(() => Promise.reject(new Error("send boom"))),
    })

    const result = (service as never as ServiceBase)["sendAndWait"](initFn, buildResult, {
      sendOptions,
      kind: "send",
    })
    result.txPromise.catch(() => {})

    await expect(result.sentTx).rejects.toThrow("send boom")
    expect(statusEvents).toEqual([QueueStatus.PROVING_AND_SENDING, QueueStatus.FAILED])
    expect(resetSpy).toHaveBeenCalledTimes(1)
  })

  it("non-silent wait-phase error: still emits FAILED + reset", async () => {
    vi.mocked(waitForTx).mockRejectedValue(new Error("mining boom"))
    const { service, statusEvents } = makeService()
    const initFn = async () => ({ interaction: makeInteraction() })

    const result = (service as never as ServiceBase)["sendAndWait"](initFn, buildResult, {
      sendOptions,
      kind: "send",
    })

    await expect(result.txPromise).rejects.toThrow("mining boom")
    expect(statusEvents).toEqual([
      QueueStatus.PROVING_AND_SENDING,
      QueueStatus.MINING,
      QueueStatus.FAILED,
    ])
    expect(resetSpy).toHaveBeenCalledTimes(1)
  })
})
