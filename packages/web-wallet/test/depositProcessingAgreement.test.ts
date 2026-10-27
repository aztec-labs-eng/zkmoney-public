/**
 * The activity row, the deposit sheets and the bell's live row name a waiting deposit's reason in one vocabulary and
 * on one clock. The same feed item drives the real notification producer and the row helper here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AppNotificationStore,
  BridgeNotificationProducer,
  SIPA_PROCESSING_COPY,
  sipaReasonShown,
  STUCK_SWEEP_MS,
  type ActivityItem,
  type IStorageAdapter,
  type SIPADepositRecord,
  type SipaProcessingState,
} from "@obsidion/front-core"
import { depositRowSubline, STUCK_SUBLINE } from "../src/ui/screens/activityView"
import { processingCopy } from "../src/features/deposit/processingCopy"

const NOW = 1_800_000_000_000
const AT = NOW - 1_000

class MemoryAdapter implements IStorageAdapter {
  private data = new Map<string, string>()
  async getItem(key: string) {
    return this.data.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.data.set(key, value)
  }
  async removeItem(key: string) {
    this.data.delete(key)
  }
  async clear() {
    this.data.clear()
  }
}

const states: Record<SipaProcessingState["reason"]["kind"], SipaProcessingState> = {
  "capacity": {
    reason: {
      kind: "capacity",
      requiredAtomic: 2n,
      availableAtomic: 1n,
      refill: { status: "unknown" },
      decimals: 18,
      observedAt: AT,
    },
    blocker: { kind: "capacity", observedAt: AT },
  },
  "ceiling": {
    reason: {
      kind: "ceiling",
      requiredAtomic: 2n,
      ceilingAtomic: 1n,
      decimals: 18,
      observedAt: AT,
    },
    blocker: { kind: "ceiling", observedAt: AT },
  },
  "operation-cap": {
    reason: { kind: "operation-cap", observedAt: AT },
    blocker: { kind: "operation-cap", observedAt: AT },
  },
  "processing": {
    reason: { kind: "processing", availableAtomic: 1n, decimals: 18, observedAt: AT },
  },
  "checking": { reason: { kind: "checking" } },
  "unavailable": {
    reason: {
      kind: "unavailable",
      cause: "amount-unknown",
      availableAtomic: 50_000n,
      decimals: 18,
      observedAt: AT,
    },
  },
}

const deposit = (startTime: number): SIPADepositRecord =>
  ({
    sipaAddress: "0x00000000000000000000000000000000000000aa",
    recipientL2Address: "0x" + "11".repeat(32),
    messageSecret: "0x" + "22".repeat(32),
    recipientHash: "0x" + "33".repeat(32),
    recoveryAddress: "0x0000000000000000000000000000000000000009",
    l1ChainId: 1,
    amount: "100",
    tokenSymbol: "USDC",
    phase: "sweeping",
    startTime,
  } as SIPADepositRecord)

const FRESH = deposit(NOW - 20_000)
const STUCK = deposit(NOW - STUCK_SWEEP_MS)

describe("a waiting deposit's reason", () => {
  let producer: BridgeNotificationProducer
  let notifications: AppNotificationStore
  let emit: (items: ActivityItem[]) => void

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    let listener: ((items: ActivityItem[]) => void) | undefined
    let items: ActivityItem[] = []
    const feed = {
      list: () => items,
      onChanged: (fn: (next: ActivityItem[]) => void) => {
        listener = fn
        return () => (listener = undefined)
      },
    }
    emit = (next) => {
      items = next
      listener?.(next)
    }
    notifications = new AppNotificationStore(new MemoryAdapter())
    producer = new BridgeNotificationProducer(feed, notifications, { liveRows: true })
    producer.start()
  })

  afterEach(() => {
    producer.stop()
    vi.useRealTimers()
  })

  const bell = async (record: SIPADepositRecord, processing: SipaProcessingState) => {
    emit([{ kind: "bridge.sipaDeposit", record, processing }])
    await producer.flush()
    return notifications.list().find((n) => n.pending && !n.dismissedAt)?.description
  }

  it("reads the same on the row, the sheet and the bell once stated", async () => {
    for (const [kind, state] of Object.entries(states).filter(([kind]) => kind !== "unavailable")) {
      const copy = SIPA_PROCESSING_COPY[kind as keyof typeof states]
      expect(depositRowSubline(state, STUCK, true)).toBe(copy.short)
      expect(sipaReasonShown(state, STUCK)).toBe(true)
      expect(processingCopy(state, "DAI").headline).toBe(copy.headline)
      expect(await bell(STUCK, state)).toBe(`$100 · ${copy.short}`)
    }
  })

  it("states a blocker at once on every surface", async () => {
    for (const kind of ["capacity", "ceiling", "operation-cap"] as const) {
      expect(depositRowSubline(states[kind], FRESH, false)).toBe(SIPA_PROCESSING_COPY[kind].short)
      expect(sipaReasonShown(states[kind], FRESH)).toBe(true)
      expect(await bell(FRESH, states[kind])).toBe(`$100 · ${SIPA_PROCESSING_COPY[kind].short}`)
    }
  })

  it("labels no fresh healthy deposit as delayed on any surface", async () => {
    for (const kind of ["processing", "checking", "unavailable"] as const) {
      expect(depositRowSubline(states[kind], FRESH, false)).toBeUndefined()
      expect(sipaReasonShown(states[kind], FRESH)).toBe(false)
      expect(await bell(FRESH, states[kind])).toBe("$100 · Receiving")
    }
  })

  it("keeps the stuck wording where no reason is known", () => {
    expect(depositRowSubline(undefined, STUCK, true)).toBe(STUCK_SUBLINE)
    expect(depositRowSubline(undefined, FRESH, false)).toBeUndefined()
    expect(depositRowSubline(states.unavailable, STUCK, true)).toBe(STUCK_SUBLINE)
  })

  it("keeps the phase wording on the bell for an unavailable reason", async () => {
    expect(await bell(STUCK, states.unavailable)).toBe("$100 · Receiving")
  })
})
