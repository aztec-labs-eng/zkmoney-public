/**
 * The demo's fake L1 answers the sweep fee, the per-transaction cap and the withdrawal fee the
 * deployments charge, so a scenario reviewed offline shows the figures a real wallet shows. Read
 * from oxide's pin.
 */
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { DEPOSIT_SWEEP_FEE } from "@oxide/l1-contracts/deploy/deploy_forwarding_table.js"
import { DEMO_DEPOSIT_FEE, DEMO_TX_AMOUNT_CAP, DEMO_WITHDRAWAL_FEE } from "../src/dev/fakeL1Rpc"

/** The bridge seeds of the environment oxide's pin deploys: the DAI bridge's are `brg-dai-v<N>.json`. */
const BRIDGES = resolve(
  process.cwd(),
  "../../vendor/oxide/environments/deployments/seeds/devnext/bridges",
)

function newestDaiBridge(): { txAmountCap: string; withdrawalFee: string } {
  const version = (file: string) => Number(/^brg-dai-v(\d+)\.json$/.exec(file)?.[1] ?? -1)
  const newest = readdirSync(BRIDGES).sort((a, b) => version(b) - version(a))[0]!
  expect(version(newest)).toBeGreaterThan(0)
  return JSON.parse(readFileSync(resolve(BRIDGES, newest), "utf8")).deployment
}

describe("the demo's portal terms against oxide's pin", () => {
  it("answers the sweep tip oxide's forwarding table charges a deposit", () => {
    expect(DEMO_DEPOSIT_FEE).toBe(DEPOSIT_SWEEP_FEE)
  })

  it("answers the cap the newest DAI bridge deploys with", () => {
    expect(BigInt(newestDaiBridge().txAmountCap)).toBe(DEMO_TX_AMOUNT_CAP)
  })

  it("answers the withdrawal fee the newest DAI bridge's executor charges", () => {
    expect(BigInt(newestDaiBridge().withdrawalFee)).toBe(DEMO_WITHDRAWAL_FEE)
  })
})
