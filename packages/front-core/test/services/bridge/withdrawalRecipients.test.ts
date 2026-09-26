/**
 * The one place that decides which address a withdrawal names. What is pinned is that a swap
 * separates the release payee from the destination, that a direct withdrawal collapses them, and
 * that a swap record missing its escrow degrades to direct rather than pairing escrow copy with a
 * recipient address.
 */
import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import { withdrawalRecipients } from "../../../src/core/services/bridge/withdrawalRecipients"

const RECIPIENT = `0x${"11".repeat(20)}` as Address
const ESCROW = `0x${"ee".repeat(20)}` as Address

describe("withdrawalRecipients", () => {
  it("collapses both answers onto the recipient for a direct withdrawal", () => {
    const r = withdrawalRecipients({ recipient: RECIPIENT })

    expect(r.release).toBe(RECIPIENT)
    expect(r.final).toBe(RECIPIENT)
    expect(r.viaEscrow).toBe(false)
  })

  it("releases to the escrow while the destination stays the recipient", () => {
    const r = withdrawalRecipients({
      recipient: RECIPIENT,
      swapOutput: "USDC",
      swapEscrow: ESCROW,
    })

    expect(r.release).toBe(ESCROW)
    expect(r.final).toBe(RECIPIENT)
    expect(r.viaEscrow).toBe(true)
  })

  it("reads a swap record with no escrow as direct", () => {
    const r = withdrawalRecipients({ recipient: RECIPIENT, swapOutput: "ETH" })

    expect(r.release).toBe(RECIPIENT)
    expect(r.viaEscrow).toBe(false)
  })

  it("ignores an escrow on a record with no swap output", () => {
    const r = withdrawalRecipients({ recipient: RECIPIENT, swapEscrow: ESCROW })

    expect(r.release).toBe(RECIPIENT)
    expect(r.viaEscrow).toBe(false)
  })
})
