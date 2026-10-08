import { describe, it, expect, afterEach } from "vitest"

import type { ConfirmationOutcome, TokenTransaction } from "../../../src/index.js"
import type { IStorageAdapter } from "../../../src/index.js"

import { ReorgNotificationProducer, reorgNotificationInput } from "../../../src/index.js"
import { AppNotificationStore, type AppNotificationEntry } from "../../../src/index.js"

class InMemoryStorage implements IStorageAdapter {
  store = new Map<string, string>()
  async getItem(key: string) {
    return this.store.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.store.set(key, value)
  }
  async removeItem(key: string) {
    this.store.delete(key)
  }
  async clear() {
    this.store.clear()
  }
}

const NOW = 1_700_000_100_000
const TX = "0xAbC1"

function sendRow(overrides: Partial<TokenTransaction> = {}): TokenTransaction {
  return {
    action: "send",
    token: {
      name: "Obsidion DAI",
      symbol: "DAI",
      decimals: 6,
      logo: "x",
      price: 1,
      address: "0xtoken",
      amount: 5,
    },
    timestamp: 1_700_000_000_000,
    status: "failed",
    txHash: TX,
    to: "alice",
    ...overrides,
  } as TokenTransaction
}

afterEach(() => {
  ReorgNotificationProducer.resetForTests()
})

describe("reorgNotificationInput", () => {
  it("tells the recipient of a failed payment it was a payment to them", () => {
    for (const type of ["failed", "grace-expired"] as const) {
      expect(reorgNotificationInput({ type, txHash: TX, incoming: true }, NOW)?.description).toBe(
        "This payment to you was reverted by the network and did not complete",
      )
      expect(reorgNotificationInput({ type, txHash: TX }, NOW)?.description).toBe(
        "Your transaction was reverted by the network and did not complete",
      )
    }
  })

  it("maps failed and grace-expired to the same payment-failed id (one alert per episode)", () => {
    const failed = reorgNotificationInput({ type: "failed", txHash: TX }, NOW)
    const expired = reorgNotificationInput({ type: "grace-expired", txHash: TX }, NOW)
    expect(failed?.id).toBe("reorg:failed:0xabc1:0")
    expect(expired?.id).toBe("reorg:failed:0xabc1:0")
    expect(failed?.severity).toBe("error")
    expect(failed?.target).toEqual({ type: "reorg.txDetail", txHash: TX })
  })

  it("stays silent on a withdrawal's failed burn (the bridge producer reports it)", () => {
    expect(
      reorgNotificationInput(
        { type: "failed", txHash: TX, reorgEpoch: 1, source: "withdrawal" },
        NOW,
      ),
    ).toBeNull()
  })

  it("keys failure and corrective ids by reorgEpoch", () => {
    expect(reorgNotificationInput({ type: "failed", txHash: TX, reorgEpoch: 2 }, NOW)?.id).toBe(
      "reorg:failed:0xabc1:2",
    )
    expect(
      reorgNotificationInput(
        { type: "re-confirmed", txHash: TX, hadAlerted: true, reorgEpoch: 2 },
        NOW,
      )?.id,
    ).toBe("reorg:reconfirmed:0xabc1:2")
  })

  it("maps re-confirmed to a corrective notice only when an alert had fired", () => {
    expect(
      reorgNotificationInput({ type: "re-confirmed", txHash: TX, hadAlerted: false }, NOW),
    ).toBeNull()
    const corrective = reorgNotificationInput(
      { type: "re-confirmed", txHash: TX, hadAlerted: true },
      NOW,
    )
    expect(corrective?.id).toBe("reorg:reconfirmed:0xabc1:0")
    expect(corrective?.severity).toBe("success")
  })

  it('a recovered withdrawal is announced as "Withdrawal resumed"', () => {
    const recovered = { type: "re-confirmed", txHash: TX, hadAlerted: true } as const
    expect(reorgNotificationInput({ ...recovered, source: "withdrawal" }, NOW)).toMatchObject({
      id: "reorg:reconfirmed:0xabc1:0",
      title: "Withdrawal resumed",
      description: "A withdrawal we reported as failed is on its way again",
    })
    expect(reorgNotificationInput(recovered, NOW)?.title).toBe("Payment confirmed")
  })

  it("maps exit-required to a withdrawal-routed notice, never retry-framed", () => {
    const exit = reorgNotificationInput({ type: "exit-required", txHash: TX }, NOW)
    expect(exit?.id).toBe("reorg:exit:0xabc1")
    expect(exit?.description).toContain("withdrawal")
    expect(exit?.description).not.toMatch(/retry|try again/i)
  })

  it("is silent for demoted and finalized", () => {
    expect(reorgNotificationInput({ type: "demoted", txHash: TX }, NOW)).toBeNull()
    expect(reorgNotificationInput({ type: "finalized", txHash: TX }, NOW)).toBeNull()
  })
})

describe("ReorgNotificationProducer", () => {
  it("mints one payment-failed notification and dedups replays across restarts", async () => {
    const storage = new InMemoryStorage()
    const store = new AppNotificationStore(storage)
    const producer = new ReorgNotificationProducer({ notificationStore: store, now: () => NOW })
    producer.handleOutcome({ type: "failed", txHash: TX })
    producer.handleOutcome({ type: "grace-expired", txHash: TX })
    await producer.flush()
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].title).toBe("Payment failed")

    // Restart: a fresh store over the same persisted storage replays the outcome.
    const restarted = new AppNotificationStore(storage)
    const producer2 = new ReorgNotificationProducer({
      notificationStore: restarted,
      now: () => NOW,
    })
    producer2.handleOutcome({ type: "failed", txHash: TX })
    await producer2.flush()
    expect(restarted.list()).toHaveLength(1)
  })

  it("a second episode (higher reorgEpoch) mints a fresh alert; same-episode replays still dedupe", async () => {
    const store = new AppNotificationStore(new InMemoryStorage())
    const producer = new ReorgNotificationProducer({ notificationStore: store, now: () => NOW })
    producer.handleOutcome({ type: "failed", txHash: TX })
    producer.handleOutcome({ type: "grace-expired", txHash: TX }) // same episode: deduped
    producer.handleOutcome({ type: "failed", txHash: TX, reorgEpoch: 1 })
    producer.handleOutcome({ type: "re-confirmed", txHash: TX, hadAlerted: true, reorgEpoch: 1 })
    await producer.flush()
    const ids = store.list().map((n) => n.id)
    expect(ids).toHaveLength(3)
    expect(ids).toEqual(
      expect.arrayContaining([
        "reorg:failed:0xabc1:0",
        "reorg:failed:0xabc1:1",
        "reorg:reconfirmed:0xabc1:1",
      ]),
    )
  })

  it("failed then re-confirmed yields alert plus corrective notice", async () => {
    const store = new AppNotificationStore(new InMemoryStorage())
    const producer = new ReorgNotificationProducer({ notificationStore: store, now: () => NOW })
    producer.handleOutcome({ type: "failed", txHash: TX })
    producer.handleOutcome({ type: "re-confirmed", txHash: TX, hadAlerted: true })
    await producer.flush()
    const ids = store.list().map((n) => n.id)
    expect(ids).toContain("reorg:failed:0xabc1:0")
    expect(ids).toContain("reorg:reconfirmed:0xabc1:0")
  })

  it("demote then quiet re-confirm within grace mints nothing", async () => {
    const store = new AppNotificationStore(new InMemoryStorage())
    const producer = new ReorgNotificationProducer({ notificationStore: store, now: () => NOW })
    producer.handleOutcome({ type: "demoted", txHash: TX })
    producer.handleOutcome({ type: "re-confirmed", txHash: TX, hadAlerted: false })
    await producer.flush()
    expect(store.list()).toHaveLength(0)
  })

  it("start subscribes to the outcome source; stop unsubscribes", async () => {
    const store = new AppNotificationStore(new InMemoryStorage())
    const sub: { listener: ((o: ConfirmationOutcome) => void) | null } = { listener: null }
    const producer = new ReorgNotificationProducer({
      notificationStore: store,
      now: () => NOW,
      subscribeToOutcomes: (l) => {
        sub.listener = l
        return () => {
          sub.listener = null
        }
      },
    })
    producer.start()
    sub.listener?.({ type: "failed", txHash: TX })
    await producer.flush()
    expect(store.list()).toHaveLength(1)
    producer.stop()
    expect(sub.listener).toBeNull()
  })
})
