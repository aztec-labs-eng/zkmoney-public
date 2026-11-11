import { TxStatus } from "@aztec-labs/stdlib/tx"
import { MAX_TX_LIFETIME_MS } from "@obsidion/core/constants"
import type { SpendShape, TxHashCallback } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"
import { txOutcome, type TxOutcome } from "../../../src/core/rotation/backupRotationFlow"
import {
  movePreviousBalance,
  PREVIOUS_MOVE_POLL_MS,
  type PreviousMoveDeps,
} from "../../../src/core/rotation/movePreviousBalance"
import { openDatabase } from "../../../src/engine/database"
import { WalletError } from "../../../src/engine/errors"
import { memoryBackend } from "../../../src/engine/memoryBackend"
import {
  createSavedPreviousAccount,
  type PreviousAccountMove,
} from "../../../src/engine/savedPreviousAccount"
import { word } from "../../__test-helpers__/backupRotation"

const DAI = 10n ** 18n
const DUST = 10n ** 16n
const START = 10_000
const ONE_KEY = `0x${"11".repeat(32)}`
const TWO_KEY = `0x${"22".repeat(32)}`
const OTHER = `0x${"33".repeat(32)}`

const DONE = { kind: "done" }
const STOPPED = { kind: "stopped" }
const PENDING: TxOutcome = { kind: "pending" }
const MINED: TxOutcome = { kind: "mined" }
const included = (
  checkpointed: boolean,
  effect: "success" | "reverted" = "success",
): TxOutcome => ({
  kind: "included",
  blockNumber: 9,
  blockHash: "0xb9",
  effect,
  checkpointed,
})

const hash = (n: number) => word(0x100 + n)
const notes = (...amounts: bigint[]): SpendShape => ({
  notes: amounts,
  depositTotal: 0n,
  balance: amounts.reduce((total, amount) => total + amount, 0n),
})
const chunk = (txHash: string, over: Partial<PreviousAccountMove> = {}): PreviousAccountMove => ({
  destination: TWO_KEY,
  txHash,
  expiresAtMs: START + 60_000,
  amount: DAI,
  ...over,
})

interface World {
  clock: { t: number }
  shape: SpendShape
  outcomes: Map<string, TxOutcome>
  /** One runs on each wait, in order; with none left the run is cancelled. */
  waits: Array<() => void | Promise<void>>
  log: string[]
  hashes: number
  destinationOk: boolean
  /** The send's preparation, before it asks to sign. */
  prepare?: () => Promise<void>
  refuse?: Error
  afterHash?: Error
  noHash?: boolean
  expiresAtMs?: number
}

const dai = (amount: bigint) => `${Number(amount) / 1e18}`

function harness(over: Partial<World> = {}, backend = memoryBackend()) {
  const world: World = {
    clock: { t: START },
    shape: notes(),
    outcomes: new Map(),
    waits: [],
    log: [],
    hashes: 0,
    destinationOk: true,
    ...over,
  }
  const controller = new AbortController()
  const saved = createSavedPreviousAccount(openDatabase(backend))
  const deps: PreviousMoveDeps = {
    saved,
    address: ONE_KEY,
    destination: TWO_KEY,
    shape: vi.fn(async () => world.shape),
    cap: 2n * DAI,
    dust: DUST,
    send: vi.fn(async (amount: bigint, onTxHash: TxHashCallback, signal: AbortSignal) => {
      await world.prepare?.()
      if (signal.aborted) throw new Error("aborted")
      world.log.push(`sign ${dai(amount)}`)
      if (world.refuse) throw world.refuse
      const txHash = hash(++world.hashes)
      if (world.noHash) return
      await onTxHash(txHash, { expiresAtMs: world.expiresAtMs ?? world.clock.t + 60_000 })
      world.outcomes.set(txHash, PENDING)
      world.log.push(`sent ${dai(amount)}`)
      if (world.afterHash) throw world.afterHash
    }),
    outcome: vi.fn(async (txHash: string) => world.outcomes.get(txHash) ?? PENDING),
    destinationOk: vi.fn(async () => world.destinationOk),
    sleep: vi.fn(async (ms: number) => {
      world.clock.t += ms
      const next = world.waits.shift()
      if (next) await next()
      else controller.abort()
    }),
    now: () => world.clock.t,
  }
  return { deps, world, controller, saved, backend }
}

type Run = ReturnType<typeof harness>
const stored = (run: Pick<Run, "saved">) => run.saved.move(ONE_KEY)
const seed = (run: Pick<Run, "saved">, move = chunk(hash(9))) => run.saved.saveMove(ONE_KEY, move)

describe("movePreviousBalance", () => {
  it("sends one chunk, waits for its checkpoint, then sends the next, and ends done", async () => {
    const { deps, world, controller } = harness({ shape: notes(2n * DAI, 1n * DAI) })
    world.waits = [
      () => {
        world.log.push("proposed")
        world.outcomes.set(hash(1), included(false))
      },
      () => {
        world.log.push("checkpointed")
        world.outcomes.set(hash(1), included(true))
        world.shape = notes(1n * DAI)
      },
      () => {
        world.log.push("final")
        world.outcomes.set(hash(2), MINED)
        world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(world.log).toEqual([
      "sign 2",
      "sent 2",
      "proposed",
      "checkpointed",
      "sign 1",
      "sent 1",
      "final",
    ])
    expect(deps.destinationOk).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledWith(PREVIOUS_MOVE_POLL_MS)
  })

  it("checks the destination again before each chunk", async () => {
    const { deps, world, controller } = harness({ shape: notes(2n * DAI, 1n * DAI) })
    world.waits = [
      () => {
        world.outcomes.set(hash(1), MINED)
        world.shape = notes(1n * DAI)
        world.destinationOk = false
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual({
      kind: "refused",
      reason: "destination",
      amount: DAI,
    })
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it("ends done with nothing sent when the balance is below the dust floor", async () => {
    const { deps, controller } = harness({ shape: notes(DUST - 1n) })
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(deps.send).not.toHaveBeenCalled()
    expect(deps.destinationOk).not.toHaveBeenCalled()
  })

  it.each([
    ["pending", PENDING],
    ["included without a checkpoint", included(false)],
    ["included and reverted without a checkpoint", included(false, "reverted")],
    ["unreadable", { kind: "unknown" } as TxOutcome],
  ])("reads no shape and asks for no signature while its chunk is %s", async (_, outcome) => {
    const { deps, world, controller } = harness({ shape: notes(1n * DAI) })
    world.waits = [
      () => {
        world.log.push("waited")
        world.outcomes.set(hash(1), outcome)
      },
      () => {
        world.log.push("checkpointed")
        world.outcomes.set(hash(1), included(true))
        world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(world.log).toEqual(["sign 1", "sent 1", "waited", "checkpointed"])
    expect(deps.shape).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["dead", { kind: "dead" } as TxOutcome],
    ["reverted", { kind: "reverted" } as TxOutcome],
    ["reverted at a checkpoint", included(true, "reverted")],
  ])("cuts the next chunk from the live shape once its chunk is %s", async (_, outcome) => {
    const run = harness({ shape: notes(1n * DAI) })
    const { deps, world, controller } = run
    world.waits = [
      () => void world.outcomes.set(hash(1), outcome),
      () => {
        world.outcomes.set(hash(2), MINED)
        world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(world.log).toEqual(["sign 1", "sent 1", "sign 1", "sent 1"])
    expect(await stored(run)).toBeUndefined()
  })

  it("resolves a chunk a reload left in flight before it plans", async () => {
    const backend = memoryBackend()
    await seed(harness({}, backend))
    const { deps, world, controller } = harness({ shape: notes(1n * DAI) }, backend)
    world.outcomes.set(hash(9), MINED)
    world.waits = [
      () => {
        world.outcomes.set(hash(1), MINED)
        world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(deps.outcome).toHaveBeenNthCalledWith(1, hash(9), START + 60_000)
    expect(vi.mocked(deps.outcome).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.shape).mock.invocationCallOrder[0]!,
    )
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it("resolves a chunk an earlier session sent elsewhere by its hash, then refuses with no new send", async () => {
    const run = harness({ shape: notes(1n * DAI) })
    await seed(run, chunk(hash(9), { destination: OTHER }))
    run.world.waits = [() => void run.world.outcomes.set(hash(9), MINED)]
    expect(await movePreviousBalance(run.deps, run.controller.signal)).toEqual({
      kind: "refused",
      reason: "destination",
      amount: DAI,
    })
    expect(run.deps.outcome).toHaveBeenCalledTimes(2)
    expect(run.deps.send).not.toHaveBeenCalled()
    expect(run.deps.shape).not.toHaveBeenCalled()
    expect(await stored(run)).toBeUndefined()
  })

  it("stops with nothing sent when cancelled while the send prepares", async () => {
    const { deps, world, controller } = harness({ shape: notes(1n * DAI) })
    world.prepare = async () => {
      await Promise.resolve()
      controller.abort()
    }
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(STOPPED)
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(world.log).toEqual([])
  })

  it("stops while a chunk is in flight and keeps it", async () => {
    const run = harness({ shape: notes(2n * DAI, 1n * DAI) })
    expect(await movePreviousBalance(run.deps, run.controller.signal)).toEqual(STOPPED)
    expect(run.deps.send).toHaveBeenCalledTimes(1)
    expect(await stored(run)).toEqual(chunk(hash(1), { amount: 2n * DAI }))
  })

  it("on an aborted signal reads a saved chunk once and keeps it, and with none sends nothing", async () => {
    const run = harness({ shape: notes(1n * DAI) })
    run.controller.abort()
    await seed(run)
    expect(await movePreviousBalance(run.deps, run.controller.signal)).toEqual(STOPPED)
    expect(run.deps.outcome).toHaveBeenCalledTimes(1)
    expect(await stored(run)).toEqual(chunk(hash(9)))
    await run.saved.clearMove(ONE_KEY, hash(9))
    expect(await movePreviousBalance(run.deps, run.controller.signal)).toEqual(STOPPED)
    expect(run.deps.shape).not.toHaveBeenCalled()
    expect(run.deps.send).not.toHaveBeenCalled()
  })

  it("stops the send when the chunk cannot be saved, and the next run plans again", async () => {
    const run = harness({ shape: notes(1n * DAI) })
    await stored(run)
    run.backend.failing.commits = true
    await expect(movePreviousBalance(run.deps, run.controller.signal)).rejects.toBeInstanceOf(WalletError)
    expect(run.world.log).toEqual(["sign 1"])
    run.backend.failing.commits = false
    run.world.waits = [
      () => {
        run.world.outcomes.set(hash(2), MINED)
        run.world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(run.deps, run.controller.signal)).toEqual(DONE)
    expect(run.world.log).toEqual(["sign 1", "sign 1", "sent 1"])
  })

  it("keeps a chunk whose send threw after it was saved, and resolves it by hash next time", async () => {
    const run = harness({ shape: notes(1n * DAI), afterHash: new Error("node unreachable") })
    await expect(movePreviousBalance(run.deps, run.controller.signal)).rejects.toThrow(
      "node unreachable",
    )
    expect((await stored(run))?.txHash).toBe(hash(1))
    run.world.afterHash = undefined
    run.world.waits = [
      () => {
        run.world.outcomes.set(hash(1), MINED)
        run.world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(run.deps, run.controller.signal)).toEqual(DONE)
    expect(run.deps.send).toHaveBeenCalledTimes(1)
  })

  it("ends refused with the chunk's amount on a spend refusal", async () => {
    const { deps, controller } = harness({
      shape: notes(2n * DAI, 1n * DAI),
      refuse: new Error("simulation failed", { cause: new Error("Balance too low") }),
    })
    expect(await movePreviousBalance(deps, controller.signal)).toEqual({
      kind: "refused",
      reason: "spend",
      amount: 2n * DAI,
    })
  })

  it("rethrows a send that fails before its hash for another reason", async () => {
    const { deps, controller } = harness({
      shape: notes(1n * DAI),
      refuse: new Error("The passkey prompt was dismissed"),
    })
    await expect(movePreviousBalance(deps, controller.signal)).rejects.toThrow("dismissed")
  })

  it("cuts a smaller first chunk under a cap of half the refused amount", async () => {
    const { deps, world, controller } = harness({
      shape: notes(2n * DAI),
      refuse: new Error("Balance too low"),
    })
    const refused = await movePreviousBalance(deps, controller.signal)
    expect(refused).toEqual({ kind: "refused", reason: "spend", amount: 2n * DAI })
    world.refuse = undefined
    const amount = refused.kind === "refused" ? refused.amount : 0n
    expect(await movePreviousBalance({ ...deps, cap: amount / 2n }, controller.signal)).toEqual(
      STOPPED,
    )
    expect(world.log).toEqual(["sign 2", "sign 1", "sent 1"])
  })

  it("refuses before any send when the destination check fails", async () => {
    const { deps, world, controller } = harness({
      shape: notes(1n * DAI),
      destinationOk: false,
    })
    expect(await movePreviousBalance(deps, controller.signal)).toEqual({
      kind: "refused",
      reason: "destination",
      amount: DAI,
    })
    expect(deps.send).not.toHaveBeenCalled()
    expect(world.log).toEqual([])
  })

  it("ends a run whose send returned without a hash, sending nothing more", async () => {
    const { deps, controller } = harness({ shape: notes(1n * DAI), noHash: true })
    await expect(movePreviousBalance(deps, controller.signal)).rejects.toMatchObject({
      code: "invariant",
    })
    expect(deps.send).toHaveBeenCalledTimes(1)
  })
})

describe("the chunk's expiry", () => {
  it("caps a far-future expiry when saved, so a chunk that never lands ends dead after a reload", async () => {
    let finalizedAt = 0
    const node = {
      getTxReceipt: vi.fn(async () => ({ status: TxStatus.DROPPED })),
      finalizedTimestampMs: vi.fn(async () => finalizedAt),
    }
    const outcomeAt = (run: Run) =>
      vi.fn((txHash: string, expiresAtMs: number) =>
        txOutcome(node, txHash, expiresAtMs, run.world.clock.t),
      )
    const run = harness({ shape: notes(1n * DAI), expiresAtMs: 10 ** 15 })
    run.deps.outcome = outcomeAt(run)
    run.world.waits = [() => undefined]
    expect(await movePreviousBalance(run.deps, run.controller.signal)).toEqual(STOPPED)
    const capped = START + MAX_TX_LIFETIME_MS
    expect((await stored(run))?.expiresAtMs).toBe(capped)

    const reloaded = harness({ shape: notes() }, run.backend)
    reloaded.deps.outcome = outcomeAt(reloaded)
    reloaded.world.clock.t = capped + 1
    finalizedAt = capped + 1
    expect(await movePreviousBalance(reloaded.deps, reloaded.controller.signal)).toEqual(DONE)
    expect(await stored(reloaded)).toBeUndefined()
  })

  it("keeps an expiry inside the transaction's lifetime as reported", async () => {
    const run = harness({ shape: notes(1n * DAI), expiresAtMs: START + 1_000 })
    await movePreviousBalance(run.deps, run.controller.signal)
    expect((await stored(run))?.expiresAtMs).toBe(START + 1_000)
  })
})

describe("a saved chunk that does not read", () => {
  it("stops a move rather than reading no chunk in flight", async () => {
    const backend = memoryBackend()
    await seed(harness({}, backend))
    const [key] = [...backend.entries.keys()].filter((k) => k.startsWith("acct/previousAccount/"))
    backend.entries.set(key, JSON.stringify({ id: "previous", address: ONE_KEY, move: {} }))
    const { deps, controller } = harness({ shape: notes(1n * DAI) }, backend)
    await expect(movePreviousBalance(deps, controller.signal)).rejects.toBeInstanceOf(WalletError)
    expect(deps.send).not.toHaveBeenCalled()
  })
})
