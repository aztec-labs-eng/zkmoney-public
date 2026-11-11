// @vitest-environment node
/** An L1 token balance for the funding form: the balance read every time, the metadata once. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeFunctionResult, erc20Abi, getAddress, type Address, type Hex } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  InsufficientL1BalanceError,
  amountExceedsBalance,
  readL1DepositTokenBalance,
  type L1TokenBalance,
} from "../../../src/features/deposit/l1DepositTokenBalance"
import { defaultConfig, testPage } from "../../support/page"

const ACCOUNT = getAddress(`0x${"a1".repeat(20)}`)
const MANIFEST_TOKEN = getAddress(`0x${"da".repeat(20)}`)

let next = 1
/** A token no earlier case read, so no metadata is remembered for it. */
const freshToken = (): Address => getAddress(`0x${(next++).toString(16).padStart(40, "7")}`)

const BALANCE_OF = "0x70a08231"
const DECIMALS = "0x313ce567"
const SYMBOL = "0x95d89b41"

type RpcCall = { id: number; params: [{ to: Address; data: Hex }] }

/** An L1 node holding `balance` of a token with `decimals` and `symbol`; `failDecimals` reads fail first. */
function node(balance: bigint, decimals: number, symbol: string, failDecimals = 0) {
  const answers: Record<string, Hex> = {
    [BALANCE_OF]: encodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      result: balance,
    }),
    [DECIMALS]: encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: decimals }),
    [SYMBOL]: encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result: symbol }),
  }
  const calls: string[] = []
  /** The contract each `balanceOf` went to. */
  const balanceReads: Address[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as RpcCall | RpcCall[]
      const reply = (call: RpcCall) => {
        const selector = call.params[0].data.slice(0, 10)
        calls.push(selector)
        if (selector === BALANCE_OF) balanceReads.push(getAddress(call.params[0].to))
        if (selector === DECIMALS && failDecimals-- > 0) {
          return { jsonrpc: "2.0", id: call.id, error: { code: 3, message: "execution reverted" } }
        }
        return { jsonrpc: "2.0", id: call.id, result: answers[selector] }
      }
      const body = Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
    }),
  )
  return { calls, balanceReads }
}

afterEach(() => vi.unstubAllGlobals())

/** The page the reads run on: one per test, so each test reads metadata afresh. */
let page: ReturnType<typeof testPage>
beforeEach(() => {
  page = testPage(undefined, defaultConfig, {
    tuple: { rollupVersion: "7", token: MANIFEST_TOKEN } as OxideEnvTuple,
  })
})

describe("readL1DepositTokenBalance", () => {
  it("reads the manifest token by default and formats the balance exactly", async () => {
    const { balanceReads } = node(1_234_567n, 6, "USDC")

    const balance = await readL1DepositTokenBalance(ACCOUNT, undefined, page)

    expect(balance).toEqual({
      raw: 1_234_567n,
      value: 1.234567,
      display: "1.234567 USDC",
      symbol: "USDC",
      decimals: 6,
    })
    expect(balanceReads).toEqual([MANIFEST_TOKEN])
  })

  it("reads a named token instead of the manifest token", async () => {
    const token = freshToken()
    const { balanceReads } = node(1n, 18, "DAI")

    await readL1DepositTokenBalance(ACCOUNT, token, page)

    expect(balanceReads).toEqual([token])
  })

  it("reads a token's decimals and symbol once, and its balance every time", async () => {
    const token = freshToken()
    const { calls } = node(5n * 10n ** 18n, 18, "DAI")

    await readL1DepositTokenBalance(ACCOUNT, token, page)
    const second = await readL1DepositTokenBalance(ACCOUNT, token, page)

    expect(second.raw).toBe(5n * 10n ** 18n)
    expect(calls.filter((s) => s === BALANCE_OF)).toHaveLength(2)
    expect(calls.filter((s) => s === DECIMALS)).toHaveLength(1)
    expect(calls.filter((s) => s === SYMBOL)).toHaveLength(1)
  })

  it("does not remember a failed metadata read, so the next read asks again", async () => {
    const token = freshToken()
    const { calls } = node(10n ** 18n, 18, "DAI", 1)

    await expect(readL1DepositTokenBalance(ACCOUNT, token, page)).rejects.toThrow()
    await expect(readL1DepositTokenBalance(ACCOUNT, token, page)).resolves.toMatchObject({
      symbol: "DAI",
      decimals: 18,
    })
    expect(calls.filter((s) => s === DECIMALS)).toHaveLength(2)
  })
})

const BALANCE: L1TokenBalance = {
  raw: 10_500_000n,
  value: 10.5,
  display: "10.5 USDC",
  symbol: "USDC",
  decimals: 6,
}

describe("amountExceedsBalance", () => {
  it("is true only above the balance, in the token's own units", () => {
    expect(amountExceedsBalance("10.500001", BALANCE)).toBe(true)
    expect(amountExceedsBalance(" 10.5 ", BALANCE)).toBe(false)
    expect(amountExceedsBalance("1", BALANCE)).toBe(false)
  })

  it("is false for an amount that does not parse", () => {
    expect(amountExceedsBalance("ten", BALANCE)).toBe(false)
  })
})

describe("InsufficientL1BalanceError", () => {
  it("carries the balance it fell short of", () => {
    const error = new InsufficientL1BalanceError(BALANCE)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("InsufficientL1BalanceError")
    expect(error.balance).toBe(BALANCE)
  })
})
