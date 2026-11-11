import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import {
  createReceiveCodes,
  memoryBackend,
  openDatabase,
  type MintedRequestLink,
} from "@obsidion/front-core"
import {
  CODE_LIFETIME_MS,
  currentCode,
  openCode,
  setCodeAmount,
  type CodeDeps,
  type ReadyAddress,
} from "../../../src/features/receive/receiveCode"

const DAY_MS = 86_400_000
const NOW = 1_800_000_000_000
const TODAY = Math.floor(NOW / DAY_MS)
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address

let seq = 0
/** With `requester`, each code is minted for the account's address then. */
function harness(ready: Array<ReadyAddress | null> = [], requester?: string) {
  ++seq
  const db = openDatabase(memoryBackend())
  const cancelled: string[] = []
  const minted: Array<{ amountInput: string; sipaAddress?: Address }> = []
  const paidIds = new Set<string>()
  const deps: CodeDeps = {
    codes: createReceiveCodes({ db, legacy: db }),
    id: "test.river",
    requester,
    readyAddress: async () => ready.shift() ?? null,
    mint: async (args) => {
      minted.push(args)
      const id = `0x${seq}${minted.length}`
      const amount = Number(args.amountInput) || 0
      return {
        url: `https://wallet.test/pay/river#${id}`,
        row: {
          id,
          amount,
          expiresAt: args.now + args.durationMs,
          requesterAddress: deps.requester,
        },
        note: args.noteInput || undefined,
      } as MintedRequestLink
    },
    cancel: async (id: string) => cancelled.push(id),
    paid: async (code) => paidIds.has(code.requestId),
  }
  return { deps, cancelled, paidIds }
}

describe("receive code", () => {
  it("carries no address while none is ready, and takes one once it is", async () => {
    const { deps, cancelled } = harness([null, null, { address: addr(2), day: TODAY }])
    const plain = await currentCode(deps, NOW)
    expect(plain.address).toBeUndefined()
    expect(await currentCode(deps, NOW)).toEqual(plain)
    const upgraded = await currentCode(deps, NOW)
    expect(upgraded.address).toBe(addr(2))
    expect(cancelled).toEqual([plain.requestId])
  })

  it.each([
    ["an address older than 48 hours", { address: addr(3), day: TODAY - 3 }, NOW],
    ["an expired request", { address: addr(3), day: TODAY }, NOW + CODE_LIFETIME_MS],
  ])("replaces a code with %s and cancels it", async (_label, ready, later) => {
    const { deps, cancelled } = harness([
      ready,
      { address: addr(4), day: Math.floor(later / DAY_MS) },
    ])
    const old = await currentCode(deps, NOW)
    const fresh = await currentCode(deps, later)
    expect(fresh.address).toBe(addr(4))
    expect(cancelled).toEqual([old.requestId])
  })

  it("replaces a code pinned to an L2 address the account has left, and cancels it", async () => {
    const before = `0x${"0a".repeat(32)}`
    const { deps, cancelled } = harness(
      [
        { address: addr(9), day: TODAY },
        { address: addr(10), day: TODAY },
      ],
      before,
    )
    const old = await currentCode(deps, NOW)
    expect(await openCode(deps, NOW)).toEqual(old)
    // A backup passkey moves the account to a new L2 address.
    deps.requester = `0x${"0b".repeat(32)}`
    const fresh = await openCode(deps, NOW)
    expect(fresh.address).toBe(addr(10))
    expect(cancelled).toEqual([old.requestId])
  })

  it("replaces a code that records no requester once the account's address is known", async () => {
    const { deps, cancelled } = harness([
      { address: addr(11), day: TODAY },
      { address: addr(12), day: TODAY },
    ])
    const old = await currentCode(deps, NOW)
    deps.requester = `0x${"0a".repeat(32)}`
    const fresh = await openCode(deps, NOW)
    expect(fresh).toMatchObject({ address: addr(12), requester: deps.requester })
    expect(cancelled).toEqual([old.requestId])
    expect(await openCode(deps, NOW)).toEqual(fresh)
  })

  it("puts an amount on a code minted for an old L2 address with a new address", async () => {
    const { deps, cancelled } = harness(
      [
        { address: addr(13), day: TODAY },
        { address: addr(14), day: TODAY },
      ],
      `0x${"0a".repeat(32)}`,
    )
    const old = await currentCode(deps, NOW)
    deps.requester = `0x${"0b".repeat(32)}`
    const priced = await setCodeAmount(deps, { amountInput: "5", noteInput: "" }, NOW)
    expect(priced).toMatchObject({ address: addr(14), amount: 5, requester: deps.requester })
    expect(cancelled).toEqual([old.requestId])
  })

  it("puts an amount on the code, then opens on a plain code with the same address", async () => {
    const { deps, cancelled } = harness([{ address: addr(5), day: TODAY }])
    await currentCode(deps, NOW)
    const note = "Lunch"
    const priced = await setCodeAmount(deps, { amountInput: "12.5", noteInput: note }, NOW)
    expect(priced).toMatchObject({ address: addr(5), amount: 12.5, note })
    const opened = await openCode(deps, NOW)
    expect(opened).toMatchObject({ address: addr(5), amount: 0, note: undefined })
    expect(cancelled).toContain(priced.requestId)
    expect(await openCode(deps, NOW)).toEqual(opened)
  })

  it.each([
    ["a plain code", ""],
    ["a code with an amount", "25"],
  ])("moves %s paid while Receive was closed to a new address", async (_label, amountInput) => {
    const { deps, cancelled, paidIds } = harness([
      { address: addr(7), day: TODAY },
      { address: addr(8), day: TODAY },
    ])
    const first = await setCodeAmount(deps, { amountInput, noteInput: "" }, NOW)
    paidIds.add(first.requestId)
    const opened = await openCode(deps, NOW + 1)
    expect(opened.address).toBe(addr(8))
    expect(opened.amount).toBe(0)
    expect(cancelled).not.toContain(first.requestId)
  })
})
