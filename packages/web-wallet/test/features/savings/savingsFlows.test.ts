// @vitest-environment node
// The move sheet's quote and move wait for the session's Savings, and stop waiting on an abort.
import { describe, expect, it } from "vitest"
import type { SavingsSource } from "@obsidion/front-core"
import { moveSavings, quoteSavings } from "../../../src/features/savings/savingsFlows"
import { later } from "../../../../front-core/test/engine/taskTable"

describe("Savings flows", () => {
  it("stop waiting for Savings once the sheet aborts", async () => {
    const savings = later<SavingsSource | null>("savings")
    const session = { savings: savings.service }
    const stop = new AbortController()
    const quote = quoteSavings(session, "in", 1n, stop.signal)
    const move = moveSavings(session, "in", 1n, () => {}, stop.signal)
    stop.abort()
    await expect(quote).rejects.toMatchObject({ code: "aborted" })
    await expect(move).rejects.toMatchObject({ code: "aborted" })
  })
})
