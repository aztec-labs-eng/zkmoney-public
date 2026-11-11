// @vitest-environment node
/** The accepted tokens: a failure retries while shown, a late reader reads the table again, intents stay apart. */
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { QueryEntry } from "@obsidion/front-core"
import {
  DEPLOYMENT_TABLE_TTL_MS,
  DEPOSIT_TOKENS_RETRY_MS,
  depositTokenReads,
} from "../../src/app/pageChain"
import type { DepositTokens } from "../../src/features/sipa/loadDepositFacts"
import type { PageFacts } from "../../src/session/pageChain"
import { ROW_DAI, ROW_USDC, singleToken } from "../support/depositTokens"
import { testQuery } from "../support/query"

const DAI = singleToken(ROW_DAI, "DAI")
const USDC = singleToken(ROW_USDC, "USDC", 6)

function tokenReads() {
  const calls: string[] = []
  const answers: Record<string, DepositTokens | Error | Promise<DepositTokens>> = {
    deposit: DAI,
    registration: USDC,
  }
  const tokens = depositTokenReads(testQuery(), {} as PageFacts, async (intent) => {
    calls.push(intent)
    const answer = answers[intent]!
    if (answer instanceof Error) throw answer
    return answer
  })
  return { calls, answers, tokens }
}

/** A screen showing the tokens: subscribing starts the read. */
const show = (read: QueryEntry<DepositTokens>) => read.subscribe(() => {})
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it("reports a failed read as failed, not as no tokens, and lists them once Retry reads them", async () => {
  const { answers, tokens } = tokenReads()
  answers.deposit = new Error("rpc down")
  const read = tokens("deposit")
  const off = show(read)
  await flush()
  expect(read.get().status).toBe("failed")

  answers.deposit = DAI
  read.refresh()
  await flush()
  expect(read.get()).toEqual({ status: "ready", value: DAI, refreshing: false })
  off()
})

it("retries a failure on its backoff while a screen shows them, and not once it closes", async () => {
  const { calls, answers, tokens } = tokenReads()
  answers.deposit = new Error("rpc down")
  const read = tokens("deposit")
  const off = show(read)
  await flush()
  await vi.advanceTimersByTimeAsync(DEPOSIT_TOKENS_RETRY_MS)
  expect(calls).toEqual(["deposit", "deposit"])

  off()
  await vi.advanceTimersByTimeAsync(10 * DEPOSIT_TOKENS_RETRY_MS)
  expect(calls).toEqual(["deposit", "deposit"])
  answers.deposit = DAI
  show(read)
  await vi.advanceTimersByTimeAsync(2 * DEPOSIT_TOKENS_RETRY_MS)
  expect(read.get()).toMatchObject({ status: "ready", value: DAI })
})

it("reads the table again for a screen that opens after its reuse window", async () => {
  const { calls, answers, tokens } = tokenReads()
  const read = tokens("deposit")
  show(read)()
  await flush()
  show(read)()
  await flush()
  expect(calls).toEqual(["deposit"])

  answers.deposit = USDC
  await vi.advanceTimersByTimeAsync(DEPLOYMENT_TABLE_TTL_MS)
  const off = show(read)
  await flush()
  expect(calls).toEqual(["deposit", "deposit"])
  expect(read.get()).toEqual({ status: "ready", value: USDC, refreshing: false })
  off()
})

it("keeps the tokens on a screen that shows them while a later read loads the table again", async () => {
  const { answers, tokens } = tokenReads()
  const read = tokens("deposit")
  const offDeposit = show(read)
  await flush()

  let land!: (tokens: DepositTokens) => void
  answers.deposit = new Promise((resolve) => (land = resolve))
  await vi.advanceTimersByTimeAsync(DEPLOYMENT_TABLE_TTL_MS)
  const later = read.read()
  await flush()
  expect(read.get()).toEqual({ status: "ready", value: DAI, refreshing: true })

  land(USDC)
  await expect(later).resolves.toBe(USDC)
  expect(read.get()).toEqual({ status: "ready", value: USDC, refreshing: false })
  offDeposit()
})

it("keeps each intent's tokens apart: another intent waits for its own read", async () => {
  const { answers, tokens } = tokenReads()
  let land!: (tokens: DepositTokens) => void
  answers.registration = new Promise((resolve) => (land = resolve))
  const offDeposit = show(tokens("deposit"))
  const offRegistration = show(tokens("registration"))
  await flush()
  expect(tokens("deposit").get()).toMatchObject({ status: "ready", value: DAI })
  expect(tokens("registration").get()).toEqual({ status: "pending" })

  land(USDC)
  await flush()
  expect(tokens("registration").get()).toMatchObject({ status: "ready", value: USDC })
  offDeposit()
  offRegistration()
})
