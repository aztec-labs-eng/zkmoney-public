// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WalletBalanceRead } from "@obsidion/sdk"
import { createMemoryKv } from "../../src/engine/kv"
import { startRuntime, type Runtime } from "../../src/engine/runtime"
import { memoryStore } from "../../src/engine/store"
import {
  createSavingsLookup,
  createTransferScan,
  SAVINGS_LOOKUP_RETRY_MS,
} from "../../src/engine/transferScan"

const TOKEN = { address: "0xmain", symbol: "USD", decimals: 18 }
const reader = (read: () => Promise<bigint>) => ({ readBalanceAssumingSynced: read })
const flush = () => vi.advanceTimersByTimeAsync(0)

describe("transferScan task", () => {
  let runtime: Runtime | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    runtime?.stop()
    vi.useRealTimers()
  })

  function start(
    opts: {
      tokenFails?: number
      lookupFails?: number
      incomplete?: boolean
      token?: () => Promise<typeof TOKEN>
    } = {},
  ) {
    const visible = memoryStore(true)
    const events: string[] = []
    let readBalances!: () => Promise<WalletBalanceRead>
    let { tokenFails = 0, lookupFails = Infinity } = opts
    const shares = vi.fn(async () => 7n)
    const refreshBalance = vi.fn(async () => {})
    const scan = createTransferScan({
      context: { accountAddress: "0xme", accountTag: "me", networkId: "net" },
      token:
        opts.token ??
        (async () => {
          if (tokenFails-- > 0) throw new Error("node down")
          return TOKEN
        }),
      main: reader(async () => 100n),
      coordinator: (_token, read) => {
        events.push("built")
        readBalances = read
        return {
          pass: async (_context, { full }) => (
            events.push(full ? "full" : "pass"), !opts.incomplete
          ),
          attach: () => () => {},
        }
      },
    })
    const lookup = async () => {
      if (lookupFails-- > 0) throw new Error("no deployment")
      return { tokenAddress: "0xshares", ...reader(shares) }
    }
    runtime = startRuntime([scan.task, createSavingsLookup({ lookup, scan, refreshBalance })], {
      kv: createMemoryKv(),
      whenReady: async () => {},
      visible: visible.readonly,
    })
    return { visible, events, shares, refreshBalance, read: () => readBalances() }
  }

  it("runs a full pass at start and on show, a scheduled one every 5 s while visible", async () => {
    const { visible, events } = start()
    await vi.advanceTimersByTimeAsync(5_000)
    visible.set(false)
    await vi.advanceTimersByTimeAsync(60_000)
    visible.set(true)
    await flush()
    expect(events).toEqual(["built", "full", "pass", "full"])
  })

  it("backs off from 10 s while passes stay incomplete", async () => {
    const { events } = start({ incomplete: true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(events).toEqual(["built", "full"])
    await vi.advanceTimersByTimeAsync(20_001)
    expect(events).toEqual(["built", "full", "pass", "pass"])
  })

  it("retries a build whose token read failed", async () => {
    const { events } = start({ tokenFails: 1 })
    await flush()
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(events).toEqual(["built", "pass"])
  })

  it("builds only once Main's token is read, however long that waits", async () => {
    let open = () => {}
    const token = () => new Promise<typeof TOKEN>((resolve) => (open = () => resolve(TOKEN)))
    const { events } = start({ token })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events).toEqual([])
    open()
    await flush()
    expect(events).toEqual(["built", "full"])
  })

  it("retries the Savings lookup, then reads its shares beside Main's, which survive a failed read", async () => {
    const { shares, refreshBalance, read } = start({ lookupFails: 1 })
    const balances = async () => (await read()).balances
    await flush()
    await expect(balances()).resolves.toEqual({ [TOKEN.address]: 100n })
    await vi.advanceTimersByTimeAsync(SAVINGS_LOOKUP_RETRY_MS)
    expect(refreshBalance).toHaveBeenCalledTimes(1)
    await expect(balances()).resolves.toEqual({ [TOKEN.address]: 100n, "0xshares": 7n })
    shares.mockRejectedValueOnce(new Error("unreadable"))
    await expect(balances()).resolves.toEqual({ [TOKEN.address]: 100n })
  })

  it("stamps each balance with when its own read resolved", async () => {
    const { shares, read } = start({ lookupFails: 0 })
    await flush()
    shares.mockImplementationOnce(() => new Promise((r) => setTimeout(() => r(7n), 50)))
    const pending = read()
    await vi.advanceTimersByTimeAsync(50)
    const { readAt = {} } = await pending
    expect(readAt["0xshares"]! - readAt[TOKEN.address]!).toBe(50)
  })
})
