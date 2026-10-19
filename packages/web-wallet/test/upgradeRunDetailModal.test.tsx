import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import type { SIPADepositRecord, UpgradeBatchItem } from "@obsidion/front-core"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const { UpgradeRunDetailModal } = await import("../src/ui/screens/UpgradeRunDetailModal")
const { upgradeRunsOf } = await import("../src/ui/screens/upgradeRuns")

const batch = (id: string, recipient: string, state: UpgradeBatchItem["state"]) => ({
  kind: "upgrade.batch" as const,
  batch: {
    run: "run",
    id,
    first: id === "proof",
    recipient,
    amount: (10n * 10n ** 18n).toString(),
    exitFee: (10n ** 17n).toString(),
    state,
    startTime: 1_000,
  },
})
const arrival = {
  kind: "bridge.sipaDeposit" as const,
  record: {
    sipaAddress: "0xA1",
    phase: "claimed",
    amount: "9.9",
    netAmount: (99n * 10n ** 17n).toString(),
    tokenSymbol: "DAI",
    startTime: 1_100,
    endTime: 1_200,
  } as unknown as SIPADepositRecord,
}

describe("an upgrade's sheet", () => {
  it("lists every batch in order, each opening its own detail", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const [run] = upgradeRunsOf([
      batch("remaining-1", "0xb2", "sent"),
      batch("proof", "0xa1", "received"),
      arrival,
    ])
    const onViewLeg = vi.fn()
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () =>
      root.render(<UpgradeRunDetailModal run={run!} onViewLeg={onViewLeg} onClose={() => {}} />),
    )
    const text = document.body.textContent ?? ""
    expect(text).toContain("+$19.80")
    expect(text).toContain("1 of 2 transfers arrived")
    const legs = [...document.querySelectorAll('[data-testid="upgrade-legs"] button')]
    expect(legs.map((leg) => leg.textContent)).toEqual([
      "Transfer 1$9.90 Completed",
      "Transfer 2$9.90 Leaving old version",
    ])
    await act(async () => (legs[0] as HTMLButtonElement).click())
    expect(onViewLeg).toHaveBeenCalledWith(expect.objectContaining({ arrival: arrival.record }))
    await act(async () => root.unmount())
    container.remove()
  })
})
