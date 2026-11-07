/** The pool task, once boot let it run, refills on a hand-out's wake rather than its cadence. */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  createSipaDeposits,
  encodeRecord,
  fixed,
  memoryBackend,
  memoryStore,
  openDatabase,
  startRuntime,
  type SipaDeposit,
} from "@obsidion/front-core"
import { getConfig } from "../../../../src/config/env"
import { primeOxideTuple } from "../../../../src/config/oxideTuple"
import {
  createSipaAddresses,
  sipaPoolDeployment,
} from "../../../../src/features/deposit/sipaAddresses"
import { seedBootConfig } from "../../../support/seedBootConfig"

const ACCOUNT = `0x${"a1".repeat(32)}`
const POOLED = "0x00000000000000000000000000000000000000c1"
const TUPLE = {
  rollupVersion: "7",
  portal: "0x00000000000000000000000000000000000000a0",
  forwardingTable: "0x00000000000000000000000000000000000000fb",
} as OxideEnvTuple

let stop: (() => void) | undefined
afterEach(() => stop?.())

describe("sipaPool", () => {
  it("refills as soon as a hand-out takes the pooled address, not on its next tick", async () => {
    await seedBootConfig()
    primeOxideTuple(getConfig(), TUPLE)
    const pooled: SipaDeposit = {
      sipaAddress: POOLED,
      recipientL2Address: ACCOUNT,
      messageSecret: "0x1",
      recipientHash: "0x2",
      recoveryAddress: "",
      l1ChainId: 31337,
      networkId: "0xnet",
      amount: "0",
      tokenSymbol: "DAI",
      phase: "broadcast",
      startTime: 1,
      slot: {
        day: Math.floor(Date.now() / 86_400_000),
        nonce: 1,
        deployment: sipaPoolDeployment(TUPLE),
      },
      broadcast: {
        kind: "pool",
        source: { type: "slot" },
        state: "landed",
        createdAt: 1,
        failures: 0,
      },
    }
    const backend = memoryBackend()
    // Saved by this version: no migration runs over it.
    await backend.apply([
      [`acct/sipaDeposits/${POOLED}`, encodeRecord(pooled)],
      ["acct/meta/sipaDeposits", "3"],
    ])
    const db = openDatabase(backend)
    const store = createSipaDeposits({ db, account: true })
    // The fill's first L2 read: it shows the refill started, and holds it there.
    const getBlock = vi.fn(() => new Promise<never>(() => {}))
    const addresses = createSipaAddresses({
      store,
      wallet: fixed("wallet", { node: { getBlock }, networkId: "0xnet" } as never),
      keys: fixed("keys", { recipient: { toString: () => ACCOUNT } } as never),
      discovery: fixed("discovery", {} as never),
      identity: memoryStore({
        value: { handle: "alice", address: ACCOUNT, claimedAt: 1 },
        loaded: true,
        failed: false,
      }).readonly,
      railPending: memoryStore(undefined).readonly,
      wakeBroadcasts: () => {},
      wake: (task) => runtime.wake(task),
    })
    const runtime = startRuntime([addresses.pool], {
      db,
      milestones: { after: async () => true, reached: () => true },
      visible: memoryStore(true).readonly,
    })
    stop = () => runtime.stop()
    // Boot's run finds the pool full and fills nothing.
    await runtime.wake(addresses.pool)
    expect(getBlock).not.toHaveBeenCalled()

    const handed = await addresses.readyAddress(14 * 86_400_000)

    expect(handed?.address.toLowerCase()).toBe(POOLED)
    await vi.waitFor(() => expect(getBlock).toHaveBeenCalledOnce(), { timeout: 1_000 })
  })
})
