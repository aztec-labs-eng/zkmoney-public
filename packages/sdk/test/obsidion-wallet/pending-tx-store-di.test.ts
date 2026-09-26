/**
 * Construction-time DI + persistence-timing tests for `ObsidionWallet`'s
 * `pendingTxStore`. These exercise the wallet boundary using
 * mock PXE / mock node — no sandbox required.
 */
import { Fr } from "@aztec/foundation/curves/bn254"
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
import { ObsidionAlphaTestWallet } from "../../src/obsidion/ObsidionAlphaTestWallet.js"
import { provingProgress } from "@obsidion/proving-progress"

// ─── Test doubles ──────────────────────────────────────────────────────────

class RecordingPendingTxStore implements IPendingTxStore {
  public createCalls: { record: PendingTxRecord; at: number }[] = []
  public throwOnCreate: Error | undefined = undefined
  private readonly inner = new InMemoryPendingTxStore()

  async create(record: PendingTxRecord): Promise<void> {
    if (this.throwOnCreate) throw this.throwOnCreate
    this.createCalls.push({ record, at: Date.now() })
    return this.inner.create(record)
  }
  load() {
    return this.inner.load()
  }
  get(txHash: string) {
    return this.inner.get(txHash)
  }
  list() {
    return this.inner.list()
  }
  listExpired() {
    return this.inner.listExpired()
  }
  patch(txHash: string, fields: Partial<Omit<PendingTxRecord, "txHash">>) {
    return this.inner.patch(txHash, fields)
  }
  remove(txHash: string) {
    return this.inner.remove(txHash)
  }
  removeExpired(txHash: string) {
    return this.inner.removeExpired(txHash)
  }
  clearAll() {
    return this.inner.clearAll()
  }
  onUpdated(listener: (h: string) => void) {
    return this.inner.onUpdated(listener)
  }
  onListChanged(listener: (records: readonly PendingTxRecord[]) => void) {
    return this.inner.onListChanged(listener)
  }
}

function makeStubWallet(opts?: {
  pendingTxStore?: IPendingTxStore
  proveTxResult?: any
  proveTxThrows?: unknown
  sendTxThrows?: unknown
  txHash?: string
  trackTimes?: { sendTxAt?: number }
}) {
  const trackTimes = opts?.trackTimes ?? {}
  const txHashStr = opts?.txHash ?? "0x" + "ab".repeat(32)

  const stubTx = {
    getTxHash: () => ({ toString: () => txHashStr }),
  }
  const stubProvenTx = opts?.proveTxResult ?? {
    getOffchainEffects: () => [],
    publicInputs: {
      gasUsed: Gas.empty(),
      constants: {
        anchorBlockHeader: { globalVariables: { timestamp: 0 } },
      },
    },
    toTx: async () => stubTx,
  }

  const stubPxe: any = {
    // Manual-sync discipline: wallet sync points call `pxe.sync()`. Stubs provide a no-op so wallet methods can run.
    sync: vi.fn(async () => {}),
    proveTx: vi.fn(async () => {
      if (opts?.proveTxThrows) throw opts.proveTxThrows
      return stubProvenTx
    }),
  }
  const stubNode: any = {
    sendTx: vi.fn(async () => {
      trackTimes.sendTxAt = Date.now()
      if (opts?.sendTxThrows) throw opts.sendTxThrows
    }),
    getTxEffect: vi.fn(async () => undefined),
    getNodeInfo: vi.fn(async () => stubNodeInfo()),
    getCurrentMinFees: vi.fn(async () => ({ mul: () => ({ mul: () => ({}) }) })),
    getBlockHeader: vi.fn(async () => ({})),
    getL1ContractAddresses: vi.fn(async () => ({ rollupAddress: "0x0" })),
  }

  const wallet = new ObsidionWallet(stubPxe, stubNode, {
    pendingTxStore: opts?.pendingTxStore,
  })

  // The wallet's `sendTx` calls `this.completeFeeOptions`,
  // `getAccountFromAddress`, and `simulateTx` (pre-prove) — stub them to
  // bypass real entrypoint plumbing.
  ;(wallet as any).completeFeeOptions = vi.fn(async () => ({
    gasSettings: GasSettings.empty(),
    walletFeePaymentMethod: undefined,
    accountFeePaymentMethodOptions: 0,
  }))
  ;(wallet as any).simulateTxAssumingSynced = stubSimulateTx
  ;(wallet as any).getAccountFromAddress = vi.fn(async () => ({
    createTxExecutionRequest: vi.fn(async () => ({
      // Minimal TxExecutionRequest stub — only used to feed pxe.proveTx.
      _stub: "txRequest",
    })),
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
  return { wallet, stubPxe, stubNode, txHashStr, stubProvenTx, trackTimes }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  provingProgress.removeAllListeners()
  provingProgress.clearOperationContext()
})
afterEach(() => {
  provingProgress.removeAllListeners()
  provingProgress.clearOperationContext()
})

describe("ObsidionWallet — pendingTxStore DI", () => {
  it("defaults to InMemoryPendingTxStore when no opts.pendingTxStore is provided", () => {
    const stubPxe: any = {}
    const stubNode: any = {}
    const wallet = new ObsidionWallet(stubPxe, stubNode)
    expect(wallet.pendingTxStore).toBeInstanceOf(InMemoryPendingTxStore)
  })

  it("uses an injected store when provided", () => {
    const injected = new RecordingPendingTxStore()
    const stubPxe: any = {}
    const stubNode: any = {}
    const wallet = new ObsidionWallet(stubPxe, stubNode, { pendingTxStore: injected })
    expect(wallet.pendingTxStore).toBe(injected)
  })

  // The test must hit the FACTORY path (not the constructor): a factory that drops `walletOpts`
  // leaves test-mode wallets on a local in-memory store that `TxLifecycleService` never observes,
  // and a constructor-only test would not notice.
  it("ObsidionAlphaTestWallet.createWithPXE forwards walletOpts (pendingTxStore)", async () => {
    const injected = new RecordingPendingTxStore()
    const stubPxe: any = {}
    const stubNode: any = {}
    const wallet = await ObsidionAlphaTestWallet.createWithPXE(stubPxe, stubNode, {
      pendingTxStore: injected,
    })
    expect(wallet.pendingTxStore).toBe(injected)
  })

  it("persists a record adjacent to node.sendTx (submit-then-write ordering)", async () => {
    const store = new RecordingPendingTxStore()
    const trackTimes: { sendTxAt?: number } = {}
    const { wallet, stubNode } = makeStubWallet({
      pendingTxStore: store,
      trackTimes,
    })

    const from = await AztecAddress.random()
    const NO_WAIT_TOKEN = (await import("@aztec/aztec.js/contracts")).NO_WAIT
    const result = (await wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT_TOKEN,
    } as any)) as any

    // sendTx must have invoked node.sendTx exactly once and persisted exactly one record.
    expect(stubNode.sendTx).toHaveBeenCalledTimes(1)
    expect(store.createCalls.length).toBe(1)
    // Submit-then-write: pendingTxStore.create runs AT or AFTER node.sendTx.
    expect(store.createCalls[0]!.at).toBeGreaterThanOrEqual(trackTimes.sendTxAt!)
    // The record is present in the store at sendTx resolution.
    const txHash = result.txHash?.toString?.() ?? result.receipt?.txHash?.toString?.()
    if (txHash) {
      const stored = await wallet.pendingTxStore.get(txHash)
      expect(stored).toBeDefined()
    }
  })

  it("a pendingTxStore.create that throws bubbles to the caller", async () => {
    const store = new RecordingPendingTxStore()
    store.throwOnCreate = new Error("storage write failed")
    const { wallet } = makeStubWallet({ pendingTxStore: store })

    const from = await AztecAddress.random()
    await expect(
      wallet.sendTx(new ExecutionPayload([], [], [], []), {
        from,
        wait: undefined,
      } as any),
    ).rejects.toThrow("storage write failed")
  })

  it("wait: NO_WAIT returns { txHash } and does not spawn an internal poller", async () => {
    const store = new RecordingPendingTxStore()
    const { wallet, stubNode } = makeStubWallet({ pendingTxStore: store })

    const from = await AztecAddress.random()
    const NO_WAIT_TOKEN = (await import("@aztec/aztec.js/contracts")).NO_WAIT
    const result = await wallet.sendTx(new ExecutionPayload([], [], [], []), {
      from,
      wait: NO_WAIT_TOKEN,
    } as any)

    expect((result as any).txHash).toBeDefined()
    expect(stubNode.sendTx).toHaveBeenCalledTimes(1)
    // The wallet itself does not implement post-submit polling — TxLifecycleService does.
    // We assert it indirectly: no extra calls to node beyond sendTx + initial getTxEffect.
    // (getTxEffect is called once pre-submit to detect a settled-tx collision.)
    expect((stubNode.getTxEffect as any).mock.calls.length).toBe(1)
  })
})
