import { beforeEach, describe, expect, it } from "vitest"

// jsdom has no Web Locks API — install a minimal FIFO LockManager (Chrome queueing semantics)
// before importing the module under test.
const queues = new Map<string, Promise<unknown>>()
const requestedNames: string[] = []
Object.defineProperty(navigator, "locks", {
  configurable: true,
  value: {
    request: (name: string, cb: () => Promise<unknown>) => {
      requestedNames.push(name)
      const tail = queues.get(name) ?? Promise.resolve()
      const run = tail.then(() => cb())
      queues.set(
        name,
        run.catch(() => undefined),
      )
      return run
    },
  },
})

const { contactsWriteLock, requestsWriteLock } = await import(
  "../src/platform/storage/contactsLock"
)

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("contactsWriteLock", () => {
  beforeEach(() => {
    queues.clear()
    requestedNames.length = 0
  })

  it("serializes overlapping critical sections", async () => {
    const events: string[] = []
    let releaseA!: () => void
    const gate = new Promise<void>((r) => {
      releaseA = r
    })

    const pA = contactsWriteLock(async () => {
      events.push("a-start")
      await gate
      events.push("a-end")
    })
    const pB = contactsWriteLock(async () => {
      events.push("b-start")
      events.push("b-end")
    })

    await tick()
    // B must not enter while A holds the lock.
    expect(events).toEqual(["a-start"])

    releaseA()
    await Promise.all([pA, pB])
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"])
  })

  it("returns the critical section's value and uses the contacts-write lock name", async () => {
    const result = await contactsWriteLock(async () => 42)
    expect(result).toBe(42)
    expect(requestedNames).toEqual(["contacts-write"])
  })

  it("propagates a rejection and releases the lock for the next holder", async () => {
    await expect(
      contactsWriteLock(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    await expect(contactsWriteLock(async () => "after")).resolves.toBe("after")
  })
})

describe("requestsWriteLock", () => {
  beforeEach(() => {
    queues.clear()
    requestedNames.length = 0
  })

  it("uses its own requests-write lock name and serializes overlapping critical sections", async () => {
    const events: string[] = []
    let releaseA!: () => void
    const gate = new Promise<void>((r) => {
      releaseA = r
    })

    const pA = requestsWriteLock(async () => {
      events.push("a-start")
      await gate
      events.push("a-end")
    })
    const pB = requestsWriteLock(async () => {
      events.push("b-start")
    })

    await tick()
    expect(events).toEqual(["a-start"])

    releaseA()
    await Promise.all([pA, pB])
    expect(events).toEqual(["a-start", "a-end", "b-start"])
    expect(requestedNames).toEqual(["requests-write", "requests-write"])
  })
})
