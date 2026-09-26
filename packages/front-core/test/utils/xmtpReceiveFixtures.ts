import type { TokenTransaction } from "../../src/types/transactions"
import type { NewIncomingTokenTx } from "../../src/xmtp/receiverTypes"

export interface FakeScheduler {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
  advance: (ms: number) => Promise<void>
  pendingCount: () => number
  now: () => number
}

export function makeScheduler(initialNow = 0): FakeScheduler {
  let now = initialNow
  const handles = new Map<number, { fireAt: number; cb: () => void }>()
  let nextId = 1
  return {
    setTimeout(cb, ms) {
      const id = nextId++
      handles.set(id, { fireAt: now + ms, cb })
      return id
    },
    clearTimeout(h) {
      handles.delete(h as number)
    },
    async advance(ms: number) {
      now += ms
      let progressed = true
      while (progressed) {
        progressed = false
        const due = [...handles.entries()]
          .filter(([, h]) => h.fireAt <= now)
          .sort(([, a], [, b]) => a.fireAt - b.fireAt)
        for (const [id, h] of due) {
          if (!handles.has(id)) continue
          handles.delete(id)
          h.cb()
          progressed = true
          await Promise.resolve()
          await Promise.resolve()
        }
      }
    },
    pendingCount: () => handles.size,
    now: () => now,
  }
}

export function fakeIncomingTokenTx(input: NewIncomingTokenTx): TokenTransaction {
  return {
    txHash: input.txHash,
    timestamp: input.timestamp,
    status: "success",
    action: input.action ?? "receive",
    token: input.token,
    from: input.from,
    senderL2Address: input.senderL2Address,
    to: input.to,
    memo: input.memo,
  } as unknown as TokenTransaction
}
