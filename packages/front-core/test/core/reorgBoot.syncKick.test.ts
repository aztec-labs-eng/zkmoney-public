/** The monitor's PXE sync waits for the first balance, whose read would see its anchor move. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AccountStorage } from "../../src/core/storages/AccountStorage"
import { NetworkStorage } from "../../src/core/storages/NetworkStorage"
import { WithdrawalStorage } from "../../src/core/services/bridge/WithdrawalStorage"
import { SIPADepositStore } from "../../src/core/services/deposits/SIPADepositStore"
import { createActivity } from "../../src/engine/activity"
import { createMemoryKv } from "../../src/engine/kv"
import { bootPriority } from "../../src/core/services/transactions/bootPriority"
import { createReorgMonitor, type CreateReorgMonitorOptions } from "../../src/core/reorgBoot"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../__test-helpers__/resetSingleton"

vi.mock("@aztec-labs/aztec.js/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aztec-labs/aztec.js/node")>()
  return { ...actual, createAztecNodeClient: vi.fn() }
})

const emptyActivity = () => createActivity({ kv: createMemoryKv(), networkId: () => undefined })

function setup() {
  resetSingleton(AccountStorage as unknown as { instance: AccountStorage | null })
  resetSingleton(NetworkStorage as unknown as { instance: NetworkStorage | null })
  resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
  const storage = new InMemoryStorageAdapter()
  AccountStorage.get(storage)
  const sync = vi.fn(async () => {})
  const wallet = {
    node: { getNodeInfo: vi.fn(), getTxReceipt: vi.fn() },
    pxe: { sync },
  } as unknown as CreateReorgMonitorOptions["wallet"]
  return {
    monitor: createReorgMonitor({
      wallet,
      storage,
      activity: emptyActivity(),
      onOutcome: () => {},
    }),
    sync,
  }
}

describe("createReorgMonitor PXE sync", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it("skips the sync until the boot order lets it run", async () => {
    const ready = vi.spyOn(bootPriority, "isReady").mockReturnValue(false)
    const { monitor, sync } = setup()

    await monitor.runPass({ sideEffects: true })
    expect(ready).toHaveBeenCalledWith("reorgSync")
    expect(sync).not.toHaveBeenCalled()

    ready.mockReturnValue(true)
    await monitor.runPass({ sideEffects: true })
    expect(sync).toHaveBeenCalledTimes(1)
  })
})
