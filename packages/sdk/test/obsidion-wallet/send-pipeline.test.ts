/**
 * Send-pipeline tests for `ObsidionWallet`: single-flight enforcement, sequential
 * sends, and recovery after a failed prove.
 *
 * These exercise the wallet boundary using mock PXE / mock node — no sandbox
 * required. The mock `proveTx` resolves on a controllable trigger, so a second
 * send can be started at a chosen point in the first one's lifetime.
 */
import { Fr } from "@aztec/foundation/curves/bn254"
import { NO_WAIT } from "@aztec/aztec.js/contracts"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { ExecutionPayload } from "@aztec/stdlib/tx"
import { Gas, GasSettings } from "@aztec/stdlib/gas"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { stubNodeInfo } from "../utils/obsidionWalletStubs.js"
import { stubSimulateTx } from "../utils/stubSimulateTx.js"

import {
  InMemoryPendingTxStore,
  type IPendingTxStore,
  type PendingTxRecord,
} from "../../src/obsidion/pending/index.js"
import { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"
import { provingProgress } from "@obsidion/proving-progress"

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns a deferred whose resolve/reject are callable from outside the
 * promise constructor. Used to control mock `pxe.proveTx` settling.
 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Drain microtasks until `predicate()` returns truthy or `maxTicks` is reached.
 * Used to wait for the wallet's `sendTx` to reach a known synchronous seam
 * (e.g. `pxe.proveTx` having been called) without artificial timing.
 */
async function settleUntil(predicate: () => boolean, maxTicks = 20): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return
    await Promise.resolve()
  }
}

interface StubBuild {
  wallet: ObsidionWallet
  stubPxe: any
  stubNode: any
  proveTxDeferreds: ReturnType<typeof deferred<any>>[]
  proveTxCallCount: () => number
  store: IPendingTxStore
  txHash: string
}

/**
 * Build a wallet with controllable `pxe.proveTx`. Each call returns a fresh
 * deferred whose `.resolve(provenTx)` or `.reject(err)` lets the test drive
 * timing.
 */
function buildStubWallet(opts?: {
  txHash?: string
  pendingTxStore?: IPendingTxStore
  proveTxThrowsSync?: unknown
}): StubBuild {
  const txHash = opts?.txHash ?? "0x" + "ab".repeat(32)
  const proveTxDeferreds: ReturnType<typeof deferred<any>>[] = []

  const stubTx = {
    getTxHash: () => ({ toString: () => txHash }),
  }
  const stubProvenTx = {
    getOffchainEffects: () => [],
    publicInputs: {
      gasUsed: Gas.empty(),
      constants: { anchorBlockHeader: { globalVariables: { timestamp: 0 } } },
    },
    toTx: async () => stubTx,
  }

  const stubPxe: any = {
    // Manual-sync discipline: wallet sync points call `pxe.sync()`. Stubs
    // provide a no-op so wallet methods can run.
    sync: vi.fn(async () => {}),
    proveTx: vi.fn(async () => {
      if (opts?.proveTxThrowsSync) throw opts.proveTxThrowsSync
      const d = deferred<any>()
      proveTxDeferreds.push(d)
      // Default: resolve to stubProvenTx unless the test rejects it.
      return await d.promise.then(
        (v) => v ?? stubProvenTx,
        (e) => {
          throw e
        },
      )
    }),
  }
  const stubNode: any = {
    sendTx: vi.fn(async () => {}),
    getTxEffect: vi.fn(async () => undefined),
    getNodeInfo: vi.fn(async () => stubNodeInfo()),
    getCurrentMinFees: vi.fn(async () => ({ mul: () => ({ mul: () => ({}) }) })),
    getBlockHeader: vi.fn(async () => ({})),
    getL1ContractAddresses: vi.fn(async () => ({ rollupAddress: "0x0" })),
  }

  const store = opts?.pendingTxStore ?? new InMemoryPendingTxStore()
  const wallet = new ObsidionWallet(stubPxe, stubNode, { pendingTxStore: store })

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

  return {
    wallet,
    stubPxe,
    stubNode,
    proveTxDeferreds,
    proveTxCallCount: () => (stubPxe.proveTx as any).mock.calls.length,
    store,
    txHash,
  }
}

beforeEach(() => {
  provingProgress.removeAllListeners()
  provingProgress.clearOperationContext()
})
afterEach(() => {
  provingProgress.removeAllListeners()
  provingProgress.clearOperationContext()
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("ObsidionWallet — send pipeline", () => {
  it("happy path: sendTx with no cancel completes normally and persists the record", async () => {
    const { wallet, stubNode, store, proveTxDeferreds } = buildStubWallet()
    const from = await AztecAddress.random()
    const sendPromise = wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT,
    } as any)
    await settleUntil(() => proveTxDeferreds.length === 1)
    proveTxDeferreds[0]!.resolve(undefined)
    const result = (await sendPromise) as any
    expect(stubNode.sendTx).toHaveBeenCalledTimes(1)
    const list = await store.list()
    expect(list.length).toBe(1)
    void result
  })

  it("second send while the first proves throws LocalProvingInFlight", async () => {
    const { wallet, proveTxDeferreds } = buildStubWallet()
    const from = await AztecAddress.random()
    const p1 = wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT,
    } as any)
    await settleUntil(() => proveTxDeferreds.length === 1)
    await expect(
      wallet.sendTx(new ExecutionPayload([], [], [], []), { from, wait: NO_WAIT } as any),
    ).rejects.toMatchObject({ name: "LocalProvingInFlight" })
    proveTxDeferreds[0]!.resolve(undefined)
    await p1
  })

  it("second send during the first's entry sync throws LocalProvingInFlight without syncing", async () => {
    const { wallet, stubPxe, proveTxDeferreds } = buildStubWallet()
    const from = await AztecAddress.random()
    const sync = deferred<void>()
    stubPxe.sync.mockImplementationOnce(() => sync.promise)
    const p1 = wallet.sendTx(new ExecutionPayload([], [], [], []), { from, wait: NO_WAIT } as any)
    await settleUntil(() => stubPxe.sync.mock.calls.length === 1)
    await expect(
      wallet.sendTx(new ExecutionPayload([], [], [], []), { from, wait: NO_WAIT } as any),
    ).rejects.toMatchObject({ name: "LocalProvingInFlight" })
    expect(stubPxe.sync).toHaveBeenCalledTimes(1)
    sync.resolve()
    await settleUntil(() => proveTxDeferreds.length === 1)
    proveTxDeferreds[0]!.resolve(undefined)
    await expect(p1).resolves.toBeDefined()
  })

  it("sequential sends: tx A completes, tx B succeeds (regression)", async () => {
    const { wallet, proveTxDeferreds } = buildStubWallet()
    const from = await AztecAddress.random()
    const p1 = wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT,
    } as any)
    await settleUntil(() => proveTxDeferreds.length === 1)
    proveTxDeferreds[0]!.resolve(undefined)
    await p1
    // Now tx B starts fresh.
    const p2 = wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT,
    } as any)
    await settleUntil(() => proveTxDeferreds.length === 2)
    proveTxDeferreds[1]!.resolve(undefined)
    await expect(p2).resolves.toBeDefined()
  })

  it("stale-signal: prove throws generic error → context cleared, B can start fresh", async () => {
    const { wallet, proveTxDeferreds } = buildStubWallet()
    const from = await AztecAddress.random()
    const p1 = wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT,
    } as any)
    await settleUntil(() => proveTxDeferreds.length === 1)
    proveTxDeferreds[0]!.reject(new Error("circuit failed"))
    await expect(p1).rejects.toThrow(/circuit failed/)
    expect(provingProgress.getCurrentOperationContext()).toBeUndefined()
    // Tx B can now start.
    const p2 = wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT,
    } as any)
    await settleUntil(() => proveTxDeferreds.length >= 2)
    proveTxDeferreds[1]!.resolve(undefined)
    await expect(p2).resolves.toBeDefined()
  })
})
