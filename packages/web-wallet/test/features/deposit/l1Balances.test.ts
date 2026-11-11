// @vitest-environment node
/** The deposit form's L1 balance polls only while subscribed and the page shows. */
import { describe, expect, it } from "vitest"
import { createPace } from "@obsidion/core/cadence"
import { memoryStore, queries } from "@obsidion/front-core"
import type { L1TokenBalance } from "../../../src/features/deposit/l1DepositTokenBalance"
import { l1Balances } from "../../../src/features/deposit/l1Balances"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const holds = (raw: bigint) => ({ raw } as L1TokenBalance)

function setup() {
  const pace = createPace({ signalled: true })
  const visible = memoryStore(true)
  const reads: bigint[] = []
  const balance = l1Balances(
    queries({ pace, visible: visible.readonly, now: () => Date.now() }),
    async () => {
      reads.push(BigInt(reads.length))
      return holds(BigInt(reads.length - 1))
    },
  )("0x1", undefined)
  return { pace, visible, reads, balance }
}

describe("l1Balances", () => {
  it("reads the balance on each poll while subscribed, and stops when the last subscriber leaves", async () => {
    const { pace, reads, balance } = setup()
    const off = balance.subscribe(() => {})
    await settle()
    pace.wake()
    await settle()
    expect(reads).toHaveLength(2)
    expect(balance.get()).toMatchObject({ status: "ready", value: { raw: 1n } })

    off()
    pace.wake()
    await settle()
    expect(reads).toHaveLength(2)
  })

  it("reads nothing while the page is hidden, and reads at once when it shows", async () => {
    const { pace, visible, reads, balance } = setup()
    const off = balance.subscribe(() => {})
    await settle()
    visible.set(false)
    pace.wake()
    await settle()
    expect(reads).toHaveLength(1)

    visible.set(true)
    await settle()
    expect(reads).toHaveLength(2)
    off()
  })
})
