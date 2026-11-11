/** A second send waits for the first to release the anchor pin, instead of failing at once. */
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { Gas, GasFees } from "@aztec-labs/stdlib/gas"
import {
  MinedTxReceipt,
  PendingTxReceipt,
  TxExecutionResult,
  TxHash,
  TxStatus,
} from "@aztec-labs/stdlib/tx"
import { TxSimulationResultWithAppOffset } from "@aztec-labs/aztec.js/wallet"
import { BaseWallet } from "@aztec-labs/wallet-sdk/base-wallet"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"
import { serialTurns } from "../../src/obsidion/sendTurns.js"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("serialTurns", () => {
  it("runs turns in call order, and a failed turn lets the next one run", async () => {
    const turns = serialTurns()
    const first = deferred()
    const order: string[] = []
    const a = turns.turn(async () => {
      order.push("a")
      await first.promise
      throw new Error("a failed")
    })
    const b = turns.turn(async () => void order.push("b"))
    await flush()
    expect(order).toEqual(["a"])
    first.resolve()
    await expect(a).rejects.toThrow()
    await b
    expect(order).toEqual(["a", "b"])
  })
})

describe("ObsidionWallet send turns", () => {
  it("starts a second send's entry sync only once the first send ended", async () => {
    const syncs: ReturnType<typeof deferred>[] = []
    const pxe = {
      sync: () => {
        const sync = deferred()
        syncs.push(sync)
        return sync.promise
      },
    }
    // The stub node answers nothing, so each send fails right after its entry sync.
    const wallet = new ObsidionWallet(pxe as never, {} as never, "0xrollup")
    const first = wallet.sendTx({} as never, {} as never)
    const second = wallet.sendTx({} as never, {} as never)
    const firstEnded = expect(first).rejects.toBeDefined()
    const secondEnded = expect(second).rejects.toBeDefined()
    await flush()
    expect(syncs).toHaveLength(1)

    syncs[0]!.resolve()
    await firstEnded
    await flush()
    expect(syncs).toHaveLength(2)
    syncs[1]!.resolve()
    await secondEnded
  })
})

/**
 * A wallet over a fake PXE and node whose sends each submit a tx that expires `expiresInS` after
 * it is proven. The node holds every tx pending until the test sets `chain.mined`, and fails the
 * next `chain.failedReads` receipt reads; the pace moves the clock by each wait. `waits` records
 * what the sends report of their wait for the last tx.
 */
function sendsOverFakeChain(expiresInS = 0) {
  const chain = { mined: false, failedReads: 0 }
  const sent: string[] = []
  const syncs: { mined: boolean; at: number }[] = []
  const pxe = {
    sync: async () => void syncs.push({ mined: chain.mined, at: Date.now() }),
    getSyncedBlockHeader: async () => ({ globalVariables: { blockNumber: 1 } }),
    proveTx: async () => ({
      publicInputs: {
        gasUsed: Gas.empty(),
        expirationTimestamp: expiresInS ? BigInt(Math.floor(Date.now() / 1000) + expiresInS) : 0n,
        constants: { anchorBlockHeader: { globalVariables: { timestamp: 0n } } },
      },
      getOffchainEffects: () => [],
      toTx: async () => ({ getTxHash: () => TxHash.fromField(new Fr(sent.length + 1)) }),
    }),
  }
  const node = {
    getNodeInfo: async () => ({
      l1ChainId: 1,
      rollupVersion: 1,
      txsLimits: { gas: { daGas: 1e9, l2Gas: 1e9 } },
    }),
    getTxEffect: async () => undefined,
    sendTx: async (tx: { getTxHash(): TxHash }) => void sent.push(tx.getTxHash().toString()),
    getTxReceipt: async (hash: TxHash) => {
      if (chain.failedReads > 0) {
        chain.failedReads--
        throw new Error("node unreachable")
      }
      return chain.mined
        ? new MinedTxReceipt(
            hash,
            TxStatus.PROPOSED,
            TxExecutionResult.SUCCESS,
            1n,
            {} as never,
            1 as never,
            1 as never,
            0,
            1 as never,
            undefined,
          )
        : new PendingTxReceipt(hash, undefined)
    },
  }
  vi.spyOn(BaseWallet.prototype, "simulateViaEntrypoint").mockResolvedValue(
    TxSimulationResultWithAppOffset.fromResultAndOffset(
      {
        privateExecutionResult: {
          entrypoint: { offchainEffects: [], nestedExecutionResults: [] },
        },
        publicInputs: { gasUsed: Gas.empty() },
      } as never,
      0,
    ),
  )
  vi.spyOn(BaseWallet.prototype, "createTxExecutionRequestFromPayloadAndFee").mockResolvedValue(
    {} as never,
  )
  const waits: boolean[] = []
  const progress = { stage: () => {}, lastSendWait: (waiting: boolean) => void waits.push(waiting) }
  const turns = serialTurns()
  const wallet = new ObsidionWallet(pxe as never, node as never, "0xrollup", {
    prover: { turn: (send) => turns.turn(() => send(progress)) },
    pace: {
      wait: async (ms) => {
        vi.setSystemTime(Date.now() + ms)
        await flush()
      },
    },
  })
  const payload = { calls: [{}], authWitnesses: [], capsules: [], extraHashedArgs: [] }
  const send = (wait?: typeof NO_WAIT) =>
    wallet.sendTx(
      payload as never,
      { from: NO_FROM, wait, fee: { gasSettings: { maxFeesPerGas: new GasFees(1, 1) } } } as never,
    )
  return { chain, sent, syncs, waits, send }
}

describe("ObsidionWallet sends after a send that did not wait", () => {
  // A pending tx's nullifiers reach the PXE only in a block: an earlier sync re-selects its notes.
  it("syncs the next send only once a block includes the last one's tx", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { chain, sent, syncs, send } = sendsOverFakeChain()

    await send(NO_WAIT)
    const second = send(NO_WAIT)
    await flush()
    expect(syncs.map((s) => s.mined)).toEqual([false])
    chain.mined = true
    await second
    expect(syncs.map((s) => s.mined)).toEqual([false, true])
    expect(sent).toHaveLength(2)
  })

  it("reads the last tx's receipt again after a failed read, and syncs the next send only once a block includes the tx", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { chain, syncs, send } = sendsOverFakeChain()

    await send(NO_WAIT)
    chain.failedReads = 1
    const second = send(NO_WAIT)
    await flush()
    await flush()
    expect(chain.failedReads).toBe(0)
    expect(syncs).toHaveLength(1)
    chain.mined = true
    await second
    expect(syncs.map((s) => s.mined)).toEqual([false, true])
  })

  // A stuck tx holds the next send until it expires, and 5 minutes at most.
  it.each([
    { expiresInS: 60, waitS: 60 },
    { expiresInS: 3600, waitS: 300 },
  ])(
    "syncs the next send $waitS s after a tx that expires in $expiresInS s and never lands",
    async ({ expiresInS, waitS }) => {
      vi.useFakeTimers({ toFake: ["Date"] })
      const { syncs, send } = sendsOverFakeChain(expiresInS)

      await send(NO_WAIT)
      const until = syncs[0]!.at + waitS * 1000
      await send(NO_WAIT)
      expect(syncs[1]!.at).toBeGreaterThanOrEqual(until - 1_000)
      expect(syncs[1]!.at).toBeLessThan(until + 2_000)
    },
  )

  it("reports the wait for the last send's tx while it lasts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { chain, waits, send } = sendsOverFakeChain()

    await send(NO_WAIT)
    expect(waits).toEqual([])
    const second = send(NO_WAIT)
    await flush()
    expect(waits).toEqual([true])
    chain.mined = true
    await second
    expect(waits).toEqual([true, false])
  })

  it("leaves nothing to wait for after a send that waited for its own receipt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { chain, syncs, waits, send } = sendsOverFakeChain()
    chain.mined = true

    await send()
    await send(NO_WAIT)
    expect(syncs).toHaveLength(2)
    expect(waits).toEqual([])
  })
})
