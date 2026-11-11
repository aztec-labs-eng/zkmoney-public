// @vitest-environment node
/** The registration sweep fee, as the deployment's forwarding table prices it on L1. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Hex } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { OxideSipaIntent } from "@obsidion/sdk"
import { chainPricing } from "../../../src/features/registration/registrationPricing"
import { defaultConfig, testPage } from "../../support/page"

const TABLE = `0x${"aa".repeat(20)}` as const
const FEE_TOKEN = `0x${"fe".repeat(20)}` as const
const PORTAL = `0x${"11".repeat(20)}` as const
const abi = parseAbi([
  "function rowFor(address token, uint8 intent) view returns (address, address, uint128, uint128)",
  "function TX_AMOUNT_CAP() view returns (uint256)",
])
afterEach(() => vi.unstubAllGlobals())

/** An L1 node that answers the table's row and the portal's cap, and records each row read. */
function l1Node() {
  const rows: unknown[] = []
  const answer = (call: { id: number; params: [{ data: Hex }] }) => {
    const read = decodeFunctionData({ abi, data: call.params[0].data })
    if (read.functionName === "rowFor") rows.push(read.args)
    const result =
      read.functionName === "rowFor"
        ? encodeFunctionResult({ abi, functionName: "rowFor", result: [PORTAL, PORTAL, 3n, 4n] })
        : encodeFunctionResult({ abi, functionName: "TX_AMOUNT_CAP", result: 10n ** 24n })
    return { jsonrpc: "2.0", id: call.id, result }
  }
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body))
  })
  return rows
}

describe("chainPricing", () => {
  it("reads the sweep fee off the fee token's registration row: its fee plus its tip", async () => {
    const page = testPage(undefined, defaultConfig, {
      tuple: {
        rollupVersion: "1",
        forwardingTable: TABLE,
        token: `0x${"22".repeat(20)}`,
        feeToken: FEE_TOKEN,
      } as OxideEnvTuple,
    })
    const rows = l1Node()
    await expect(chainPricing(() => page).sweepFee()).resolves.toBe(7n)
    expect(rows).toEqual([[getAddress(FEE_TOKEN), OxideSipaIntent.Registration]])
  })
})
