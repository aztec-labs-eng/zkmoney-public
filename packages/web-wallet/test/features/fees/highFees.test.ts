// @vitest-environment node
/** Home's fee reads poll only while a notice subscribes. */
import { describe, expect, it } from "vitest"
import { createPace } from "@obsidion/core/cadence"
import { Network } from "@obsidion/core/constants"
import { fixed, memoryStore, queries } from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"
import { highFees } from "../../../src/features/fees/highFees"
import type { WebWalletConfig } from "../../../src/config/env"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("highFees", () => {
  it("reads the fee cap on each poll while subscribed, and stops when the last subscriber leaves", async () => {
    const pace = createPace({ signalled: true })
    let reads = 0
    const wallet = {
      sponsoredFeesAboveCap: async () => (reads++, true),
    } as unknown as ObsidionWallet
    const fees = highFees(
      queries({ pace, visible: memoryStore(true).readonly, now: () => Date.now() }),
      { network: Network.SANDBOX } as WebWalletConfig,
      fixed("wallet", wallet),
    )
    const cap = fees.aboveCap
    const off = cap.subscribe(() => {})
    await settle()
    pace.wake()
    await settle()
    expect([reads, cap.get()]).toEqual([2, { status: "ready", value: true, refreshing: false }])

    off()
    pace.wake()
    await settle()
    expect(reads).toBe(2)
    expect(fees.gasPrice.get()).toEqual({ status: "pending" })
  })
})
