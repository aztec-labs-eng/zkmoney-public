import { createPace } from "@obsidion/core/cadence"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openDatabase, type Database, type DatabaseBackend } from "../../src/engine/database"
import { WalletError } from "../../src/engine/errors"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import { fixed } from "../../src/engine/service"
import { startRuntime, type Runtime } from "../../src/engine/runtime"
import {
  BroadcastDeferred,
  broadcastJob,
  sipaBroadcasts,
  type BroadcastExecutor,
  type BroadcastTxState,
} from "../../src/engine/sipaBroadcasts"
import {
  createSipaDeposits,
  type BroadcastJob,
  type OwedBroadcast,
  type SipaDeposits,
} from "../../src/engine/sipaDeposits"
import { memoryStore } from "../../src/engine/store"
import { createOperations, type Operations } from "../../src/engine/operations"

/** The chain the task reads: every tx the prover sent, and what became of it. */
class FakeChain {
  readonly txs = new Map<string, BroadcastTxState>()
  /** SIPA addresses whose broadcast is on chain, whoever sent it. */
  readonly landed = new Set<string>()
  include(txHash: string, address: string) {
    this.txs.set(txHash, "included")
    this.landed.add(address)
  }
  state = async (txHash: string): Promise<BroadcastTxState> => this.txs.get(txHash) ?? "dropped"
}

/** A prover that sends what it is asked, in order, unless a test holds or fails the next send. */
class FakeProver implements BroadcastExecutor {
  readonly sent: string[] = []
  readonly recorded: BroadcastJob[] = []
  private count = 0
  /** An error fails the build, before any hash; `fail-after-hash` fails once the node may hold it. */
  next?: "hang" | "hang-after-hash" | "fail-after-hash" | Error
  /** Owner writes still to fail. */
  failRecords = 0
  /** Whether the saved hash was readable from the database when `onTxHash` resolved, per send. */
  readonly hashDurable: boolean[] = []
  constructor(
    private readonly chain: FakeChain,
    private readonly saved: () => Promise<SipaDeposits>,
  ) {}
  landed = async (job: BroadcastJob) => this.chain.landed.has(job.address)
  onLanded = (job: BroadcastJob) => {
    if (this.failRecords > 0) {
      this.failRecords--
      throw new Error("storage full")
    }
    this.recorded.push(job)
  }
  send = async (job: BroadcastJob, attempt: { onTxHash: (txHash: string) => Promise<void> }) => {
    const txHash = `0x${job.address.slice(-4)}${++this.count}`
    this.sent.push(job.address)
    const next = this.next
    this.next = undefined
    if (next === "hang") return new Promise<string>(() => {})
    if (next instanceof Error) throw next
    await attempt.onTxHash(txHash)
    const reloaded = await this.saved()
    this.hashDurable.push((await reloaded.get(job.address))?.broadcast?.txHash === txHash)
    if (next === "hang-after-hash") return new Promise<string>(() => {})
    // The node holds it either way; only the wait for it failed.
    this.chain.txs.set(txHash, "pending")
    if (next === "fail-after-hash") throw new Error("timed out waiting for the tx")
    return txHash
  }
}

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
const slot = (n: number, over: Partial<OwedBroadcast> = {}): OwedBroadcast => ({
  kind: "deposit",
  source: { type: "slot" },
  ...over,
})
const registration: Pick<OwedBroadcast, "kind" | "source"> = {
  kind: "registration",
  source: { type: "registration", account: "0xacc" },
}

let backend: MemoryBackend
let chain: FakeChain
let clock: number
const runtimes: Runtime[] = []

beforeEach(() => {
  backend = memoryBackend()
  chain = new FakeChain()
  clock = 1_000_000
})
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
})

const record = (operations: Operations, id: string) =>
  operations.view.get().records.find((r) => r.operationId === id)

const open = (on: DatabaseBackend | Database = backend) =>
  createSipaDeposits({
    db: "write" in on ? on : openDatabase(on),
    account: true,
    now: () => Date.now(),
  })

/** The shared database, its records read a moment after the store opens. */
const slowRecords = (): DatabaseBackend => ({
  ...backend,
  range: async (prefix, opts) => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return backend.range(prefix, opts)
  },
})

/** One page: its store, operation store, prover and task over the shared database. */
function page(
  opts: {
    busy?: () => boolean
    backend?: DatabaseBackend
    after?: (after: { firstBalance?: boolean }) => Promise<boolean>
  } = {},
) {
  const db = openDatabase(opts.backend ?? backend)
  const operations = createOperations({ db, now: () => Date.now() })
  const store = open(db)
  const prover = new FakeProver(chain, async () => open())
  const broadcasts = sipaBroadcasts<object>({
    wallet: fixed("wallet", {}),
    db,
    store,
    operations,
    executors: () => ({ slot: prover, registration: prover, rotation: prover }),
    txState: (_wallet, txHash) => chain.state(txHash),
    runExclusive: (attempt) => attempt(),
    busy: opts.busy,
    describe: (job) =>
      job.kind === "pool" ? undefined : { flow: "deposit", summary: "Deposit address" },
    now: () => clock,
  })
  const runtime = startRuntime([broadcasts.task], {
    db: openDatabase(memoryBackend()),
    milestones: { after: opts.after ?? (async () => true), reached: () => true },
    visible: memoryStore(true).readonly,
    pace: createPace(),
    now: () => Date.now(),
  })
  runtimes.push(runtime)
  const job = (n: number) => broadcastJob(store.view.get().records, address(n))
  const owe = (n: number, owed: OwedBroadcast = slot(n)) => {
    clock += 1
    return store.oweBroadcast(address(n), owed)
  }
  /** Runs the task until nothing new happens; the chain includes whatever was sent, if asked to. */
  const drain = async ({ mine = true } = {}) => {
    for (let i = 0; i < 30; i++) {
      const before = JSON.stringify(store.view.get().records)
      if (mine)
        for (const r of store.view.get().records)
          if (r.broadcast?.state === "sent") chain.include(r.broadcast.txHash!, r.sipaAddress)
      await runtime.wake(broadcasts.task)
      if (JSON.stringify(store.view.get().records) === before) return
    }
    throw new Error("the task did not settle")
  }
  return { store, operations, prover, broadcasts, runtime, job, owe, drain }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("sipaBroadcasts", () => {
  it("sends one broadcast at a time, registration first, then funded, shown and pool", async () => {
    const p = page()
    await p.owe(1, slot(1, { kind: "pool" }))
    await p.owe(2)
    await p.owe(3, slot(3, { fundedAt: 3 }))
    await p.owe(4, { ...registration })
    await p.store.ready
    await p.runtime.wake(p.broadcasts.task)
    // Undecided on chain: nothing else is sent over it.
    expect(p.prover.sent).toEqual([address(4)])
    await p.drain()
    expect(p.prover.sent).toEqual([address(4), address(3), address(2), address(1)])
    expect([1, 2, 3, 4].every((n) => p.job(n)?.state === "landed")).toBe(true)
  })

  it("owes again a build an earlier page left, however late its records load", async () => {
    const first = page()
    await first.owe(1)
    first.prover.next = "hang"
    void first.runtime.wake(first.broadcasts.task)
    await settle()
    expect(first.job(1)?.state).toBe("proving")
    const operationId = first.job(1)!.operationId!
    expect(record(first.operations, operationId)).toMatchObject({ state: "local", resumable: true })
    first.runtime.stop()

    const next = page({ backend: slowRecords() })
    await next.drain()
    expect(next.prover.sent).toEqual([address(1)])
    expect(next.job(1)?.state).toBe("landed")
    expect(record(next.operations, operationId)?.state).toBe("settled")
  })

  it("asks the chain about a send cut off after its hash was known, and never proves it twice", async () => {
    const first = page()
    await first.owe(1)
    first.prover.next = "hang-after-hash"
    void first.runtime.wake(first.broadcasts.task)
    await settle()
    const txHash = first.job(1)!.txHash!
    chain.include(txHash, address(1))
    first.runtime.stop()

    const next = page()
    await next.drain({ mine: false })
    expect(next.prover.sent).toEqual([])
    expect(next.job(1)).toMatchObject({ state: "landed", txHash })
  })

  it("sends nothing from a run aborted while it asks whether the broadcast landed", async () => {
    const p = page()
    await p.owe(1)
    let asked!: () => void
    const asking = new Promise<void>((resolve) => (asked = resolve))
    p.prover.landed = () => {
      asked()
      return new Promise<boolean>(() => {})
    }
    void p.runtime.wake(p.broadcasts.task)
    await asking
    p.runtime.stop()
    await settle()
    expect(p.prover.sent).toEqual([])
    expect(p.job(1)?.state).toBe("queued")
  })

  it("owes again a job whose failure could not be saved", async () => {
    const p = page()
    await p.owe(1)
    const send = p.prover.send
    p.prover.send = async () => {
      backend.failing.commits = true
      throw new Error("offline")
    }
    await p.runtime.wake(p.broadcasts.task)
    backend.failing.commits = false
    expect(p.job(1)?.state).toBe("proving")
    p.prover.send = send
    await p.drain()
    expect(p.prover.sent).toEqual([address(1)])
    expect(p.job(1)?.state).toBe("landed")
  })

  it("tells the owner of every landing, whether it sent it or found it on chain", async () => {
    const p = page()
    await p.owe(1)
    await p.owe(2)
    chain.landed.add(address(2))
    await p.drain()
    expect(p.prover.sent).toEqual([address(1)])
    expect(p.prover.recorded.map((job) => job.address).sort()).toEqual([address(1), address(2)])
    expect(p.prover.recorded.every((job) => job.state !== "landed")).toBe(true)
  })

  it("sends a dropped broadcast again after its backoff", async () => {
    const p = page()
    await p.owe(1)
    await p.runtime.wake(p.broadcasts.task)
    chain.txs.set(p.job(1)!.txHash!, "dropped")
    await p.drain({ mine: false })
    expect(p.job(1)).toMatchObject({
      state: "queued",
      failures: 1,
      failure: { code: "deposit.broadcastDropped" },
      retryAt: clock + 30_000,
    })
    clock += 30_000
    await p.drain()
    expect(p.prover.sent).toEqual([address(1), address(1)])
    expect(p.job(1)?.state).toBe("landed")
  })

  it("waits out a deferral without counting it, and runs at the time it names", async () => {
    const p = page()
    await p.owe(1)
    for (let i = 0; i < 3; i++) {
      p.prover.next = new BroadcastDeferred(clock + 60_000, "unlock")
      await p.drain()
      expect(p.job(1)).toMatchObject({ state: "queued", failures: 0, wait: "unlock" })
      clock += 60_000
    }
    await p.drain()
    expect(p.job(1)?.state).toBe("landed")
  })

  it("keeps retrying an address nobody funded, five minutes apart at most", async () => {
    const p = page()
    await p.owe(1)
    const waits: number[] = []
    for (let i = 0; i < 6; i++) {
      p.prover.next = new Error("offline")
      await p.drain()
      const wait = p.job(1)!.retryAt! - clock
      waits.push(wait)
      clock += wait
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000])
    expect(p.job(1)?.failure).toEqual({ code: "deposit.broadcastFailed", detail: "offline" })
    await p.drain()
    expect(p.prover.sent).toHaveLength(7)
    expect(p.job(1)?.state).toBe("landed")
  })

  it("starts nothing while the user's own transaction runs, and reports pool fills nowhere", async () => {
    let userBusy = true
    const p = page({ busy: () => userBusy })
    await p.owe(1, slot(1, { kind: "pool" }))
    await p.owe(2)
    await p.drain()
    expect(p.prover.sent).toEqual([])
    userBusy = false
    await p.drain()
    expect(p.prover.sent).toEqual([address(2), address(1)])
    expect(p.job(1)?.operationId).toBeUndefined()
  })

  it("proves nothing before the first balance", async () => {
    let reach!: (reached: boolean) => void
    const firstBalance = new Promise<boolean>((resolve) => (reach = resolve))
    const p = page({
      after: (after) => (after.firstBalance ? firstBalance : Promise.resolve(true)),
    })
    await p.owe(1)
    await p.store.ready
    void p.runtime.wake(p.broadcasts.task)
    await settle()
    expect(p.prover.sent).toEqual([])
    reach(true)
    await p.drain()
    expect(p.prover.sent).toEqual([address(1)])
  })

  it("lands a job and settles its operation in one write, or does neither", async () => {
    const p = page()
    await p.owe(1)
    const apply = p.operations.apply
    p.operations.apply = async (id, event, w) => {
      if (event.type === "settled") throw new Error("storage full")
      return apply(id, event, w)
    }
    await p.drain()
    const operationId = p.job(1)!.operationId!
    expect(p.job(1)?.state).toBe("sent")
    expect(record(p.operations, operationId)?.state).not.toBe("settled")
    p.operations.apply = apply
    await p.drain()
    expect(p.job(1)?.state).toBe("landed")
    expect(record(p.operations, operationId)?.state).toBe("settled")
  })

  it("drops a job whose owner has nothing left to publish, and reports nothing for it", async () => {
    const p = page()
    await p.owe(1)
    await p.owe(2)
    p.prover.next = new WalletError("deposit.addressRetired")
    await p.drain()
    expect(p.job(1)).toBeUndefined()
    expect(p.operations.view.get().records.map((op) => op.state)).toEqual(["settled"])
    expect(p.job(2)?.state).toBe("landed")
  })

  it("saves the hash before the node can take the tx", async () => {
    const p = page()
    await p.owe(1)
    await p.drain()
    expect(p.prover.hashDurable).toEqual([true])
  })

  it("lets the chain decide a send that failed after its hash, instead of proving it again", async () => {
    const p = page()
    await p.owe(1)
    p.prover.next = "fail-after-hash"
    await p.runtime.wake(p.broadcasts.task)
    expect(p.job(1)).toMatchObject({ state: "sent", failures: 0 })
    chain.include(p.job(1)!.txHash!, address(1))
    await p.drain({ mine: false })
    expect(p.prover.sent).toEqual([address(1)])
    expect(p.job(1)?.state).toBe("landed")
  })

  it("leaves a hash this page is still sending to that send, and decides it once released", async () => {
    const p = page()
    const release = p.broadcasts.hold(address(1))
    // Saved before the node takes the tx: the node reads it as dropped until then.
    await p.owe(1, slot(1, { txHash: "0xmine" }))
    await p.drain({ mine: false })
    expect(p.job(1)).toMatchObject({ state: "sent", txHash: "0xmine" })
    chain.include("0xmine", address(1))
    release()
    await p.drain({ mine: false })
    expect(p.job(1)?.state).toBe("landed")
    expect(p.prover.sent).toEqual([])
  })

  it("keeps a landing open until its owner has recorded it", async () => {
    const p = page()
    await p.owe(1)
    chain.landed.add(address(1))
    p.prover.failRecords = 1
    await p.drain()
    expect(p.job(1)).toMatchObject({ state: "queued", retryAt: clock + 5_000 })
    expect(p.prover.recorded).toEqual([])
    clock += 5_000
    await p.drain()
    expect(p.job(1)?.state).toBe("landed")
    expect(p.prover.sent).toEqual([])
  })

  it("tells the owner of a pool fill shown while the chain was being asked that it was shown", async () => {
    const p = page()
    await p.owe(1, slot(1, { kind: "pool" }))
    await p.runtime.wake(p.broadcasts.task)
    const txHash = p.job(1)!.txHash!
    chain.state = async () => {
      await p.store.apply(address(1), { type: "shown", at: clock })
      return "included"
    }
    await p.runtime.wake(p.broadcasts.task)
    expect(p.prover.recorded[0]).toMatchObject({ kind: "deposit", shownAt: clock, txHash })
  })

  it("keeps a sent hash when the operation cannot record it", async () => {
    const p = page()
    await p.owe(1)
    const apply = p.operations.apply
    p.operations.apply = async (id, event, w) => {
      if (event.type === "sent") throw new Error("storage full")
      return apply(id, event, w)
    }
    await p.runtime.wake(p.broadcasts.task)
    expect(p.job(1)).toMatchObject({ state: "sent", failures: 0 })
    await p.drain()
    expect(p.prover.sent).toEqual([address(1)])
  })
})
