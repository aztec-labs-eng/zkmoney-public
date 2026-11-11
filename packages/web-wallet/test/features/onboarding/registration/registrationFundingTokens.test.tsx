// @vitest-environment node
/**
 * A mainnet registration SIPA may be funded in USDC or USDT, which the sweep swaps into DAI. The
 * Activity row keeps the token that funded it and normalizes the whole deposit into fee-token
 * units for the credit maths.
 */
import { describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { createPace } from "@obsidion/core/cadence"
import { memoryStore, queries } from "@obsidion/front-core"
import {
  fundingTransfers,
  registrationFunding,
  type RegistrationFunding,
} from "../../../../src/features/registration/registrationFunding"
import { fakeClock, flush } from "../../../../../front-core/test/engine/taskTable"

const dai = { address: `0x${"d4".repeat(20)}` as Address, symbol: "DAI", decimals: 18 }
const usdc = { address: `0x${"a0".repeat(20)}` as Address, symbol: "USDC", decimals: 6 }
const FUNDER = `0x${"11".repeat(20)}` as Address
const TOPPER = `0x${"33".repeat(20)}` as Address
const transfer = (from: Address, amount: bigint, blockNumber: bigint) => ({
  from,
  amount,
  blockNumber,
  txHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as `0x${string}`,
})

describe("registrationFunding", () => {
  it("sums a topped-up USDC deposit under its own token, funder first, normalized to DAI", () => {
    const funding = registrationFunding(
      [dai, usdc],
      [[], [transfer(FUNDER, 10_000_000n, 5n), transfer(TOPPER, 5_000_000n, 9n)]],
    )
    expect(funding).toEqual({
      from: FUNDER,
      txHash: transfer(FUNDER, 0n, 5n).txHash,
      token: usdc,
      amount: 15_000_000n,
      normalized: 15n * 10n ** 18n,
    })
  })

  it("folds a top-up in another token into the normalized total only", () => {
    const funding = registrationFunding(
      [dai, usdc],
      [[transfer(FUNDER, 10n * 10n ** 18n, 5n)], [transfer(TOPPER, 5_000_000n, 9n)]],
    )
    expect(funding).toMatchObject({
      token: dai,
      amount: 10n * 10n ** 18n,
      normalized: 15n * 10n ** 18n,
    })
    expect(registrationFunding([dai, usdc], [[], []])).toBeNull()
  })
})

describe("fundingTransfers", () => {
  fakeClock()
  const SIPA = `0x${"c3".repeat(20)}`
  const record = { sipaAddress: SIPA, depositToken: dai.address }
  const deposits = (phase?: string) =>
    memoryStore({
      records: phase ? [{ sipaAddress: SIPA, phase }] : [],
      loaded: true,
      failed: false,
    })
  const query = () =>
    queries({
      pace: createPace({ signalled: false }),
      visible: memoryStore(true),
      now: () => Date.now(),
    })
  const funding = (read: () => Promise<RegistrationFunding | null>, view = deposits()) =>
    fundingTransfers(query(), read, { view } as never)
  const reading = (read: () => Promise<RegistrationFunding | null>, view = deposits()) => {
    const r = funding(read, view).of(record)
    return Object.assign(r, { close: r.subscribe(() => {}) })
  }
  const ready = (value: RegistrationFunding | null) => ({
    status: "ready",
    value,
    refreshing: false,
  })

  it("retries a failed read from 24 s, doubling to 5 minutes, until it recovers", async () => {
    const read = vi.fn(async (): Promise<null> => {
      throw new Error("rpc down")
    })
    const r = reading(read)
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(23_999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    // 48 s, 96 s, 192 s, then the 5-minute cap.
    await vi.advanceTimersByTimeAsync(48_000 + 96_000 + 192_000 + 300_000)
    expect(read).toHaveBeenCalledTimes(6)
    read.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(read).toHaveBeenCalledTimes(7)
    expect(r.get()).toEqual(ready(null))
    r.close()
  })

  it("keeps one slow read in flight until it lands, reading nothing else meanwhile", async () => {
    let land!: (value: null) => void
    const read = vi.fn(() => new Promise<null>((resolve) => (land = resolve)))
    const r = reading(read)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(r.get().status).toBe("pending")
    land(null)
    await flush()
    expect(r.get()).toEqual(ready(null))
    r.close()
  })

  it("keeps one read per address, read again when a top-up changes the amount held", async () => {
    const view = deposits("funded")
    const held = (heldBalance: string) =>
      view.set({
        ...view.get(),
        records: [{ sipaAddress: SIPA, phase: "funded", heldBalance }],
      } as never)
    const first = registrationFunding([dai], [[transfer(FUNDER, 1n, 5n)]])
    const topped = registrationFunding(
      [dai],
      [[transfer(FUNDER, 1n, 5n), transfer(TOPPER, 2n, 9n)]],
    )
    const read = vi.fn(async (): Promise<RegistrationFunding | null> => first)
    const reads = funding(read, view)
    const r = reads.of(record)
    expect(reads.of({ ...record, sipaAddress: SIPA.toUpperCase() })).toBe(r)
    const off = r.subscribe(() => {})
    held("1")
    await flush()
    expect(r.get()).toEqual(ready(first))
    read.mockResolvedValue(topped)
    held("3")
    await flush()
    expect(r.get()).toEqual(ready(topped))
    expect(topped?.amount).toBe(3n)
    held("3")
    await flush()
    expect(read).toHaveBeenCalledTimes(3)
    off()
  })

  it("reads nothing again when the deposit changes phase and holds the same amount", async () => {
    const view = deposits("funded")
    const read = vi.fn(async (): Promise<RegistrationFunding | null> => null)
    const off = funding(read, view)
      .of(record)
      .subscribe(() => {})
    await flush()
    for (const phase of ["sweeping", "broadcast", "claimed"])
      view.set({ ...view.get(), records: [{ sipaAddress: SIPA, phase }] } as never)
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    off()
  })
})
