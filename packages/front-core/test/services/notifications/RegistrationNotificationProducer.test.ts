import { afterEach, describe, it, expect, beforeEach, vi } from "vitest"

import {
  AppNotificationStore,
  RegistrationNotificationProducer,
  STUCK_SWEEP_MS,
  type FundingBurn,
  type PendingRegistrationRecord,
  type SIPADepositRecord,
  type SipaProcessingSource,
  type SipaProcessingState,
} from "../../../src/index.js"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import {
  REG,
  fundingBurn,
  pendingRegistration as record,
  sipaDeposit,
} from "../../__test-helpers__/registrationFixtures"

const TERMINAL_ID = `registration:${REG.account}:${REG.nameHash}`
const LIVE_ID = `${TERMINAL_ID}:live`

function harness(processing?: SipaProcessingSource) {
  const notificationStore = new AppNotificationStore(new InMemoryStorageAdapter())
  let records: PendingRegistrationRecord[] = []
  let deposit: SIPADepositRecord | null = null
  let burns: FundingBurn[] = []
  const listeners: Array<() => void> = []
  const subscribe = (fn: () => void) => {
    listeners.push(fn)
    return () => {}
  }
  const producer = RegistrationNotificationProducer.getOrCreate({
    notificationStore,
    pendingStore: { list: () => records, onListChanged: subscribe } as never,
    sipaStore: { get: () => deposit, onListChanged: subscribe } as never,
    withdrawalStore: { list: () => burns, onListChanged: subscribe } as never,
    currentAccount: () => REG.l2Address,
    processing,
  })
  const set = async (
    r: PendingRegistrationRecord | null,
    over?: Partial<SIPADepositRecord>,
    burning: FundingBurn[] = [],
  ) => {
    records = r ? [r] : []
    deposit = over ? sipaDeposit(over) : null
    burns = burning
    for (const fn of listeners) fn()
    await producer.flush()
  }
  return { notificationStore, producer, set }
}

describe("RegistrationNotificationProducer", () => {
  beforeEach(() => {
    RegistrationNotificationProducer.resetForTests()
  })

  it("stays quiet while the deposit is still owed", async () => {
    const h = harness()
    h.producer.start()
    await h.producer.flush()
    await h.set(record())
    expect(h.notificationStore.list()).toHaveLength(0)
  })

  // A cancelled passkey removes the burn's record; a failed burn stays listed.
  it.each([
    ["cancelled", []],
    ["failed", [fundingBurn({ phase: "failed" })]],
  ])("drops the funding row once its burn is %s", async (_, after) => {
    const h = harness()
    h.producer.start()
    const open = () => h.notificationStore.list().filter((n) => !n.dismissedAt)
    await h.set(record(), undefined, [fundingBurn({ phase: "submitting" })])
    expect(open().map((n) => n.title)).toEqual(["Claiming your tag"])

    await h.set(record(), undefined, after)
    expect(open()).toHaveLength(0)
  })

  it("carries one live row through the in-flight stages, then settles at registered", async () => {
    const h = harness()
    h.producer.start()

    await h.set(record(), undefined, [fundingBurn()])
    let live = h.notificationStore.list()
    // The funding burn is the registration's own progress, not a withdrawal.
    expect(live).toMatchObject([
      { id: LIVE_ID, producer: "registration", title: "Claiming your tag", pending: true },
    ])

    // The rail sees the funds before the record is stamped.
    await h.set(record(), { phase: "funded" }, [fundingBurn({ phase: "done" })])
    expect(h.notificationStore.list()).toMatchObject([
      { id: LIVE_ID, title: "Deposit received", pending: true },
    ])

    await h.set(record({ fundedAt: 1 }), undefined, [fundingBurn({ phase: "done" })])
    live = h.notificationStore.list()
    // Same row, updated in place — no second entry minted.
    expect(live).toHaveLength(1)
    expect(live[0].title).toBe("Deposit received")
    expect(live[0].pending).toBe(true)
    expect(live[0].target).toEqual({ type: "registration.pending", tag: "alice" })

    await h.set(record({ fundedAt: 1, sweptAt: 2 }), { phase: "pendingClaim" })
    live = h.notificationStore.list()
    expect(live).toHaveLength(1)
    expect(live[0].title).toBe("Crediting your balance")
    expect(live[0].pending).toBe(true)

    await h.set(record({ fundedAt: 1, sweptAt: 2, phase: "confirmed", endTime: 3 }))
    const entries = h.notificationStore.list()
    const registered = entries.find((e) => e.id === TERMINAL_ID)
    expect(registered).toBeDefined()
    expect(registered!.title).toBe("@alice is registered")
    expect(registered!.severity).toBe("success")
    expect(registered!.pending).toBeFalsy()
    // Nothing is left to claim: the settled row opens the deposit's detail, not the claim wizard.
    expect(registered!.target).toEqual({
      type: "bridge.txDetail",
      bridgeKind: "deposit",
      sourceId: REG.sipaAddress,
    })
    // The live row is retired, so the bell shows only the settled outcome.
    expect(entries.some((e) => e.id === LIVE_ID && !e.dismissedAt)).toBe(false)
  })

  it("retargets a stored registered row that still leads to the claim, keeping its state", async () => {
    const h = harness()
    // A success row written when the terminal still pointed at the claim wizard.
    await h.notificationStore.createIfAbsent({
      id: TERMINAL_ID,
      producer: "registration",
      domain: "registration",
      sourceId: REG.sipaAddress,
      title: "@alice is registered",
      description: "Your tag is ready to use",
      timestampMs: 3,
      systemIcon: "checkmark.circle",
      severity: "success",
      target: { type: "registration.pending", tag: "alice" },
      read: true,
      readAt: 5,
    })
    await h.notificationStore.dismiss(TERMINAL_ID, 7)
    h.producer.start()
    await h.set(record({ fundedAt: 1, sweptAt: 2, phase: "confirmed", endTime: 3 }))
    const rows = h.notificationStore.list().filter((e) => e.id === TERMINAL_ID)
    expect(rows).toHaveLength(1)
    expect(rows[0].target).toEqual({
      type: "bridge.txDetail",
      bridgeKind: "deposit",
      sourceId: REG.sipaAddress,
    })
    expect(rows[0]).toMatchObject({ read: true, readAt: 5, dismissedAt: 7 })
  })

  it("gives a second name on the same account its own terminal, not the first's", async () => {
    const h = harness()
    h.producer.start()
    // The first name loses the race and settles failed.
    await h.set(record({ phase: "failed_taken", endTime: 1 }))
    // A retry on a different name (same predicted account) registers.
    const bobHash = `0x${"88".repeat(32)}` as const
    await h.set(
      record({
        tag: "bob",
        nameHash: bobHash,
        fundedAt: 1,
        sweptAt: 2,
        phase: "confirmed",
        endTime: 3,
      }),
    )
    const entries = h.notificationStore.list()
    const success = entries.find((e) => e.id === `registration:${REG.account}:${bobHash}`)
    expect(success?.title).toBe("@bob is registered")
    expect(success?.severity).toBe("success")
    // The earlier failure kept its own row rather than being adopted by the success.
    const failed = entries.find((e) => e.id === TERMINAL_ID)
    expect(failed?.severity).toBe("error")
    // A failure still leads back to the claim.
    expect(failed?.target).toEqual({ type: "registration.pending", tag: "alice" })
  })

  describe("with the deposit's processing reason", () => {
    const blocked: SipaProcessingState = {
      reason: {
        kind: "capacity",
        requiredAtomic: 5n,
        availableAtomic: 1n,
        refill: { status: "unknown" },
        decimals: 18,
        observedAt: 1,
      },
      blocker: { kind: "capacity", observedAt: 1 },
    }
    let state: SipaProcessingState | undefined
    let notify = () => {}
    const source: SipaProcessingSource = {
      stateFor: () => state,
      subscribe: (listener) => {
        notify = listener
        return () => {}
      },
    }
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(1_800_000_000_000)
      state = undefined
    })
    afterEach(() => vi.useRealTimers())

    // Received (rail still `broadcast`) and sweeping both state the reason before the sweep.
    it.each([
      ["broadcast", { title: "Deposit received", description: "Securing @alice" }],
      ["sweeping", { title: "Sweeping deposit", description: "Moving your funds into the pool" }],
    ] as const)(
      "states a blocker on the one live row, and drops it once cleared (%s)",
      async (phase, cleared) => {
        const h = harness(source)
        h.producer.start()
        state = blocked
        await h.set(record({ fundedAt: 1 }), { phase, startTime: Date.now() })
        expect(h.notificationStore.list()).toMatchObject([
          {
            id: LIVE_ID,
            title: "Deposit received",
            description: "Waiting for capacity",
            pending: true,
          },
        ])

        state = {
          reason: { kind: "processing", availableAtomic: 9n, decimals: 18, observedAt: 2 },
        }
        notify()
        await h.producer.flush()
        expect(h.notificationStore.list()).toMatchObject([{ id: LIVE_ID, ...cleared }])
      },
    )

    it("keeps the stage copy with no processing source", async () => {
      const h = harness()
      h.producer.start()
      await h.set(record({ fundedAt: 1 }), { phase: "sweeping", startTime: Date.now() })
      expect(h.notificationStore.list()).toMatchObject([
        { title: "Sweeping deposit", description: "Moving your funds into the pool" },
      ])
    })

    it("states a waiting reason once the stuck clock runs out, with no store change", async () => {
      const h = harness(source)
      h.producer.start()
      state = { reason: { kind: "checking" } }
      await h.set(record({ fundedAt: 1 }), { phase: "sweeping", startTime: Date.now() })
      expect(h.notificationStore.list()[0].description).toBe("Moving your funds into the pool")

      await vi.advanceTimersByTimeAsync(STUCK_SWEEP_MS)
      await h.producer.flush()
      expect(h.notificationStore.list()).toMatchObject([
        { id: LIVE_ID, title: "Deposit received", description: "Checking status" },
      ])
    })

    it("arms no wake from a pass queued before stop(), so nothing writes after it", async () => {
      const h = harness(source)
      state = { reason: { kind: "unavailable", cause: "capacity-unread" } }
      await h.set(record({ fundedAt: 1 }), { phase: "sweeping", startTime: Date.now() })
      h.producer.start()
      h.producer.stop()
      await h.producer.flush()
      expect(vi.getTimerCount()).toBe(0)
      const row = h.notificationStore.list()[0]
      await vi.advanceTimersByTimeAsync(STUCK_SWEEP_MS)
      expect(h.notificationStore.list()).toEqual([row])
    })

    it("leaves no wake once the registration moves past the sweep", async () => {
      const h = harness(source)
      h.producer.start()
      state = { reason: { kind: "unavailable", cause: "capacity-unread" } }
      await h.set(record({ fundedAt: 1 }), { phase: "sweeping", startTime: Date.now() })
      expect(vi.getTimerCount()).toBe(1)
      await h.set(record({ fundedAt: 1, sweptAt: 2 }), { phase: "sweeping", startTime: Date.now() })
      expect(vi.getTimerCount()).toBe(0)
    })

    it("names no reason once the sweep that registers the name is known", async () => {
      const h = harness(source)
      h.producer.start()
      state = blocked
      await h.set(record({ fundedAt: 1, sweptAt: 2 }), { phase: "sweeping", startTime: 1 })
      expect(h.notificationStore.list()).toMatchObject([{ title: "Claiming @alice" }])
    })
  })

  it("only carries the active wallet's registration", async () => {
    const h = harness()
    h.producer.start()
    await h.set(record({ l2Address: `0x${"ee".repeat(32)}`, fundedAt: 1 }))
    expect(h.notificationStore.list()).toHaveLength(0)
  })
})
