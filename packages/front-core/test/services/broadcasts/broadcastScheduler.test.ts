import { beforeEach, describe, expect, it } from "vitest"
import {
  BroadcastAbandoned,
  BroadcastDeferred,
  BroadcastLedger,
  BroadcastScheduler,
  BROADCASTS_STORAGE_KEY,
  SENT_POLL_MS,
  type BroadcastExecutor,
  type BroadcastJob,
  type BroadcastTxState,
  type NewBroadcastJob,
} from "../../../src/core/services/broadcasts"
import { OperationStore } from "../../../src/core/services/operations/OperationStore"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"

/** The chain the scheduler reads: every tx the prover sent, and what became of it. */
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
  readonly recorded: string[] = []
  private count = 0
  /** An `Error` fails the build, before any hash; `fail-after-hash` fails once the node may hold it. */
  next?: "hang" | "hang-after-hash" | "fail-after-hash" | Error
  /** Owner writes still to fail. */
  failRecords = 0
  /** Whether the saved hash was readable from storage when `onTxHash` resolved, per send. */
  readonly hashDurable: boolean[] = []
  constructor(private readonly chain: FakeChain) {}
  landed = async (job: BroadcastJob) => this.chain.landed.has(job.address)
  onLanded = (job: BroadcastJob) => {
    if (this.failRecords > 0) {
      this.failRecords--
      throw new Error("storage full")
    }
    // The ledger still reads the job open: the owner records before anything is told it landed.
    this.recordedWhileOpen.push(this.ledger?.get(job.address)?.state !== "landed")
    this.recorded.push(job.address)
    this.recordedJobs.push(job)
  }
  readonly recordedWhileOpen: boolean[] = []
  readonly recordedJobs: BroadcastJob[] = []
  ledger?: BroadcastLedger
  send = async (job: BroadcastJob, attempt: { onTxHash: (txHash: string) => Promise<void> }) => {
    const txHash = `0x${job.address.slice(2, 6)}${++this.count}`
    this.sent.push(job.address)
    const next = this.next
    this.next = undefined
    if (next === "hang") return new Promise<string>(() => {})
    if (next instanceof Error) throw next
    await attempt.onTxHash(txHash)
    const reloaded = new BroadcastLedger(storage)
    await reloaded.load()
    this.hashDurable.push(reloaded.get(job.address)?.txHash === txHash)
    if (next === "hang-after-hash") return new Promise<string>(() => {})
    if (next === "fail-after-hash") throw new Error("timed out waiting for the tx")
    this.chain.txs.set(txHash, "pending")
    return txHash
  }
}

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
const slot = (n: number, over: Partial<NewBroadcastJob> = {}): NewBroadcastJob => ({
  address: address(n),
  kind: "deposit",
  scope: "acct",
  source: { type: "slot", cacheKey: "k", day: 1, nonce: n },
  ...over,
})

let storage: InMemoryStorageAdapter
let chain: FakeChain
let clock: number

/** One page: its own ledger, operation store, prover and scheduler over the shared storage. */
function page(opts: { busy?: () => boolean } = {}) {
  OperationStore.reset()
  const operations = OperationStore.get(storage)
  const ledger = new BroadcastLedger(storage)
  const prover = new FakeProver(chain)
  prover.ledger = ledger
  const scheduler = new BroadcastScheduler({
    ledger,
    operations,
    executors: { slot: prover, registration: prover },
    txState: (txHash) => chain.state(txHash),
    runExclusive: (_job, attempt) => attempt(),
    scope: () => "acct",
    busy: opts.busy,
    describe: (job) =>
      job.kind === "pool" ? undefined : { flow: "deposit", summary: "Deposit address" },
    now: () => clock,
  })
  return { ledger, operations, prover, scheduler }
}

/** Ticks until nothing is due now; the chain includes whatever was sent, if asked to. */
async function drain(p: ReturnType<typeof page>, { mine = true } = {}) {
  for (let i = 0; i < 50; i++) {
    if (mine)
      for (const job of p.ledger.list())
        if (job.state === "sent") chain.include(job.txHash!, job.address)
    const delay = await p.scheduler.tick()
    if (delay !== 0) return delay
  }
  throw new Error("scheduler did not settle")
}

beforeEach(() => {
  storage = new InMemoryStorageAdapter()
  chain = new FakeChain()
  clock = 1_000_000
})

describe("BroadcastScheduler", () => {
  it("sends one broadcast at a time, registration first, then funded, shown and pool", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1, { kind: "pool" }), 1)
    await p.ledger.enqueue(slot(2), 2)
    await p.ledger.enqueue(slot(3, { fundedAt: 3 }), 3)
    await p.ledger.enqueue(
      slot(4, { kind: "registration", source: { type: "registration", account: "0xacc" } }),
      4,
    )

    await p.scheduler.tick()
    expect(p.prover.sent).toEqual([address(4)])
    // Undecided on chain: nothing else is sent over it.
    expect(await p.scheduler.tick()).toBe(SENT_POLL_MS)
    expect(p.prover.sent).toEqual([address(4)])

    expect(await drain(p)).toBeUndefined()
    expect(p.prover.sent).toEqual([address(4), address(3), address(2), address(1)])
    expect(p.ledger.list().every((job) => job.state === "landed")).toBe(true)
  })

  it("holds the leave guard only while this page proves it, and settles the operation on landing", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    p.prover.next = "hang"
    void p.scheduler.tick()
    await new Promise((r) => setTimeout(r, 0))
    const operationId = p.ledger.get(address(1))!.operationId!
    expect(p.operations.get(operationId)).toMatchObject({ state: "local", resumable: true })
    expect(p.operations.isLive(operationId)).toBe(true)

    // The page reloads mid-proof: the boot pass leaves the operation to the scheduler.
    const next = page()
    await next.operations.failInterrupted(clock + 1)
    await next.scheduler.recover()
    expect(next.operations.get(operationId)?.state).toBe("local")
    expect(next.operations.isLive(operationId)).toBe(false)

    await drain(next)
    expect(next.prover.sent).toEqual([address(1)])
    expect(next.operations.get(operationId)?.state).toBe("settled")
    expect(next.ledger.get(address(1))?.state).toBe("landed")
  })

  it("asks the chain about a send cut off after its hash was known, and never proves it twice", async () => {
    const first = page()
    await first.ledger.enqueue(slot(1), 1)
    first.prover.next = "hang-after-hash"
    void first.scheduler.tick()
    await new Promise((r) => setTimeout(r, 0))
    const txHash = first.ledger.get(address(1))!.txHash!
    chain.include(txHash, address(1))

    const next = page()
    await next.scheduler.recover()
    await drain(next, { mine: false })
    expect(next.prover.sent).toEqual([])
    expect(next.ledger.get(address(1))).toMatchObject({ state: "landed", txHash })
  })

  it("tells the owner of every landing, whether it sent it or found it on chain", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    await p.ledger.enqueue(slot(2), 2)
    chain.landed.add(address(2))
    await drain(p)
    expect(p.prover.sent).toEqual([address(1)])
    expect(p.prover.recorded.sort()).toEqual([address(1), address(2)])
    expect(p.prover.recordedWhileOpen).toEqual([true, true])
  })

  it("lets the chain decide a broadcast an earlier page sent before the ledger existed", async () => {
    const p = page()
    await p.ledger.enqueue({ ...slot(1), txHash: "0xold" }, 1)
    chain.txs.set("0xold", "included")
    await drain(p, { mine: false })
    expect(p.prover.sent).toEqual([])
    expect(p.ledger.get(address(1))?.state).toBe("landed")
  })

  it("does not prove a broadcast the chain already has", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    chain.landed.add(address(1))
    await drain(p)
    expect(p.prover.sent).toEqual([])
    expect(p.ledger.get(address(1))?.state).toBe("landed")
  })

  it("sends a dropped broadcast again after its backoff", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    await p.scheduler.tick()
    chain.txs.set(p.ledger.get(address(1))!.txHash!, "dropped")
    const wait = await drain(p, { mine: false })
    expect(wait).toBe(30_000)
    expect(p.prover.sent).toEqual([address(1)])

    clock += wait!
    await drain(p)
    expect(p.prover.sent).toEqual([address(1), address(1)])
    expect(p.ledger.get(address(1))?.state).toBe("landed")
  })

  it("waits out a deferral without counting it, and runs at the time it names", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    for (let i = 0; i < 4; i++) {
      p.prover.next = new BroadcastDeferred(clock + 60_000, "Wallet locked")
      expect(await drain(p)).toBe(60_000)
      clock += 60_000
    }
    expect(p.ledger.get(address(1))).toMatchObject({ failures: 0, state: "queued" })
    await drain(p)
    expect(p.ledger.get(address(1))?.state).toBe("landed")
  })

  it("keeps retrying an address nobody funded, an hour apart at most", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    const waits: (number | undefined)[] = []
    for (let i = 0; i < 6; i++) {
      p.prover.next = new Error("offline")
      const wait = await drain(p)
      waits.push(wait)
      clock += wait!
    }
    expect(waits).toEqual([30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000])
    await drain(p)
    expect(p.prover.sent).toHaveLength(7)
    expect(p.ledger.get(address(1))?.state).toBe("landed")
  })

  it("starts nothing while the user's own transaction runs, and reports pool fills nowhere", async () => {
    let userBusy = true
    const p = page({ busy: () => userBusy })
    await p.ledger.enqueue(slot(1, { kind: "pool" }), 1)
    await p.ledger.enqueue(slot(2), 2)
    expect(await drain(p)).toBeUndefined()
    expect(p.prover.sent).toEqual([])
    userBusy = false
    await drain(p)
    expect(p.prover.sent).toEqual([address(2), address(1)])
    // Nobody saw the pool fill: no operation reports it.
    expect(p.ledger.get(address(1))?.operationId).toBeUndefined()
  })

  it("drops a job whose owner has nothing left to publish, and reports nothing for it", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    await p.ledger.enqueue(slot(2), 2)
    p.prover.next = new BroadcastAbandoned("The registration moved to another address")
    await drain(p)
    expect(p.ledger.get(address(1))).toBeNull()
    expect(p.operations.list().map((op) => op.state)).toEqual(["settled"])
    expect(p.ledger.get(address(2))?.state).toBe("landed")
  })

  it("holds deposits behind a registration no executor can run yet", async () => {
    const p = page()
    await p.ledger.enqueue(
      slot(1, { kind: "registration", source: { type: "registration", account: "0xacc" } }),
      1,
    )
    await p.ledger.enqueue(slot(2), 2)
    const scheduler = new BroadcastScheduler({
      ledger: p.ledger,
      operations: p.operations,
      executors: { slot: p.prover },
      txState: chain.state,
      runExclusive: (_job, attempt) => attempt(),
      scope: () => "acct",
      describe: () => undefined,
      now: () => clock,
    })
    expect(await scheduler.tick()).toBeUndefined()
    expect(p.prover.sent).toEqual([])
  })

  it("saves the hash before the node can take the tx", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    await drain(p)
    expect(p.prover.hashDurable).toEqual([true])
  })

  it("lets the chain decide a send that failed after its hash, instead of proving it again", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    p.prover.next = "fail-after-hash"
    await p.scheduler.tick()
    expect(p.ledger.get(address(1))).toMatchObject({ state: "sent", failures: 0 })
    chain.include(p.ledger.get(address(1))!.txHash!, address(1))
    await drain(p, { mine: false })
    expect(p.prover.sent).toEqual([address(1)])
    expect(p.ledger.get(address(1))?.state).toBe("landed")
  })

  it("keeps a landing open until its owner has recorded it", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    await p.ledger.enqueue(slot(2), 2)
    chain.landed.add(address(2))
    p.prover.failRecords = 2
    expect(await drain(p)).toBe(SENT_POLL_MS)
    expect(p.ledger.get(address(1))?.state).toBe("sent")
    expect(p.prover.recorded).toEqual([])
    // The sent one, then the one found on chain, each asks its owner again.
    for (let wait = await drain(p); wait !== undefined; wait = await drain(p)) clock += wait
    expect(p.ledger.list().map((job) => job.state)).toEqual(["landed", "landed"])
    expect(p.prover.recorded.sort()).toEqual([address(1), address(2)])
    expect(p.prover.sent).toEqual([address(1)])
  })

  it("tells the owner of a pool fill shown while the chain was being asked that it was shown", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1, { kind: "pool" }), 1)
    await p.scheduler.tick()
    const txHash = p.ledger.get(address(1))!.txHash!
    chain.state = async () => {
      await p.ledger.markShown(address(1), clock)
      return "included"
    }
    await p.scheduler.tick()
    expect(p.prover.recordedJobs[0]).toMatchObject({ kind: "deposit", shownAt: clock, txHash })
  })

  it("keeps a sent hash when the operation cannot record it", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    p.operations.markSent = async () => {
      throw new Error("storage full")
    }
    await p.scheduler.tick()
    expect(p.ledger.get(address(1))).toMatchObject({ state: "sent", failures: 0 })
    await drain(p)
    expect(p.prover.sent).toEqual([address(1)])
  })

  it("leaves no operation holding the leave guard when linking it to its job fails", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1), 1)
    const write = storage.setItem.bind(storage)
    let failNext = true
    storage.setItem = async (key, value) => {
      if (failNext && key === BROADCASTS_STORAGE_KEY) {
        failNext = false
        throw new Error("storage full")
      }
      return write(key, value)
    }
    await p.scheduler.tick()
    expect(p.operations.list().filter((op) => p.operations.isLive(op.operationId))).toEqual([])
    clock += (await drain(p))!
    await drain(p)
    expect(p.ledger.get(address(1))?.state).toBe("landed")
  })

  it("runs only the active account's jobs", async () => {
    const p = page()
    await p.ledger.enqueue(slot(1, { scope: "other" }), 1)
    expect(await drain(p)).toBeUndefined()
    expect(p.prover.sent).toEqual([])
  })
})
