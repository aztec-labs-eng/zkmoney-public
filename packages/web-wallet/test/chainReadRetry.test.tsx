/**
 * A registration surface with no Check pill has nothing to nudge a chain read that gave up. This
 * hook is that nudge: while the surface reports a read still unknown, it calls the retry on a slow
 * cadence, a bounded number of times.
 */
import { act, useCallback, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import type { WebWalletConfig } from "../src/config/env"

const h = vi.hoisted(() => ({
  cut: vi.fn(),
  transfers: vi.fn(),
  read: vi.fn(),
  skim: vi.fn(),
}))

vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", l1RpcUrl: "http://127.0.0.1:8545" }),
}))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({
    portal: `0x${"b1".repeat(20)}`,
    registry: `0x${"b2".repeat(20)}`,
    sipaFactory: `0x${"b3".repeat(20)}`,
    pool: `0x${"b4".repeat(20)}`,
  }),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  l1PublicClient: () => ({ readContract: (args: { functionName: string }) => h.read(args) }),
}))
vi.mock("../src/features/fees/fpcFundingCut", () => ({ fpcFundingCut: () => h.cut() }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readFundingTransfers: () => h.transfers(),
  readDepositFee: () => h.skim(),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  registrationSipaImplementation: async () => `0x${"b5".repeat(20)}`,
}))

const {
  CHAIN_READ_RETRIES,
  CHAIN_READ_RETRY_MS,
  useChainReadRetry,
  useDepositSkim,
  useRegistrationSchedule,
  useSweepDeductions,
} = await import("../src/features/onboarding/registrationTerms")
const { useFundingTransfer } = await import("../src/features/onboarding/registrationFunding")

const CONFIG = { network: "testnet", l1RpcUrl: "http://127.0.0.1:8545" } as WebWalletConfig
const TOKEN = `0x${"d4".repeat(20)}`
const RECORD = {
  depositToken: TOKEN,
  sipaAddress: `0x${"c3".repeat(20)}`,
} as PendingRegistrationRecord

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let container: HTMLDivElement
let root: Root

/** Renders the retry count into the DOM, driven by a pending flag the test owns. */
function Probe({ pending }: { pending: boolean }) {
  const [key, setKey] = useState(0)
  const retry = useCallback(() => setKey((n) => n + 1), [])
  useChainReadRetry(pending, retry)
  return <span data-testid="key">{key}</span>
}
const mount = (pending: boolean) =>
  act(() => {
    root.render(<Probe pending={pending} />)
  })

const key = () => Number(container.querySelector('[data-testid="key"]')!.textContent)
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => {
  vi.useFakeTimers()
  h.cut.mockReset()
  h.transfers.mockReset()
  h.read.mockReset()
  h.skim.mockReset()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe("useChainReadRetry", () => {
  it("retries while a read is still unknown, and stops at its bound", async () => {
    await mount(true)
    expect(key()).toBe(0)

    await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(1)

    // Bounded: a deployment that never answers is not retried forever.
    for (let tick = 0; tick < CHAIN_READ_RETRIES + 3; tick++) await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(CHAIN_READ_RETRIES)
  })

  it("does nothing while nothing is pending", async () => {
    await mount(false)
    for (let tick = 0; tick < 3; tick++) await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(0)
  })

  it("starts once a read becomes unknown and stops once it lands", async () => {
    await mount(false)
    await mount(true)
    await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(1)

    await mount(false)
    for (let tick = 0; tick < 3; tick++) await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(1)
  })

  it("gives a read that falls back to unknown its full budget again", async () => {
    await mount(true)
    for (let tick = 0; tick < CHAIN_READ_RETRIES + 3; tick++) await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(CHAIN_READ_RETRIES)

    // A new record, or a figure this deployment answered and a later one did not.
    await mount(false)
    await mount(true)
    for (let tick = 0; tick < CHAIN_READ_RETRIES + 3; tick++) await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(CHAIN_READ_RETRIES * 2)
  })
})

/** The three attempts every one-shot chain read makes before it waits for its next trigger. */
describe("useSweepDeductions", () => {
  /** Long enough for both waits between the three attempts. */
  const ATTEMPTS_MS = 2_000

  function Probe({ refreshKey = 0 }: { refreshKey?: number }) {
    const deductions = useSweepDeductions(CONFIG, TOKEN, true, refreshKey)
    return (
      <span data-testid="key">{deductions === undefined ? "" : String(deductions.fpcCut)}</span>
    )
  }
  const cut = () => container.querySelector('[data-testid="key"]')!.textContent
  const show = (refreshKey: number) =>
    act(async () => {
      root.render(<Probe refreshKey={refreshKey} />)
    })

  it("rides out two failed reads and yields what the third answers", async () => {
    h.cut
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValueOnce(7n)

    await act(() => {
      root.render(<Probe />)
    })
    await wait(ATTEMPTS_MS)

    expect(h.cut).toHaveBeenCalledTimes(3)
    expect(cut()).toBe("7")
  })

  it("stays unread when every attempt fails, rather than reading as a zero cut", async () => {
    h.cut.mockRejectedValue(new Error("rpc down"))

    await act(() => {
      root.render(<Probe />)
    })
    await wait(ATTEMPTS_MS)

    expect(cut()).toBe("")
  })

  it("holds the cut it read across a bumped key", async () => {
    h.cut.mockResolvedValue(7n)
    await show(0)
    expect(cut()).toBe("7")

    await show(1)
    await wait(ATTEMPTS_MS)

    expect(h.cut).toHaveBeenCalledTimes(1)
    expect(cut()).toBe("7")
  })
})

describe("useRegistrationSchedule", () => {
  /** One read of the schedule: the controller lookup, then its two immutables. */
  const READS_PER_ATTEMPT = 3

  function Probe({ refreshKey }: { refreshKey: number }) {
    const schedule = useRegistrationSchedule(CONFIG, true, refreshKey, 0n)
    if (schedule === undefined) return <span data-testid="key" />
    return <span data-testid="key">{schedule === null ? "none" : String(schedule.fee)}</span>
  }
  const fee = () => container.querySelector('[data-testid="key"]')!.textContent
  const show = (refreshKey: number) =>
    act(async () => {
      root.render(<Probe refreshKey={refreshKey} />)
    })
  const answer = (min: bigint, feeWei: bigint) =>
    h.read.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "registrationController") return `0x${"c1".repeat(20)}`
      return functionName === "REGISTRATION_MIN" ? min : feeWei
    })

  it("holds the schedule it read across a bumped key", async () => {
    answer(2n, 3n)
    await show(0)
    expect(fee()).toBe("3")
    expect(h.read).toHaveBeenCalledTimes(READS_PER_ATTEMPT)

    await show(1)
    await wait(2_000)

    expect(h.read).toHaveBeenCalledTimes(READS_PER_ATTEMPT)
    expect(fee()).toBe("3")
  })

  it("treats a zero schedule as settled, not as a read to run again", async () => {
    answer(0n, 0n)
    await show(0)
    expect(fee()).toBe("none")

    await show(1)
    await wait(2_000)

    expect(h.read).toHaveBeenCalledTimes(READS_PER_ATTEMPT)
    expect(fee()).toBe("none")
  })
})

describe("useDepositSkim", () => {
  function Probe({ refreshKey }: { refreshKey: number }) {
    const skim = useDepositSkim(CONFIG, true, refreshKey)
    return <span data-testid="key">{skim === undefined ? "" : String(skim)}</span>
  }
  const skim = () => container.querySelector('[data-testid="key"]')!.textContent
  const show = (refreshKey: number) =>
    act(async () => {
      root.render(<Probe refreshKey={refreshKey} />)
    })

  it("holds the skim it read across a bumped key", async () => {
    h.read.mockResolvedValue(`0x${"c2".repeat(20)}`)
    h.skim.mockResolvedValue(4n)
    await show(0)
    expect(skim()).toBe("4")

    await show(1)
    await wait(2_000)

    expect(h.skim).toHaveBeenCalledTimes(1)
    expect(skim()).toBe("4")
  })
})

describe("useFundingTransfer", () => {
  function Probe({ refreshKey }: { refreshKey: number }) {
    const funding = useFundingTransfer(RECORD, refreshKey)
    if (funding === undefined) return <span data-testid="key" />
    return <span data-testid="key">{funding === null ? "none" : String(funding.amount)}</span>
  }
  const amount = () => container.querySelector('[data-testid="key"]')!.textContent
  const show = (refreshKey: number) =>
    act(async () => {
      root.render(<Probe refreshKey={refreshKey} />)
    })

  it("runs the read again on a bumped key, after one that failed", async () => {
    h.transfers.mockRejectedValueOnce(new Error("rpc down"))
    await show(0)
    expect(amount()).toBe("")

    h.transfers.mockResolvedValueOnce([
      { from: `0x${"11".repeat(20)}` as Address, txHash: `0x${"22".repeat(32)}`, amount: 5n },
    ])
    await show(1)

    expect(h.transfers).toHaveBeenCalledTimes(2)
    expect(amount()).toBe("5")
  })

  it("holds the funding it read across a bumped key", async () => {
    h.transfers.mockResolvedValue([
      { from: `0x${"11".repeat(20)}` as Address, txHash: `0x${"22".repeat(32)}`, amount: 5n },
    ])
    await show(0)
    expect(amount()).toBe("5")

    await show(1)

    expect(h.transfers).toHaveBeenCalledTimes(1)
    expect(amount()).toBe("5")
  })

  it("treats an untouched address as settled, not as a read to run again", async () => {
    h.transfers.mockResolvedValue([])
    await show(0)
    expect(amount()).toBe("none")

    await show(1)

    expect(h.transfers).toHaveBeenCalledTimes(1)
    expect(amount()).toBe("none")
  })
})
