import { describe, expect, it } from "vitest"
import { MAINNET_DAI, MAINNET_USDC, MAINNET_USDT } from "@oxide/l1-contracts"
import {
  deploymentOfTuples,
  type OxideDeploymentTable,
  type OxideRowTerms,
  type SipaIntentName,
} from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { sipaRowByFunding, sipaRowFundingTokens, sipaRows } from "../../src/oxide/sipaRows"

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

const SYMBOLS: Record<string, string> = {
  [lower(DAI)]: "DAI",
  [lower(MAINNET_USDC.toString())]: "USDC",
  [lower(MAINNET_USDT.toString())]: "USDT",
  [SUSDS]: "sUSDS",
  [TEST]: "TEST",
  [SECOND]: "SECOND",
}
const metadata = async (token: string) => ({
  symbol: SYMBOLS[lower(token)]!,
  decimals: SYMBOLS[lower(token)]?.startsWith("USD") ? 6 : 18,
})

describe("sipaRows", () => {
  it("lists each row with its token, L2 token, portal and the intents that settle on it", async () => {
    const rows = table([
      [TEST, ["deposit", "registration", "user-op"]],
      [SECOND, ["deposit", "registration"]],
    ])
    const read = await sipaRows(rows, 31337, metadata)
    expect(read).toEqual([
      {
        portal: rows.rows[0]!.bridge.portal,
        l2Token: rows.rows[0]!.bridge.l2Token,
        token: { address: TEST, symbol: "TEST", decimals: 18 },
        swapped: [],
        intents: ["deposit", "registration", "user-op"],
      },
      {
        portal: rows.rows[1]!.bridge.portal,
        l2Token: rows.rows[1]!.bridge.l2Token,
        token: { address: SECOND, symbol: "SECOND", decimals: 18 },
        swapped: [],
        // A registration settles on the fee token's row, whatever the second row prices.
        intents: ["deposit"],
      },
    ])
  })

  it("puts the mainnet swap inputs on the DAI row they settle on", async () => {
    const rows = table([
      [DAI, ["deposit", "registration"]],
      [SUSDS, ["deposit"]],
    ])
    const read = await sipaRows(rows, 1, metadata)
    expect(read[0]!.swapped.map((t) => t.symbol)).toEqual(["USDC", "USDT"])
    expect(read[1]!.swapped).toEqual([])
    expect(sipaRowByFunding(read, MAINNET_USDT.toString())).toBe(read[0])
    expect(sipaRowByFunding(read, SUSDS)).toBe(read[1])
    expect(sipaRowFundingTokens(read).map((t) => t.symbol)).toEqual([
      "DAI",
      "USDC",
      "USDT",
      "sUSDS",
    ])
  })

  it("takes the swap inputs of a row that settles registrations alone", async () => {
    const rows = table([
      [DAI, ["registration", "user-op"]],
      [SUSDS, ["deposit"]],
    ])
    const read = await sipaRows(rows, 1, metadata)
    expect(read[0]!.intents).toEqual(["registration", "user-op"])
    expect(read[0]!.swapped.map((t) => t.symbol)).toEqual(["USDC", "USDT"])
  })

  it("leaves out a row no intent settles on", async () => {
    const rows = table([
      [TEST, ["deposit", "registration"]],
      [SECOND, []],
    ])
    expect((await sipaRows(rows, 31337, metadata)).map((row) => row.token.symbol)).toEqual(["TEST"])
  })
})
