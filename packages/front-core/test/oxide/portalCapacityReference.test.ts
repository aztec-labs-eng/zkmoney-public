/**
 * The node reference passes the node's own L1 chain and synced time through (the capacity store judges them), reads
 * the chain id once per node client, forgets only its own failed lookup, and follows the node the wallet boots.
 */
import { describe, expect, it, vi } from "vitest"
import { nodeCapacityReference } from "../../src/oxide/portalCapacityReference"

const SYNCED = 1_790_454_156n
function fakeNode(
  chainId: Promise<number> | number,
  synced: { at: bigint | undefined } = { at: SYNCED },
) {
  return {
    getChainId: vi.fn(async () => chainId),
    getSyncedL1Timestamp: vi.fn(async () => synced.at),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("nodeCapacityReference", () => {
  it("returns the node's L1 chain and synced time, reading the chain id once per node", async () => {
    const node = fakeNode(11155111)
    const reference = nodeCapacityReference(() => node)
    await expect(reference()).resolves.toEqual({ l1ChainId: 11155111, l1Timestamp: SYNCED })
    await reference()
    expect(node.getChainId).toHaveBeenCalledOnce()
    expect(node.getSyncedL1Timestamp).toHaveBeenCalledTimes(2)
  })

  it("passes an unsynced node and another chain through for the store to refuse", async () => {
    await expect(
      nodeCapacityReference(() => fakeNode(11155111, { at: undefined }))(),
    ).resolves.toEqual({
      l1ChainId: 11155111,
      l1Timestamp: undefined,
    })
    await expect(nodeCapacityReference(() => fakeNode(1))()).resolves.toMatchObject({
      l1ChainId: 1,
    })
  })

  it("rejects when the node cannot be read, and asks again next time", async () => {
    const node = fakeNode(11155111)
    node.getChainId.mockRejectedValueOnce(new Error("node down"))
    const reference = nodeCapacityReference(() => node)
    await expect(reference()).rejects.toThrow("node down")
    await expect(reference()).resolves.toMatchObject({ l1ChainId: 11155111 })
    expect(node.getChainId).toHaveBeenCalledTimes(2)

    node.getSyncedL1Timestamp.mockRejectedValueOnce(new Error("timeout"))
    await expect(reference()).rejects.toThrow("timeout")
  })

  it("moves from the pre-boot node to the booted node, and a late failure of the old lookup erases nothing", async () => {
    const early = deferred<number>()
    const preBoot = fakeNode(early.promise)
    const booted = fakeNode(11155111)
    let active: typeof booted | undefined
    const reference = nodeCapacityReference(() => active ?? preBoot)

    const first = reference()
    active = booted
    await expect(reference()).resolves.toEqual({ l1ChainId: 11155111, l1Timestamp: SYNCED })
    early.reject(new Error("pre-boot node gone"))
    await expect(first).rejects.toThrow("pre-boot node gone")

    await reference()
    expect(booted.getChainId).toHaveBeenCalledOnce()
    expect(preBoot.getSyncedL1Timestamp).toHaveBeenCalledOnce()
  })

  it("does not wait on a chain-id lookup that never answers: the next read asks again", async () => {
    const node = fakeNode(11155111)
    node.getChainId.mockImplementationOnce(() => new Promise(() => {}))
    const reference = nodeCapacityReference(() => node)
    void reference()
    await expect(reference()).resolves.toMatchObject({ l1ChainId: 11155111 })
    expect(node.getChainId).toHaveBeenCalledTimes(2)
  })
})
