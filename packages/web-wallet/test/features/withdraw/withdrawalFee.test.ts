// @vitest-environment node
/** A deployment's withdrawal executor: read once per session, checked against the portal. */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { encodeAbiParameters, getAddress, toFunctionSelector, type Address, type Hex } from "viem"
import { withdrawalExecutor } from "../../../src/features/withdraw/withdrawalFee"
import { testPage } from "../../support/page"

const PORTAL = getAddress(`0x${"0b".repeat(20)}`)
const OTHER_PORTAL = getAddress(`0x${"0c".repeat(20)}`)
const BENEFICIARY = getAddress(`0x${"0d".repeat(20)}`)
const FEE = 25_000n

let next = 1
const executorAddress = (): Address => getAddress(`0x${(next++).toString(16).padStart(40, "e")}`)

const word = (type: "address" | "uint256", value: Address | bigint) =>
  encodeAbiParameters([{ type }], [value as never])

/** An L1 node whose executors serve `portal`; `failures` reads reject first. */
function node(portal: Address, failures = 0) {
  const answers: Record<Hex, Hex> = {
    [toFunctionSelector("PORTAL()")]: word("address", portal),
    [toFunctionSelector("FEE()")]: word("uint256", FEE),
    [toFunctionSelector("BENEFICIARY()")]: word("address", BENEFICIARY),
  }
  const calls: Hex[] = []
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    if (failures-- > 0) throw new TypeError("rpc down")
    const parsed = JSON.parse(init.body) as RpcCall | RpcCall[]
    const reply = (call: RpcCall) => {
      const selector = call.params[0].data.slice(0, 10) as Hex
      calls.push(selector)
      return { jsonrpc: "2.0", id: call.id, result: answers[selector] }
    }
    const body = Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
  })
  vi.stubGlobal("fetch", fetch)
  return { calls }
}
type RpcCall = { id: number; params: [{ data: Hex }] }

const tuple = (executor: Address, portal = PORTAL) =>
  ({ plainWithdrawalExecutor: executor, portal } as unknown as OxideEnvTuple)
afterEach(() => vi.unstubAllGlobals())

describe("withdrawalExecutor", () => {
  it("reads the executor's portal, fee and beneficiary once for the session", async () => {
    const reads = testPage().chain
    const { calls } = node(PORTAL)
    const address = executorAddress()
    const executor = await withdrawalExecutor(reads, tuple(address))
    expect(executor).toEqual({
      address,
      kind: "plain",
      portal: PORTAL,
      fee: FEE,
      beneficiary: BENEFICIARY,
    })
    await expect(withdrawalExecutor(reads, tuple(address))).resolves.toBe(executor)
    expect(calls).toHaveLength(3)
  })

  it("refuses an executor that serves another portal", async () => {
    const reads = testPage().chain
    node(OTHER_PORTAL)
    await expect(withdrawalExecutor(reads, tuple(executorAddress()))).rejects.toThrow(OTHER_PORTAL)
  })
})

describe("withdrawalExecutorAt", () => {
  it("reads each kind under its own key, whatever the address's case", async () => {
    const reads = testPage().chain
    const { calls } = node(PORTAL)
    const address = executorAddress()
    const plain = await reads.withdrawalExecutorAt(address).read()
    await expect(reads.withdrawalExecutorAt(address.toLowerCase() as Address).read()).resolves.toBe(
      plain,
    )
    const sky = await reads.withdrawalExecutorAt(address, "sky").read()
    expect([plain.kind, sky.kind, sky.fee]).toEqual(["plain", "sky", 0n])
    expect(calls).toHaveLength(4)
  })

  it("drops a failed read, so the next call reads again", async () => {
    const reads = testPage().chain
    const address = executorAddress()
    node(PORTAL, Infinity)
    await expect(reads.withdrawalExecutorAt(address, "sky").read()).rejects.toThrow()
    node(PORTAL)
    await expect(reads.withdrawalExecutorAt(address, "sky").read()).resolves.toMatchObject({
      portal: PORTAL,
    })
  })
})
