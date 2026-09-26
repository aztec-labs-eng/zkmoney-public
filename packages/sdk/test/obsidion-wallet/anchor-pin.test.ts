/**
 * Anchor-pin tests for `ObsidionWallet`'s manual-sync discipline: while a
 * send is in flight, read-path entry points must SKIP their per-operation
 * `pxe.sync()` so a concurrent background read (e.g. a balance refresh)
 * cannot adopt a newer anchor block mid-send — adoption wipes the PXE's
 * contract-sync cache and forces witgen to re-pay the simulation's full
 * `sync_state` note-discovery cost (and re-opens the sim-vs-attestation
 * anchor-drift window the single top-of-send sync exists to close).
 *
 * Mock PXE / mock node — no sandbox required. Fixture mirrors
 * `pending-tx-store-di.test.ts`, plus a gate on `proveTx` so a send can be
 * held mid-flight deterministically.
 */
import { Fr } from "@aztec/foundation/curves/bn254"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { ExecutionPayload } from "@aztec/stdlib/tx"
import { Gas, GasSettings } from "@aztec/stdlib/gas"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { stubNodeInfo } from "../utils/obsidionWalletStubs.js"
import { stubSimulateTx } from "../utils/stubSimulateTx.js"

import { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet"
import { NO_FROM } from "@aztec/aztec.js/account"
import { provingProgress } from "@obsidion/proving-progress"

function makeStubWallet(opts?: { proveTxThrows?: unknown }) {
  const txHashStr = "0x" + "ab".repeat(32)
  const stubTx = {
    getTxHash: () => ({ toString: () => txHashStr }),
  }
  const stubProvenTx = {
    getOffchainEffects: () => [],
    publicInputs: {
      gasUsed: Gas.empty(),
      constants: {
        anchorBlockHeader: { globalVariables: { timestamp: 0 } },
      },
    },
    toTx: async () => stubTx,
  }

  // Gate that holds `proveTx` open until the test releases it, so a send can
  // be parked mid-flight while the test pokes the read paths.
  let releaseProve!: () => void
  const proveGate = new Promise<void>((resolve) => {
    releaseProve = resolve
  })

  const stubPxe: any = {
    sync: vi.fn(async () => {}),
    proveTx: vi.fn(async () => {
      await proveGate
      if (opts?.proveTxThrows) throw opts.proveTxThrows
      return stubProvenTx
    }),
    executeUtility: vi.fn(async () => ({ _stub: "utilityResult" })),
  }
  const stubNode: any = {
    sendTx: vi.fn(async () => {}),
    getTxEffect: vi.fn(async () => undefined),
    getNodeInfo: vi.fn(async () => stubNodeInfo()),
    getCurrentMinFees: vi.fn(async () => ({ mul: () => ({ mul: () => ({}) }) })),
    getBlockHeader: vi.fn(async () => ({})),
    getL1ContractAddresses: vi.fn(async () => ({ rollupAddress: "0x0" })),
  }

  const wallet = new ObsidionWallet(stubPxe, stubNode)
  ;(wallet as any).completeFeeOptions = vi.fn(async () => ({
    gasSettings: GasSettings.empty(),
    walletFeePaymentMethod: undefined,
    accountFeePaymentMethodOptions: 0,
  }))
  ;(wallet as any).simulateTxAssumingSynced = stubSimulateTx
  ;(wallet as any).getAccountFromAddress = vi.fn(async () => ({
    createTxExecutionRequest: vi.fn(async () => ({ _stub: "txRequest" })),
  }))
  ;(wallet as any).getChainInfo = vi.fn(async () => ({
    chainId: new Fr(31337),
    version: new Fr(1),
  }))
  ;(wallet as any).aztecNode = stubNode
  ;(wallet as any).log = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  return { wallet, stubPxe, stubNode, releaseProve }
}

/** Polls until `cond` holds (bounded), yielding the macrotask queue each round. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error("until(): condition not reached")
}

beforeEach(() => {
  provingProgress.removeAllListeners()
  provingProgress.clearOperationContext()
})
afterEach(() => {
  provingProgress.removeAllListeners()
  provingProgress.clearOperationContext()
  vi.restoreAllMocks() // restore any BaseWallet.prototype spies (super.* stubs)
})

describe("ObsidionWallet anchor pin", () => {
  it("reads both projections with one sync and reports the post-sync anchor", async () => {
    const { wallet, stubPxe } = makeStubWallet()
    const header = { hash: async () => new Fr(100), globalVariables: { blockNumber: 100 } }
    stubPxe.getSyncedBlockHeader = vi.fn(async () => header)
    const events = vi.spyOn(BaseWallet.prototype, "getPrivateEvents").mockResolvedValue([])
    const projection = vi.fn(async () => 42n)
    const snapshot = await wallet.getPrivateEventsSnapshot({} as any, {} as any, projection)
    expect(snapshot).toEqual({ events: [], projection: 42n, anchorBlock: 100 })
    expect(stubPxe.sync).toHaveBeenCalledTimes(1)
    expect(events).toHaveBeenCalledTimes(1)
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it.each([101, 100])(
    "rejects anchor drift including same-height reorgs (height %s)",
    async (height) => {
      const { wallet, stubPxe } = makeStubWallet()
      let header = { hash: async () => new Fr(1), globalVariables: { blockNumber: 100 } }
      stubPxe.getSyncedBlockHeader = vi.fn(async () => header)
      vi.spyOn(BaseWallet.prototype, "getPrivateEvents").mockResolvedValue([])
      const projection = async () => {
        header = { hash: async () => new Fr(2), globalVariables: { blockNumber: height } }
        return 42n
      }
      await expect(
        wallet.getPrivateEventsSnapshot({} as any, {} as any, projection),
      ).rejects.toThrow("PXE anchor changed")
    },
  )

  it("reuses the send pin without another sync when taking a snapshot", async () => {
    const { wallet, stubPxe } = makeStubWallet()
    ;(wallet as any).anchorPinDepth = 1
    stubPxe.getSyncedBlockHeader = vi.fn(async () => ({
      hash: async () => new Fr(1),
      globalVariables: { blockNumber: 90 },
    }))
    vi.spyOn(BaseWallet.prototype, "getPrivateEvents").mockResolvedValue([])
    expect(
      (await wallet.getPrivateEventsSnapshot({} as any, {} as any, async () => 7n)).anchorBlock,
    ).toBe(90)
    expect(stubPxe.sync).not.toHaveBeenCalled()
  })

  it("a read entering mid-send skips its sync; after the send it syncs again", async () => {
    const { wallet, stubPxe, releaseProve } = makeStubWallet()
    const from = await AztecAddress.random()
    const NO_WAIT_TOKEN = (await import("@aztec/aztec.js/contracts")).NO_WAIT

    const sendPromise = wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT_TOKEN,
    } as any)
    // Hold the send mid-prove: the entry sync has run, the pin is held.
    await until(() => stubPxe.proveTx.mock.calls.length === 1)
    expect(stubPxe.sync).toHaveBeenCalledTimes(1) // sendTx's own entry sync

    // Background read during the send: must execute WITHOUT syncing.
    await wallet.executeUtility({} as any, {} as any)
    expect(stubPxe.executeUtility).toHaveBeenCalledTimes(1)
    expect(stubPxe.sync).toHaveBeenCalledTimes(1) // unchanged — pin held

    // Standalone simulateTx during the send: same rule.
    await wallet.simulateTx(new ExecutionPayload([], [], [], []), { from } as any)
    expect(stubPxe.sync).toHaveBeenCalledTimes(1) // still pinned

    // getPrivateEvents + profileTx during the send: same rule. All FOUR
    // read-path entry points are gated, not just executeUtility/simulateTx.
    // Stub the `super.*` legs so the overrides' sync-gating is what's exercised
    // (not BaseWallet's PXE plumbing).
    const superGetPrivateEvents = vi
      .spyOn(BaseWallet.prototype, "getPrivateEvents")
      .mockResolvedValue([])
    const superProfileTx = vi.spyOn(BaseWallet.prototype, "profileTx").mockResolvedValue({} as any)
    await wallet.getPrivateEvents({ eventSelector: {}, abiType: {} } as any, {} as any)
    await wallet.profileTx(new ExecutionPayload([], [], [], []), { from } as any)
    expect(superGetPrivateEvents).toHaveBeenCalledTimes(1)
    expect(superProfileTx).toHaveBeenCalledTimes(1)
    expect(stubPxe.sync).toHaveBeenCalledTimes(1) // still pinned — every read path

    releaseProve()
    await sendPromise

    // Pin released: the next read syncs for per-operation freshness again.
    await wallet.executeUtility({} as any, {} as any)
    expect(stubPxe.sync).toHaveBeenCalledTimes(2)
  })

  it("releases the pin when the send fails (read paths sync again)", async () => {
    const boom = new Error("prove exploded")
    const { wallet, stubPxe, releaseProve } = makeStubWallet({ proveTxThrows: boom })
    const from = await AztecAddress.random()

    const sendPromise = wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: undefined,
    } as any)
    sendPromise.catch(() => {}) // primary assertion below; avoid unhandled-rejection noise
    await until(() => stubPxe.proveTx.mock.calls.length === 1)
    releaseProve()
    await expect(sendPromise).rejects.toThrow("prove exploded")

    await wallet.executeUtility({} as any, {} as any)
    // 1 entry sync (failed send) + 1 read sync after release.
    expect(stubPxe.sync).toHaveBeenCalledTimes(2)
  })

  it("back-to-back sends each adopt a fresh anchor (pin does not outlive a send)", async () => {
    const { wallet, stubPxe, releaseProve } = makeStubWallet()
    const from = await AztecAddress.random()
    const NO_WAIT_TOKEN = (await import("@aztec/aztec.js/contracts")).NO_WAIT

    releaseProve() // no need to hold mid-flight here
    await wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT_TOKEN,
    } as any)
    await wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT_TOKEN,
    } as any)
    expect(stubPxe.sync).toHaveBeenCalledTimes(2) // one entry sync per send
  })

  it("a concurrent second send rides the first send's anchor (no re-sync) and rejects", async () => {
    const { wallet, stubPxe, releaseProve } = makeStubWallet()
    const from = await AztecAddress.random()
    const NO_WAIT_TOKEN = (await import("@aztec/aztec.js/contracts")).NO_WAIT

    const sendA = wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT_TOKEN,
    } as any)
    await until(() => stubPxe.proveTx.mock.calls.length === 1)
    expect(stubPxe.sync).toHaveBeenCalledTimes(1)

    // Second send while A holds the pin: must NOT adopt a newer anchor at
    // its entry (the harm the pin exists to prevent) — it proceeds on A's
    // anchor and dies at the proving scope's single-flight guard.
    const sendB = wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT_TOKEN,
    } as any)
    await expect(sendB).rejects.toThrow()
    expect(stubPxe.sync).toHaveBeenCalledTimes(1) // B never synced

    releaseProve()
    await sendA // A unaffected by B's rejection

    // Both pins released: reads sync again.
    await wallet.executeUtility({} as any, {} as any)
    expect(stubPxe.sync).toHaveBeenCalledTimes(2)
  })

  it("a throwing proving-progress listener cannot leak the pin", async () => {
    const { wallet, stubPxe, releaseProve } = makeStubWallet()
    const from = await AztecAddress.random()
    releaseProve()

    const thrower = () => {
      throw new Error("listener exploded")
    }
    provingProgress.on("reset", thrower)
    try {
      await expect(
        wallet.sendTx(new ExecutionPayload([], [], [], []), {
          from,
          wait: undefined,
        } as any),
      ).rejects.toThrow("listener exploded")
    } finally {
      provingProgress.off("reset", thrower)
    }

    // Pin must have been released despite the pre-flight throw.
    await wallet.executeUtility({} as any, {} as any)
    expect(stubPxe.sync).toHaveBeenCalledTimes(2) // 1 entry sync + 1 read sync
  })

  it("releases the pin on a NO_FROM send", async () => {
    const { wallet, stubPxe, releaseProve } = makeStubWallet()
    releaseProve()
    const NO_WAIT_TOKEN = (await import("@aztec/aztec.js/contracts")).NO_WAIT

    // NO_FROM (signerless deploys, FPC-sponsored batches) rides the same send
    // path as an account send, but builds its request through upstream's
    // DefaultEntrypoint. Stub that leg so the pin is what the test exercises,
    // not upstream's entrypoint plumbing.
    const superBuildRequest = vi
      .spyOn(BaseWallet.prototype, "createTxExecutionRequestFromPayloadAndFee")
      .mockResolvedValue({ _stub: "txRequest" } as any)

    await wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from: NO_FROM,
      wait: NO_WAIT_TOKEN,
    } as any)
    expect(superBuildRequest).toHaveBeenCalledTimes(1)
    expect(stubPxe.sync).toHaveBeenCalledTimes(1) // NO_FROM still runs the entry sync

    // Pin released by the send's finally: the next read syncs again.
    await wallet.executeUtility({} as any, {} as any)
    expect(stubPxe.sync).toHaveBeenCalledTimes(2)
  })

  it("an entry-sync failure releases the pin", async () => {
    const { wallet, stubPxe, releaseProve } = makeStubWallet()
    const from = await AztecAddress.random()
    releaseProve()
    stubPxe.sync.mockImplementationOnce(async () => {
      throw new Error("sync exploded")
    })

    await expect(
      wallet.sendTx(new ExecutionPayload([], [], [], []), {
        from,
        wait: undefined,
      } as any),
    ).rejects.toThrow("sync exploded")

    await wallet.executeUtility({} as any, {} as any)
    expect(stubPxe.sync).toHaveBeenCalledTimes(2) // failed entry sync + read sync
  })
})
