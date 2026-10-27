import { describe, expect, it } from "vitest"
import { MAINNET_DAI, MAINNET_USDC, MAINNET_USDT } from "@oxide/l1-contracts"
import {
  deploymentOfTuples,
  type OxideDeploymentTable,
  type OxideRowTerms,
  type SipaIntentName,
} from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { sipaSweepRoutes } from "../../src/oxide/sipaSweepRoutes"

const DAI = MAINNET_DAI.toString()
const SUSDS = `0x${"5d".repeat(20)}`
const TEST = `0x${"7e".repeat(20)}`
const SECOND = `0x${"8e".repeat(20)}`
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
  depositSubsidy: `0x${(Number(byte) + 50).toString().repeat(20)}`,
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

const lower = (value: string) => value.toLowerCase()

describe("sipaSweepRoutes", () => {
  it("sweeps every deposit row's token through that row's subsidy and portal", () => {
    const rows = table([
      [TEST, ["deposit", "registration"]],
      [SECOND, ["deposit"]],
    ])
    const routes = sipaSweepRoutes(rows, 31337, "deposit")
    expect(routes).toEqual(
      rows.rows.map(({ bridge }) => ({
        token: bridge.underlying,
        portal: bridge.portal,
        depositSubsidy: bridge.tuple.depositSubsidy,
      })),
    )
  })

  it("sweeps a registration on the fee token's row alone", () => {
    const rows = table([
      [TEST, ["deposit", "registration"]],
      [SECOND, ["deposit"]],
    ])
    const routes = sipaSweepRoutes(rows, 31337, "registration")
    expect(routes.map((route) => lower(route.token))).toEqual([TEST])
  })

  it("routes the mainnet swap inputs through the DAI row they settle on", () => {
    const rows = table([
      [DAI, ["deposit", "registration"]],
      [SUSDS, ["deposit"]],
    ])
    const routes = sipaSweepRoutes(rows, 1, "deposit")
    const dai = rows.rows[0]!.bridge
    const susds = rows.rows[1]!.bridge
    expect(routes.map(({ token, depositSubsidy }) => [lower(token), depositSubsidy])).toEqual([
      [lower(DAI), dai.tuple.depositSubsidy],
      [lower(MAINNET_USDC.toString()), dai.tuple.depositSubsidy],
      [lower(MAINNET_USDT.toString()), dai.tuple.depositSubsidy],
      [SUSDS, susds.tuple.depositSubsidy],
    ])
  })

  it("refuses a row without a deposit subsidy, and a table that routes nothing", () => {
    const missing = table([[TEST, ["deposit"]]])
    const bridge = missing.rows[0]!.bridge
    const bare = {
      ...missing,
      rows: [
        {
          ...missing.rows[0]!,
          bridge: { ...bridge, tuple: { ...bridge.tuple, depositSubsidy: undefined } },
        },
      ],
    }
    expect(() => sipaSweepRoutes(bare, 31337, "deposit")).toThrow("publishes no deposit subsidy")
    expect(() => sipaSweepRoutes(table([[TEST, ["registration"]]]), 31337, "deposit")).toThrow(
      "routes no deposit sweep",
    )
  })
})
