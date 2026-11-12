/**
 * Anchor-pin tests for `ObsidionWallet`'s manual-sync discipline: while a snapshot reads, other
 * read-path entry points SKIP their per-operation `pxe.sync()` so no read adopts a newer anchor
 * block mid-snapshot.
 */
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"
import { BaseWallet } from "@aztec-labs/wallet-sdk/base-wallet"

function header(block: number) {
  return { hash: async () => new Fr(block), globalVariables: { blockNumber: block } }
}

function makeStubWallet() {
  const stubPxe = {
    sync: vi.fn(async () => {}),
    executeUtility: vi.fn(async () => ({})),
    getSyncedBlockHeader: vi.fn(async () => header(0)),
  }
  const wallet = new ObsidionWallet(stubPxe as never, {} as never, "0xrollup")
  return { wallet, stubPxe }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ObsidionWallet anchor pin", () => {
  it("reads a projection alone on one sync", async () => {
    const { wallet, stubPxe } = makeStubWallet()
    stubPxe.getSyncedBlockHeader = vi.fn(async () => header(30))
    const events = vi.spyOn(BaseWallet.prototype, "getPrivateEvents")
    expect(await wallet.getSnapshot(async () => 9n)).toEqual({ value: 9n, anchorBlock: 30 })
    expect(stubPxe.sync).toHaveBeenCalledTimes(1)
    expect(events).not.toHaveBeenCalled()
  })

  it("a read entering mid-snapshot skips its sync, so the snapshot's anchor holds", async () => {
    const { wallet, stubPxe } = makeStubWallet()
    let block = 100
    stubPxe.sync = vi.fn(async () => {
      block++
    })
    stubPxe.getSyncedBlockHeader = vi.fn(async () => header(block))
    const snapshot = await wallet.getSnapshot(async () => {
      await wallet.executeUtility({} as never, {} as never)
      return 7n
    })
    expect(snapshot).toEqual({ value: 7n, anchorBlock: 101 })
    expect(stubPxe.sync).toHaveBeenCalledTimes(1)

    await wallet.executeUtility({} as never, {} as never)
    expect(stubPxe.sync).toHaveBeenCalledTimes(2)
  })

  it("a snapshot asked for mid-snapshot syncs after the first one ends", async () => {
    const { wallet, stubPxe } = makeStubWallet()
    let block = 100
    stubPxe.sync = vi.fn(async () => {
      block++
    })
    stubPxe.getSyncedBlockHeader = vi.fn(async () => header(block))
    let second: Promise<{ value: bigint; anchorBlock: number }> | undefined
    const first = await wallet.getSnapshot(async () => {
      second = wallet.getSnapshot(async () => 8n)
      await new Promise((r) => setTimeout(r, 5))
      return 7n
    })
    expect(first).toEqual({ value: 7n, anchorBlock: 101 })
    expect(await second).toEqual({ value: 8n, anchorBlock: 102 })
    expect(stubPxe.sync).toHaveBeenCalledTimes(2)
  })

  it("a snapshot whose anchor moves mid-read reads again at the new one", async () => {
    const { wallet, stubPxe } = makeStubWallet()
    const anchors = [40, 41, 41, 41]
    stubPxe.getSyncedBlockHeader = vi.fn(async () => header(anchors.shift() ?? 41))
    const read = vi.fn(async () => 5n)
    expect(await wallet.getSnapshot(read)).toEqual({ value: 5n, anchorBlock: 41 })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("a snapshot whose anchor keeps moving gives up after three reads", async () => {
    const { wallet, stubPxe } = makeStubWallet()
    let block = 50
    stubPxe.getSyncedBlockHeader = vi.fn(async () => header(block++))
    const read = vi.fn(async () => 5n)
    await expect(wallet.getSnapshot(read)).rejects.toThrow("PXE anchor changed")
    expect(read).toHaveBeenCalledTimes(3)
  })

  it("a note read asked for mid-snapshot runs its forced sync after the snapshot ends", async () => {
    const { wallet, stubPxe } = makeStubWallet()
    let block = 100
    stubPxe.sync = vi.fn(async () => {
      block++
    })
    stubPxe.getSyncedBlockHeader = vi.fn(async () => header(block))
    // `PXE.debug.getNotes` syncs PXE whatever the wallet holds.
    const getNotes = vi.fn(async () => {
      block++
      return []
    })
    Object.assign(stubPxe, { debug: { getNotes } })
    let notes: Promise<unknown> | undefined
    const snapshot = await wallet.getSnapshot(async () => {
      notes = wallet.getNotes({} as never)
      await new Promise((r) => setTimeout(r, 5))
      return 7n
    })
    expect(snapshot).toEqual({ value: 7n, anchorBlock: 101 })
    expect(await notes).toEqual([])
    expect(block).toBe(102)
  })

  it("a failed snapshot frees the queue and the read syncs", async () => {
    const { wallet, stubPxe } = makeStubWallet()
    stubPxe.getSyncedBlockHeader = vi.fn(async () => header(10))
    const failed = wallet.getSnapshot(async () => {
      throw new Error("read failed")
    })
    const next = wallet.getSnapshot(async () => 8n)
    await expect(failed).rejects.toThrow("read failed")
    expect(await next).toEqual({ value: 8n, anchorBlock: 10 })
    stubPxe.sync.mockClear()
    await wallet.executeUtility({} as never, {} as never)
    expect(stubPxe.sync).toHaveBeenCalledTimes(1)
  })
})
