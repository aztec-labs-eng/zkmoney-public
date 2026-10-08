/**
 * The freeze probe reads the wallet's identity, which boot pins to L1's answer, so a node that
 * reports a frozen rollupVersion cannot stand the monitor down by itself.
 */
import { GENERATIONS } from "@obsidion/core/constants"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AccountStorage } from "../../src/core/storages/AccountStorage"
import { NetworkStorage } from "../../src/core/storages/NetworkStorage"
import { TransactionStorage } from "../../src/core/storages/TransactionStorage"
import { WithdrawalStorage } from "../../src/core/services/bridge/WithdrawalStorage"
import { SIPADepositStore } from "../../src/core/services/deposits/SIPADepositStore"
import { TransactionTracker } from "../../src/core/services/transactions/TransactionTracker"
import { createReorgMonitor, type CreateReorgMonitorOptions } from "../../src/core/reorgBoot"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../__test-helpers__/resetSingleton"

vi.mock("@aztec/aztec.js/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aztec/aztec.js/node")>()
  return { ...actual, createAztecNodeClient: vi.fn() }
})

const FROZEN_VERSION = GENERATIONS.find((g) => g.status === "frozen")!.version
const CANONICAL_VERSION = GENERATIONS.find((g) => g.status === "canonical")!.version

function wallet(pinnedVersion: number, nodeVersion: number) {
  const getNodeInfo = vi.fn(async () => ({ rollupVersion: nodeVersion }))
  const options: CreateReorgMonitorOptions["wallet"] = {
    node: { getNodeInfo, getTxReceipt: vi.fn() },
    pxe: { sync: vi.fn(async () => {}) },
    getNodeIdentity: vi.fn(async () => ({ l1ChainId: 11155111, rollupVersion: pinnedVersion })),
  } as unknown as CreateReorgMonitorOptions["wallet"]
  return { options, getNodeInfo }
}

function setup() {
  resetSingleton(AccountStorage as unknown as { instance: AccountStorage | null })
  resetSingleton(TransactionStorage as unknown as { instance: TransactionStorage | null })
  resetSingleton(NetworkStorage as unknown as { instance: NetworkStorage | null })
  resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
  ;(TransactionTracker as unknown as { instance: unknown }).instance = null
  vi.spyOn(TransactionTracker.getInstance(), "getQueue").mockReturnValue([])
  const storage = new InMemoryStorageAdapter()
  AccountStorage.get(storage)
  return storage
}

describe("createReorgMonitor freeze probe", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it("a wallet pinned to a live version arms no freeze while the node reports a frozen one", async () => {
    const storage = setup()
    const { options, getNodeInfo } = wallet(CANONICAL_VERSION, FROZEN_VERSION)
    const monitor = createReorgMonitor({ wallet: options, storage })
    const setFrozen = vi.spyOn(monitor, "setFrozen")

    expect(await monitor.runPass()).not.toBeNull()
    expect(await monitor.runPass()).not.toBeNull()

    expect(setFrozen).not.toHaveBeenCalled()
    expect(options.getNodeIdentity).toHaveBeenCalledTimes(2)
    expect(getNodeInfo).not.toHaveBeenCalled()
  })

  it("a pinned frozen version confirms on the second consecutive probe", async () => {
    const storage = setup()
    const { options } = wallet(FROZEN_VERSION, CANONICAL_VERSION)
    const monitor = createReorgMonitor({ wallet: options, storage })
    const setFrozen = vi.spyOn(monitor, "setFrozen")

    expect(await monitor.runPass()).toBeNull()
    expect(setFrozen).not.toHaveBeenCalled()
    expect(await monitor.runPass()).toBeNull()
    expect(setFrozen).toHaveBeenCalledWith(true)
  })
})
