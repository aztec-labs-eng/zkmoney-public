import { vi } from "vitest"
import type { Address } from "viem"
import { liveStore, memoryStore, type Task } from "@obsidion/front-core"
import { openTestSession } from "./session"
import { patchSipaDeposit, seedSipaDeposit, testSipaDeposits } from "./sipaDeposits"

/** The check task's pace while a screen shows an address. */
const CHECK_MS = 4_000

/**
 * Stands in for the session's check task: each pass writes what `held` answers, in fee-token
 * units, onto the record of each address `addresses` names. A pass that sees nothing new writes
 * nothing, as the task's does. A subscriber to `observedAt` runs a pass at once, then on the check
 * pace. Call it once the test session is open.
 */
export function provideFakeDepositRail(opts: {
  addresses: () => readonly (string | undefined)[]
  held: (address: Address) => bigint | Promise<bigint>
  token?: (address: Address) => Address | undefined
}) {
  const open = openTestSession()
  const observedAt = memoryStore<number | undefined>(undefined)
  const check = vi.fn(async () => {
    for (const address of opts.addresses()) {
      if (!address) continue
      const balance = await opts.held(address as Address)
      const stored = await testSipaDeposits().get(address)
      if (stored?.observedFrom && stored.heldBalance === balance.toString()) continue
      const token = opts.token?.(address as Address)
      const seen = {
        observedFrom: "1",
        heldBalance: balance.toString(),
        ...(balance > 0n && token ? { tokenAddress: token } : {}),
      }
      if (stored) await patchSipaDeposit(address, seen)
      else
        await seedSipaDeposit({
          sipaAddress: address as Address,
          phase: "resolved",
          networkId: "0xnet",
          amount: "0",
          startTime: Date.now(),
          ...seen,
        } as never)
    }
    observedAt.set(Date.now())
  })
  const task = { name: "sipaCheck" } as unknown as Task
  const wake = open.wake
  const define = (name: string, value: unknown) =>
    Object.defineProperty(open, name, { configurable: true, value })
  define("tasks", { ...open.tasks, sipaCheck: task })
  define("wake", (target: Task) => (target === task ? check() : wake(target)))
  define("sipaPipeline", {
    observedAt: liveStore(observedAt.get(), {
      whileSubscribed(set) {
        const off = observedAt.subscribe(() => set(observedAt.get()))
        void check()
        const timer = setInterval(() => void check(), CHECK_MS)
        return () => {
          off()
          clearInterval(timer)
        }
      },
    }),
  })
  return check
}
