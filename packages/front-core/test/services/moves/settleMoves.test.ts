// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { settlePass } from "../../../src/core/services/moves/settleMoves"
import { MOVE_SCAN_MARGIN, MOVE_SCAN_SPAN } from "../../../src/engine/moveScanCursor"
import type { MoveStore } from "../../../src/engine/moves"
import { WITHDRAWAL_SUBMIT_TIMEOUT_MS } from "../../../src/engine/withdrawals"
import { SKY_HOLDING } from "./fixtures"
import { moveWorld, runRoute, type MoveWorld } from "./moveWorld"

const SKY = SKY_HOLDING.id

/** Mines `n` empty blocks. */
async function mine(world: Pick<MoveWorld, "l1">, n: number) {
  for (let i = 0; i < n; i++) await world.l1.mine()
}

describe("settlePass", () => {
  it("carries a move in and back out on the escrow rail, claiming each deposit once", async () => {
    const world = await moveWorld()
    const { service, account, settle, read } = world
    const into = await service.add(SKY, 100n, "op-in")
    expect(into).toMatchObject({ phase: "burned", quote: { routed: 96n, withdrawalFee: 1n } })
    expect(await account.balance(SKY_HOLDING.base)).toBe(900n)

    await settle()
    expect(await read(into.id)).toMatchObject({
      phase: "burned",
      observed: { maxDeposit: 10n ** 24n },
    })

    const { made } = await runRoute(world, into, { assets: 97n, deposit: 90n })
    await settle()
    expect(await read(into.id)).toMatchObject({
      phase: "claimed",
      assets: 97n,
      deposit: { amount: 90n },
      l1: { depositTx: made.txHash },
      endTime: world.clock.now,
    })
    await settle()
    expect(await account.balance(SKY_HOLDING.held)).toBe(90n)

    const out = await service.withdraw(SKY, 90n, "op-out")
    await runRoute(world, out, { assets: 95n, deposit: 94n })
    await settle()
    expect(await read(out.id)).toMatchObject({ phase: "claimed", assets: 95n })
    expect(await account.balance(SKY_HOLDING.held)).toBe(0n)
    expect(await account.balance(SKY_HOLDING.base)).toBe(994n)
  })

  it("reads the balance again only once the claim is recorded, so its funds count once", async () => {
    const world = await moveWorld()
    const move = await world.service.add(SKY, 100n, "op-1")
    await runRoute(world, move, { assets: 97n, deposit: 90n })
    const seen: string[] = []
    const refreshBalance = async () => void seen.push((await world.read(move.id)).phase)
    await settlePass({ ...world.deps, refreshBalance }, world.ports, new AbortController().signal)
    expect(seen).toEqual(["claimed"])
  })

  it("finds a deposit a reorg moved behind the last head, since the cursor keeps the margin", async () => {
    let hidden = true
    const world = await moveWorld({
      routes: (routes) => ({
        ...routes,
        findDeposit: async (...args) => (hidden ? undefined : routes.findDeposit(...args)),
      }),
    })
    const move = await world.service.add(SKY, 100n, "op-1")
    const { made } = await runRoute(world, move, { assets: 97n, deposit: 90n, gap: 100 })
    await mine(world, 10)
    const head = world.l1.head()

    await world.settle()
    const searched = await world.read(move.id)
    expect(searched).toMatchObject({ phase: "released", scannedTo: head - MOVE_SCAN_MARGIN })
    expect(searched.scannedTo).toBeLessThan(made.blockNumber)

    hidden = false
    await world.settle()
    expect(await world.read(move.id)).toMatchObject({ phase: "claimed" })
  })

  it("commits a move's release and its cursor together or not at all", async () => {
    const world = await moveWorld()
    const move = await world.service.add(SKY, 100n, "op-1")
    // The deposit lands past the first span, so the pass that sees the run records a cursor.
    const gap = Number(MOVE_SCAN_SPAN + MOVE_SCAN_MARGIN)
    await runRoute(world, move, { assets: 97n, deposit: 90n, gap })
    const { moves } = world.deps
    // The pass's write stops at the cursor, as a crash between the two writes would.
    const crashing: MoveStore = {
      ...moves,
      apply: (id, event, w) =>
        event.type === "scanned" ? Promise.reject(new Error("crash")) : moves.apply(id, event, w),
    }
    const crashed = { ...world.deps, refreshBalance: async () => undefined, moves: crashing }
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await settlePass(crashed, world.ports, new AbortController().signal)
    expect(await world.read(move.id)).toMatchObject({ phase: "burned" })
    expect((await world.read(move.id)).scannedTo).toBeUndefined()

    await world.settle()
    expect(await world.read(move.id)).toMatchObject({
      phase: "released",
      scannedTo: move.scanFrom + MOVE_SCAN_SPAN - 1n,
    })
  })

  it("searches a move older than one span a span a pass until it finds the run", async () => {
    const world = await moveWorld()
    const move = await world.service.add(SKY, 100n, "op-1")
    await mine(world, 2 * Number(MOVE_SCAN_SPAN) + 5)
    await runRoute(world, move, { assets: 97n, deposit: 90n })
    await mine(world, Number(MOVE_SCAN_MARGIN))

    await world.settle()
    expect(await world.read(move.id)).toMatchObject({
      phase: "burned",
      scannedTo: move.scanFrom + MOVE_SCAN_SPAN - 1n,
    })
    await world.settle()
    expect(await world.read(move.id)).toMatchObject({
      phase: "burned",
      scannedTo: move.scanFrom + 2n * MOVE_SCAN_SPAN - 1n,
    })
    await world.settle()
    expect(await world.read(move.id)).toMatchObject({ phase: "claimed" })
  })

  it.each([
    { during: "withdrawalSpent", phase: "burned" },
    { during: "outcome", phase: "burned" },
    { during: "findDeposit", phase: "depositSeen" },
  ] as const)(
    "reads and claims nothing more once the pass's signal aborts during $during",
    async ({ during, phase }) => {
      const aborting = new AbortController()
      /** The reads that answered after the abort. */
      const late: string[] = []
      const watched =
        <A extends unknown[], T>(name: string, read: (...args: A) => Promise<T>) =>
        async (...args: A) => {
          const aborted = aborting.signal.aborted
          const value = await read(...args)
          if (aborted) late.push(name)
          if (name === during) aborting.abort()
          return value
        }
      const world = await moveWorld({
        routes: (routes) => ({
          ...routes,
          withdrawalSpent: watched("withdrawalSpent", routes.withdrawalSpent),
          outcome: watched("outcome", routes.outcome),
          findDeposit: watched("findDeposit", routes.findDeposit),
        }),
      })
      const move = await world.service.add(SKY, 100n, "op-1")
      await runRoute(world, move, { assets: 97n, deposit: 90n })

      await expect(settlePass(world.deps, world.ports, aborting.signal)).rejects.toMatchObject({
        name: "AbortError",
      })
      expect(late).toEqual([])
      expect(await world.read(move.id)).toMatchObject({ phase })
      expect(await world.account.balance(SKY_HOLDING.held)).toBe(0n)
    },
  )

  it("spends a fixed number of reads per open move, and reads a route and the head once a pass", async () => {
    const calls: Record<string, number> = {}
    const counted = <T extends object>(routes: T): T =>
      Object.fromEntries(
        Object.entries(routes).map(([name, member]) => [
          name,
          typeof member !== "function"
            ? member
            : (...args: unknown[]) => {
                calls[name] = (calls[name] ?? 0) + 1
                return member(...args)
              },
        ]),
      ) as T
    const world = await moveWorld({ routes: counted })
    const waiting = await world.service.add(SKY, 100n, "op-1")
    const ran = [
      await world.service.add(SKY, 100n, "op-2"),
      await world.service.add(SKY, 100n, "op-3"),
    ]
    for (const move of ran) await runRoute(world, move, { assets: 97n, deposit: 90n })
    for (const key of Object.keys(calls)) delete calls[key]

    await world.settle()
    // Waiting: its release and limits. Run: its release, run and deposit.
    expect(calls).toEqual({
      head: 1,
      read: 1,
      withdrawalSpent: 3,
      outcome: 2,
      findDeposit: 2,
      limits: 1,
    })
    expect((await world.read(waiting.id)).phase).toBe("burned")
    for (const move of ran) expect((await world.read(move.id)).phase).toBe("claimed")
  })
})

describe("a deposit's claim", () => {
  it("waits for a deposit's message to reach L2 without failing the pass or the other claims", async () => {
    const world = await moveWorld()
    const late = await world.service.add(SKY, 100n, "op-1")
    const landed = await world.service.add(SKY, 100n, "op-2")
    const { made } = await runRoute(world, late, { assets: 97n, deposit: 90n })
    await runRoute(world, landed, { assets: 97n, deposit: 90n })
    world.l1.inTransit.add(made.deposit.messageKey)

    await world.settle()
    expect(await world.read(late.id)).toMatchObject({ phase: "depositSeen" })
    expect(await world.read(landed.id)).toMatchObject({ phase: "claimed" })

    world.l1.inTransit.delete(made.deposit.messageKey)
    await world.settle()
    expect(await world.read(late.id)).toMatchObject({ phase: "claimed" })
    expect(await world.account.balance(SKY_HOLDING.held)).toBe(180n)
  })

  it("leaves a deposit with no message key, claimed before its message is on L2, for the next pass", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const world = await moveWorld()
    const early = await world.service.add(SKY, 100n, "op-1")
    const other = await world.service.add(SKY, 100n, "op-2")
    const { made } = await runRoute(world, early, { assets: 97n, deposit: 90n })
    await runRoute(world, other, { assets: 97n, deposit: 90n })
    // As an older build's record carries it: the deposit seen, its message key not kept.
    const { messageKey, ...deposit } = made.deposit
    await world.moves.apply(early.id, { type: "depositSeen", txHash: made.txHash, deposit })
    world.l1.inTransit.add(messageKey)

    await world.settle()
    expect(await world.read(early.id)).toMatchObject({ phase: "depositSeen" })
    expect(await world.read(other.id)).toMatchObject({ phase: "claimed" })

    world.l1.inTransit.delete(messageKey)
    await world.settle()
    expect(await world.read(early.id)).toMatchObject({ phase: "claimed" })
  })

  it("fails the pass when the head, every move's read, cannot be read", async () => {
    let down: Error | undefined
    const world = await moveWorld({
      routes: (routes) => ({
        ...routes,
        head: () => (down ? Promise.reject(down) : routes.head()),
      }),
    })
    await world.service.add(SKY, 100n, "op-1")
    down = new Error("rpc down")
    await expect(world.settle()).rejects.toBe(down)
  })

  it("leaves a move whose claim faults for the next pass, and settles the others", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const first = await moveWorld()
    const fault = new Error("the claim faulted")
    let faulty: bigint | undefined
    const world = await moveWorld({
      l1: first.l1,
      account: {
        ...first.account,
        claim: async (bridge, deposit, signal) => {
          if (deposit.inboxIndex === faulty) throw fault
          return first.account.claim(bridge, deposit, signal)
        },
      },
    })
    const broken = await world.service.add(SKY, 100n, "op-1")
    const sound = await world.service.add(SKY, 100n, "op-2")
    const { made } = await runRoute(world, broken, { assets: 97n, deposit: 90n })
    await runRoute(world, sound, { assets: 97n, deposit: 90n })
    faulty = made.deposit.inboxIndex

    await world.settle()
    expect(await world.read(broken.id)).toMatchObject({ phase: "depositSeen" })
    expect(await world.read(sound.id)).toMatchObject({ phase: "claimed" })

    faulty = undefined
    await world.settle()
    expect(await world.read(broken.id)).toMatchObject({ phase: "claimed" })
  })
})

describe("a move whose burn never went out", () => {
  it("ends dropped when the burn is refused before its record is seeded", async () => {
    const world = await moveWorld({ burns: "refused" })
    await expect(world.service.add(SKY, 100n, "op-1")).rejects.toThrow()
    const [move] = (await world.moves.view.get()).records
    expect(move).toMatchObject({ phase: "dropped", endTime: world.clock.now })
    expect(await world.moves.open()).toEqual([])
  })

  it("stays burning while its record may still be seeded, then ends dropped", async () => {
    const world = await moveWorld()
    const sent = await world.service.add(SKY, 100n, "op-1")
    // Saved, then the tab closed before the burn's record was seeded.
    const { phase, l1, ...built } = sent
    const id = "wdraw_unseeded"
    const record = { ...built, id, withdrawalLocalId: id, quote: sent.quote ?? built.quote! }
    await world.moves.apply(id, { type: "built", record })

    world.clock.now += WITHDRAWAL_SUBMIT_TIMEOUT_MS - 1
    await world.settle()
    expect((await world.read(id)).phase).toBe("burning")
    world.clock.now += 1
    await world.settle()
    expect(await world.read(id)).toMatchObject({ phase: "dropped", endTime: world.clock.now })
  })

  it("fails with its burn when the burn's record failed", async () => {
    const world = await moveWorld({ burns: "failed" })
    await expect(world.service.add(SKY, 100n, "op-1")).rejects.toThrow()
    const [built] = (await world.moves.view.get()).records
    expect(built?.phase).toBe("burning")
    await world.settle()
    expect(await world.read(built?.id ?? "")).toMatchObject({
      phase: "failed",
      failure: { code: "withdrawal.failed" },
    })
  })
})
