/**
 * A row label the design system styles no badge for renders NOTHING — `ActivityListRow` guards on
 * the style, not the label — so an unmapped label silently deletes the state from the feed instead
 * of failing loudly. That has bitten twice, so every label the request-link rows can emit is pinned
 * here against the real lookup.
 */
import { describe, expect, it } from "vitest"
import { statusBadgeStyle } from "@obsidion/web-ds"
import { buildRequestRows, type PaymentRequest } from "@obsidion/front-core"

const NOW = 1_800_000_000_000
const SIPA = `0x${"5a".repeat(20)}` as `0x${string}`

const linkRequest: PaymentRequest = {
  id: "req-link",
  contactTag: "",
  amount: 10,
  amountAtomic: "10000000000000000000",
  asset: "DAI",
  direction: "outgoing",
  status: "pending",
  createdAt: NOW - 60_000,
  kind: "link",
  sipaAddress: SIPA,
}

describe("request-link row badges", () => {
  it("styles every status a pending link row can reach", () => {
    const labels = [
      // Nothing has arrived.
      buildRequestRows([linkRequest], NOW)[0].statusLabel,
      // Funds seen at the linked SIPA, not credited yet.
      buildRequestRows([linkRequest], NOW, [
        { sipaAddress: SIPA, phase: "sweeping", amount: "10" },
      ])[0].statusLabel,
    ]

    expect(labels).toEqual(["Unpaid", "Payment detected"])
    for (const label of labels) expect(statusBadgeStyle(label)).toBeDefined()
    // Detected must not wear the settled colour — that is the state it has to be told apart from.
    expect(statusBadgeStyle("Payment detected")).not.toBe(statusBadgeStyle("Paid"))
  })
})
