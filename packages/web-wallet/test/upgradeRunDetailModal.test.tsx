import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import type { SIPADepositRecord, UpgradeBatchItem } from "@obsidion/front-core"
import { statusBadgeStyle } from "@obsidion/web-ds"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const { UpgradeRunDetailModal, legStatus } = await import("../src/ui/screens/UpgradeRunDetailModal")
const { upgradeRowStatusLabel } = await import("../src/ui/screens/activityView")
const { upgradeRunsOf } = await import("@obsidion/front-core")

const batch = (
  id: string,
  recipient: string,
  state: UpgradeBatchItem["state"],
  approved = true,
) => ({
  kind: "upgrade.batch" as const,
  batch: {
    run: "run",
    id,
    first: id === "proof",
    recipient,
    amount: (10n * 10n ** 18n).toString(),
    exitFee: (10n ** 17n).toString(),
    state,
    approved,
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
      "Transfer 2$9.90 Releasing",
    ])
    await act(async () => (legs[0] as HTMLButtonElement).click())
    expect(onViewLeg).toHaveBeenCalledWith(expect.objectContaining({ arrival: arrival.record }))
    await act(async () => root.unmount())
    container.remove()
  })
})

describe("an upgrade's steps", () => {
  const legOf = (state: UpgradeBatchItem["state"], approved = true) =>
    upgradeRunsOf([
      batch("proof", "0xa1", "sent"),
      batch("remaining-0", "0xb2", state, approved),
    ])[0]!.legs[1]!

  it("waits for approval until the user approves a planned batch", () => {
    expect(legStatus(legOf("planned", false)).label).toBe("Waiting for approval")
    expect(legStatus(legOf("planned")).label).toBe("Approved")
    expect(legStatus(legOf("sent")).label).toBe("Releasing")
  })

  it("draws a badge for every step the row can name", () => {
    for (const approved of [false, true]) {
      const run = upgradeRunsOf([
        batch("remaining-0", "0xb2", "planned", approved),
        batch("proof", "0xa1", "sent"),
      ])[0]!
      expect(statusBadgeStyle(upgradeRowStatusLabel(run)!), String(approved)).toBe("pending")
    }
    for (const phase of ["funded", "pendingClaim", "recoverable"] as const) {
      const run = upgradeRunsOf([
        batch("proof", "0xa1", "received"),
        { ...arrival, record: { ...arrival.record, phase, endTime: undefined } },
      ])[0]!
      expect(statusBadgeStyle(upgradeRowStatusLabel(run)!), phase).toBeDefined()
    }
  })
})
