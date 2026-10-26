/**
 * The accepted-token read a screen waits on: loading until the table is read, failed once a read fails, and read again
 * on Retry or after the retry delay, so the screen never stands in a token of its own.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { OxideDeploymentTable, PinnedOxideDeployment } from "@obsidion/core/oxide"

const TOKEN = "0x00000000000000000000000000000000000000c6"
const PORTAL = "0x00000000000000000000000000000000000000a1"
const bridge = { underlying: TOKEN, token: TOKEN, portal: PORTAL, l2Token: "0x01", tuple: {} }
const deployment = { label: "sandbox", rollupVersion: "1", feeToken: TOKEN, bridges: [bridge] }
const terms = { sweepTip: 1n, beneficiaryFee: 0n }
const table = {
  deployment,
  rows: [{ bridge, intents: { deposit: terms, registration: terms }, txAmountCap: 100n }],
} as unknown as OxideDeploymentTable

const h = vi.hoisted(() => ({ reads: 0, fail: true }))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 31337, assets: [] }),
}))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideDeployment: async () =>
    ({ pinned: bridge, deployment } as unknown as PinnedOxideDeployment),
  getDeploymentTable: async () => {
    h.reads++
    if (h.fail) throw new Error("rpc down")
    return table
  },
  l1PublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "symbol" ? "USDC" : 6,
  }),
}))

const { DEPOSIT_TOKENS_RETRY_MS, useDepositTokensRead } = await import(
  "../src/features/deposit/loadDepositFacts"
)

let read: ReturnType<typeof useDepositTokensRead>
function Probe() {
  read = useDepositTokensRead()
  return null
}

let container: HTMLDivElement
let root: Root
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  h.reads = 0
  h.fail = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => root.unmount())
  container.remove()
})

it("loads, fails, and lists the table's tokens once Retry reads them", async () => {
  await act(async () => root.render(<Probe />))
  expect(read.tokens).toBeUndefined()
  await settle()
  expect(read.failed).toBe(true)
  expect(read.tokens).toBeUndefined()

  h.fail = false
  await act(async () => read.retry())
  expect(read.failed).toBe(false)
  await settle()
  expect(read.tokens?.options.map((t) => t.symbol)).toEqual(["USDC"])
  expect(read.tokens?.settlement.address).toBe(TOKEN)
  expect(read.failed).toBe(false)
})

it("reads again by itself after a failure", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  await act(async () => root.render(<Probe />))
  await settle()
  expect(read.failed).toBe(true)
  const before = h.reads

  h.fail = false
  await act(async () => vi.advanceTimersByTime(DEPOSIT_TOKENS_RETRY_MS))
  await settle()
  expect(h.reads).toBeGreaterThan(before)
  expect(read.tokens?.options).toHaveLength(1)
  expect(read.failed).toBe(false)
})
