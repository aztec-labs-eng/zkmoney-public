// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
  TokenService,
  WalletBalanceRead,
} from "@obsidion/sdk"
import type { TransferScanContext } from "../../src/core/services/transactions/TransferEventScanner"
import { createCatchUp } from "../../src/engine/catchUp"
import { WalletError } from "../../src/engine/errors"
import { createMilestones } from "../../src/engine/milestones"
import { fixed } from "../../src/engine/service"
import { startRuntime } from "../../src/engine/runtime"
import {
  PREVIOUS_ACCOUNT_SCAN_MS,
  previousAccountFind,
  previousAccountHistory,
  previousAccountScan,
  savingsLookup,
  transferScan,
  SAVINGS_LOOKUP_RETRY_MS,
} from "../../src/engine/transferScan"
import { later, onceSteps, periodicSteps, sessions, table } from "./taskTable"

const TOKEN = { address: "0xmain", symbol: "USD", decimals: 18 }
const reader = (read: () => Promise<bigint>) => ({ readBalanceAssumingSynced: read })
const flush = () => vi.advanceTimersByTimeAsync(0)
const mainToken = () =>
  ({ metadata: TOKEN, ...reader(async () => 100n) } as unknown as TokenService)
const ME = { getAddress: () => "0xme" } as unknown as ObsidionAccount

describe("transferScan task", () => {
  const ends: (() => void)[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const end of ends.splice(0)) end()
    vi.useRealTimers()
  })

  function start(opts: { lookupFails?: number; incomplete?: boolean; tag?: string } = {}) {
    const events: string[] = []
    const contexts: TransferScanContext[] = []
    let readBalances!: () => Promise<WalletBalanceRead>
    let { lookupFails = Infinity } = opts
    const shares = vi.fn(async () => 7n)
    const lookups = vi.fn()
    const readBalanceCoalesced = vi.fn(async () => true)
    const token = later<TokenService>("token")
    const account = later<ObsidionAccount>("account")
    const wallet = fixed("wallet", { networkId: "net" } as ObsidionWallet)
    const h = sessions(startRuntime)
    const scan = transferScan({
      wallet,
      account: account.service,
      token: token.service,
      contractService: fixed("contractService", {} as ContractService),
      tag: () => opts.tag,
      endpointScope: () => "edge",
      visible: h.visible.readonly,
      coordinator: (_ready, read) => {
        events.push("built")
        readBalances = read
        return {
          pass: async (context, { full }) => {
            contexts.push(context)
            events.push(full ? "full" : "pass")
            return !opts.incomplete
          },
          attach: () => () => {},
          readBalanceCoalesced,
        }
      },
      now: () => Date.now(),
    })
    const lookup = async () => {
      lookups()
      if (lookupFails-- > 0) throw new Error("no deployment")
      return { tokenService: { tokenAddress: "0xshares", ...reader(shares) } }
    }
    h.tasks.push(scan.task, savingsLookup({ wallet, account: account.service, lookup, scan }))
    ends.push(h.end, scan.dispose)
    const read = () => readBalances()
    return { h, token, account, events, contexts, shares, lookups, readBalanceCoalesced, read }
  }

  it("scans once Main's token is ready: every 5 s while visible, paused while hidden", async () => {
    const t = start()
    t.account.ready(ME)
    await table(
      periodicSteps(t.h, () => t.token.ready(mainToken()), 5_000),
      () => t.events.filter((e) => e !== "built").length,
    )
    // Started, given its token, shown and restarted: full passes.
    expect(t.events).toEqual(["built", "full", "pass", "full", "full"])
    expect(t.contexts[0]).toEqual({
      accountAddress: "0xme",
      accountTag: "0xme",
      networkId: "net",
      endpointScope: "edge",
    })
  })

  it("builds a coordinator per value of Main's token, and names the account by its tag", async () => {
    const t = start({ tag: "me" })
    t.account.ready(ME)
    t.h.start()
    t.token.ready(mainToken())
    await flush()
    t.token.ready(mainToken())
    await flush()
    expect(t.events).toEqual(["built", "full", "built", "full"])
    expect(t.contexts[0]?.accountTag).toBe("me")
  })

  it("backs off from 10 s while passes stay incomplete", async () => {
    const t = start({ incomplete: true })
    t.account.ready(ME)
    t.token.ready(mainToken())
    t.h.start()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(t.events).toEqual(["built", "full"])
    await vi.advanceTimersByTimeAsync(20_001)
    expect(t.events).toEqual(["built", "full", "pass", "pass"])
  })

  it("looks Savings up once per session, after the first balance, once the account is ready", async () => {
    const t = start({ lookupFails: 0 })
    t.token.ready(mainToken())
    await table(
      onceSteps(t.h, () => t.account.ready(ME)),
      () => t.lookups.mock.calls.length,
    )
  })

  it("retries the Savings lookup, then reads its shares beside Main's, which survive a failed read", async () => {
    const t = start({ lookupFails: 1 })
    t.account.ready(ME)
    t.token.ready(mainToken())
    t.h.start()
    const balances = async () => (await t.read()).balances
    await flush()
    await expect(balances()).resolves.toEqual({ [TOKEN.address]: 100n })
    await vi.advanceTimersByTimeAsync(SAVINGS_LOOKUP_RETRY_MS)
    // The balances alone, through the scan's coordinator.
    expect(t.readBalanceCoalesced).toHaveBeenCalledTimes(1)
    await expect(balances()).resolves.toEqual({ [TOKEN.address]: 100n, "0xshares": 7n })
    t.shares.mockRejectedValueOnce(new Error("unreadable"))
    await expect(balances()).resolves.toEqual({ [TOKEN.address]: 100n })
  })

  it("stamps each balance with when its own read resolved", async () => {
    const t = start({ lookupFails: 0 })
    t.account.ready(ME)
    t.token.ready(mainToken())
    t.h.start()
    await flush()
    t.shares.mockImplementationOnce(() => new Promise((r) => setTimeout(() => r(7n), 50)))
    const pending = t.read()
    await vi.advanceTimersByTimeAsync(50)
    const { readAt = {} } = await pending
    expect(readAt["0xshares"]! - readAt[TOKEN.address]!).toBe(50)
  })
})

describe("previousAccountScan task", () => {
  const ends: (() => void)[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const end of ends.splice(0)) end()
    vi.useRealTimers()
  })

  function start(
    previous: () => string | undefined | Promise<string | undefined>,
    milestones?: Parameters<typeof sessions>[1],
  ) {
    const passes: [string, string | undefined, boolean | undefined][] = []
    const built: string[] = []
    const links: string[] = []
    const steps: string[] = []
    const complete = { next: true, links: true, burns: true }
    const token = later<TokenService>("token")
    const h = sessions(startRuntime, milestones)
    h.tasks.push(
      previousAccountScan({
        wallet: fixed("wallet", { networkId: "net" } as ObsidionWallet),
        account: fixed("account", ME),
        token: token.service,
        contractService: fixed("contractService", {} as ContractService),
        previousAccount: async () => previous(),
        tag: () => "me",
        scanner: (_ready, address) => {
          built.push(address)
          return {
            pass: async (context: TransferScanContext, opts) => {
              passes.push([context.accountAddress, context.ownAccount, opts?.full])
              steps.push(`transfers:${context.accountAddress}`)
              return complete.next
            },
          }
        },
        links: async (_ready, address) => {
          links.push(address)
          steps.push(`links:${address}`)
          return complete.links
        },
        burns: async (_ready, address) => {
          steps.push(`burns:${address}`)
          if (!complete.burns) throw new WalletError("scan.incomplete")
        },
        now: () => Date.now(),
      }),
    )
    ends.push(h.end)
    h.start()
    token.ready(mainToken())
    /** Hides the page for `ms`, then shows it. */
    const away = async (ms: number) => {
      h.hide()
      await vi.advanceTimersByTimeAsync(ms)
      h.show()
      await flush()
    }
    return { passes, built, links, steps, away, complete, token }
  }

  it("does nothing while the wallet has no previous account", async () => {
    const { passes, built } = start(() => undefined)
    await vi.advanceTimersByTimeAsync(PREVIOUS_ACCOUNT_SCAN_MS)
    expect([passes, built]).toEqual([[], []])
  })

  it("waits for the balance, both replays and the account's own history, as every history reader", async () => {
    const milestones = createMilestones({
      catchUp: createCatchUp(),
      sinceLoad: () => performance.now(),
    })
    ends.push(() => milestones.stop())
    const { passes } = start(() => "0xprev", milestones)
    milestones.mark("historyAtHead")
    await flush()
    expect(passes).toHaveLength(0)
    // With no boot sync open, the first balance also reaches `movesReplayed`.
    milestones.mark("firstBalance")
    await flush()
    expect(passes).toHaveLength(0)
    milestones.mark("depositsReplayed")
    await flush()
    expect(passes).toHaveLength(1)
  })

  it("scans the previous account with the session's as its own, building one scanner each", async () => {
    const found: string[] = []
    const { passes, built } = start(() => found[0])
    await flush()
    found.push("0xprev")
    await vi.advanceTimersByTimeAsync(2 * PREVIOUS_ACCOUNT_SCAN_MS)
    expect(built).toEqual(["0xprev"])
    expect(passes).toEqual([
      ["0xprev", "0xme", false],
      ["0xprev", "0xme", false],
    ])
  })

  it("skips a show sooner than the cadence after its last pass, but not after a failed one", async () => {
    const { passes, away, complete } = start(() => "0xprev")
    await flush()
    expect(passes).toHaveLength(1)

    await away(60_000)
    expect(passes).toHaveLength(1)
    await away(PREVIOUS_ACCOUNT_SCAN_MS)
    expect(passes).toEqual([
      ["0xprev", "0xme", true],
      ["0xprev", "0xme", true],
    ])

    complete.next = false
    await vi.advanceTimersByTimeAsync(PREVIOUS_ACCOUNT_SCAN_MS)
    expect(passes).toHaveLength(3)
    complete.next = true
    await away(1_000)
    expect(passes).toHaveLength(4)
  })

  // A fresh device lists the backup add's funding only once the burn is rebuilt, and a link's
  // funding and refund as the link only if it is rebuilt before the transfers land.
  it("rebuilds the account's burns and paylinks before it files the transfers", async () => {
    const { steps } = start(() => "0xprev")
    await flush()
    expect(steps).toEqual(["burns:0xprev", "links:0xprev", "transfers:0xprev"])
  })

  it.each(["burns", "links"] as const)(
    "ends the pass at a short %s read, before the transfers, and runs it again after a minute",
    async (short) => {
      const { passes, steps, complete } = start(() => "0xprev")
      await flush()
      complete[short] = false
      await vi.advanceTimersByTimeAsync(PREVIOUS_ACCOUNT_SCAN_MS)
      expect(passes).toHaveLength(1)
      complete[short] = true
      await vi.advanceTimersByTimeAsync(60_000)
      expect(passes).toHaveLength(2)
      expect(steps.filter((s) => s.startsWith(short))).toHaveLength(3)
    },
  )

  it("scans again at once over a replaced token, with a scanner built on it", async () => {
    const { passes, built, token } = start(() => "0xprev")
    await flush()
    token.ready(mainToken())
    await flush()
    expect(built).toEqual(["0xprev", "0xprev"])
    expect(passes).toHaveLength(2)
  })

  it("retries an answer a session change cut short after a minute, not the cadence", async () => {
    let calls = 0
    const { passes } = start(async () => {
      if (calls++ === 0) throw new Error("the session changed")
      return "0xprev"
    })
    await flush()
    expect(passes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(passes).toHaveLength(1)
  })
})

describe("previousAccountHistory task", () => {
  const ends: (() => void)[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const end of ends.splice(0)) end()
    vi.useRealTimers()
  })

  function start(milestones?: Parameters<typeof sessions>[1]) {
    const complete = { next: true }
    let reads = 0
    const h = sessions(startRuntime, milestones)
    h.tasks.push(
      previousAccountHistory({
        wallet: fixed("wallet", {} as ObsidionWallet),
        account: fixed("account", ME),
        read: async () => {
          reads++
          return complete.next
        },
      }),
    )
    ends.push(h.end)
    h.start()
    return { reads: () => reads, complete, h }
  }

  it("reads once a session, after the balance, both replays and the account's own history", async () => {
    const milestones = createMilestones({
      catchUp: createCatchUp(),
      sinceLoad: () => performance.now(),
    })
    ends.push(() => milestones.stop())
    const { reads, h } = start(milestones)
    milestones.mark("historyAtHead")
    milestones.mark("firstBalance")
    await flush()
    expect(reads()).toBe(0)
    milestones.mark("depositsReplayed")
    await flush()
    expect(reads()).toBe(1)

    h.hide()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    h.show()
    await flush()
    expect(reads()).toBe(1)
  })

  it("reads again after a minute when the scan fell short", async () => {
    const { reads, complete } = start()
    complete.next = false
    await flush()
    expect(reads()).toBe(1)
    complete.next = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(reads()).toBe(2)
  })
})

describe("previousAccountFind task", () => {
  const ends: (() => void)[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const end of ends.splice(0)) end()
    vi.useRealTimers()
  })

  it("finds once a session as it opens, waiting on no milestone, and again after a failure", async () => {
    const milestones = createMilestones({
      catchUp: createCatchUp(),
      sinceLoad: () => performance.now(),
    })
    ends.push(() => milestones.stop())
    const h = sessions(startRuntime, milestones)
    const wallet = {} as ObsidionWallet
    const find = vi.fn<(wallet: ObsidionWallet) => Promise<string>>()
    find.mockRejectedValueOnce(new Error("identity map locked")).mockResolvedValue("0xprevious")
    h.tasks.push(
      previousAccountFind({
        wallet: fixed("wallet", wallet),
        account: fixed("account", ME),
        find,
      }),
    )
    ends.push(h.end)
    h.start()
    await flush()
    expect(find).toHaveBeenCalledTimes(1)
    expect(find).toHaveBeenCalledWith(wallet)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(find).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(find).toHaveBeenCalledTimes(2)
  })
})
