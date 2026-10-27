import { describe, expect, it } from "vitest"
import { MAINNET_DAI, MAINNET_USDC, MAINNET_USDT } from "@oxide/l1-contracts"
import {
  deploymentOfTuples,
  type OxideDeploymentTable,
  type OxideRowTerms,
  type SipaIntentName,
} from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { depositTokenRoutes } from "../../src/oxide/depositTokenRoutes"

const DAI = MAINNET_DAI.toString()
const USDC = MAINNET_USDC.toString()
const USDT = MAINNET_USDT.toString()
const TEST = `0x${"7e".repeat(20)}`
const terms: OxideRowTerms = { sweepTip: 1n, beneficiaryFee: 0n }

const tuple = (token: string, byte: string, feeToken: string): OxideEnvTuple => ({
  version: "v6.0.0",
  gitSha: "",
  timestamp: "2026-10-14T00:00:00.000Z",
  deployedAt: "2026-10-14T00:00:00.000Z",
  portal: `0x${byte.repeat(20)}`,
  token,
  underlying: token,
  l2Token: `0x${byte.repeat(32)}`,
  enclaveUrl: "https://enclave.example/rpc",
  pcr0: "",
  rollupVersion: "1",
  forwardingTable: `0x${"fb".repeat(20)}`,
  feeToken,
})

/** One row per `[token, intents]`, the first token the fee token. */
function table(rows: [string, SipaIntentName[]][]): OxideDeploymentTable {
  const feeToken = rows[0]![0]
  const tuples = rows.map(([token], i) => tuple(token, (10 + i).toString(), feeToken))
  const deployment = deploymentOfTuples(tuples as [OxideEnvTuple, ...OxideEnvTuple[]])
  return {
    deployment,
    rows: deployment.bridges.map((bridge, i) => ({
      bridge,
      intents: Object.fromEntries(rows[i]![1].map((intent) => [intent, terms])),
      txAmountCap: 100n,
    })),
  }
}

const listed = (routes: ReturnType<typeof depositTokenRoutes>) =>
  routes.map((route) => [
    route.token.toLowerCase(),
    route.row.bridge.underlying.toLowerCase(),
    route.swapped,
  ])

describe("depositTokenRoutes", () => {
  it("lists each row of a two-bridge table on its own row off mainnet", () => {
    const rows = table([
      [TEST, ["deposit", "registration"]],
      [USDC, ["deposit"]],
    ])

    expect(listed(depositTokenRoutes(rows, 31337))).toEqual([
      [TEST, TEST, false],
      [USDC.toLowerCase(), USDC.toLowerCase(), false],
    ])
  })

  it("lists the one row of a one-bridge table", () => {
    expect(listed(depositTokenRoutes(table([[TEST, ["deposit"]]]), 11155111))).toEqual([
      [TEST, TEST, false],
    ])
  })

  it("puts the mainnet swap inputs after the DAI row they settle on", () => {
    expect(listed(depositTokenRoutes(table([[DAI, ["deposit"]]]), 1))).toEqual([
      [DAI.toLowerCase(), DAI.toLowerCase(), false],
      [USDC.toLowerCase(), DAI.toLowerCase(), true],
      [USDT.toLowerCase(), DAI.toLowerCase(), true],
    ])
  })

  it("shadows a mainnet USDC row: USDC swaps into DAI", () => {
    const rows = table([
      [DAI, ["deposit"]],
      [USDC, ["deposit"]],
    ])

    expect(listed(depositTokenRoutes(rows, 1)).map(([token, row]) => [token, row])).toEqual([
      [DAI.toLowerCase(), DAI.toLowerCase()],
      [USDC.toLowerCase(), DAI.toLowerCase()],
      [USDT.toLowerCase(), DAI.toLowerCase()],
    ])
  })

  it("lists only the fee token's row for a registration", () => {
    const rows = table([
      [TEST, ["deposit", "registration"]],
      [USDC, ["deposit", "registration"]],
    ])

    expect(listed(depositTokenRoutes(rows, 31337, "registration"))).toEqual([[TEST, TEST, false]])
  })

  it("leaves out a row that does not price the intent", () => {
    const rows = table([
      [TEST, ["registration"]],
      [USDC, ["deposit"]],
    ])

    expect(listed(depositTokenRoutes(rows, 31337))).toEqual([
      [USDC.toLowerCase(), USDC.toLowerCase(), false],
    ])
  })
})
