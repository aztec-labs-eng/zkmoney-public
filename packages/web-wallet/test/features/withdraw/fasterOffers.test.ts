// @vitest-environment node
/**
 * The faster option is offered whenever a nonzero tip can be quoted, whatever it saves. It offers
 * nothing when a quote fails or outruns its wait, at a zero tip, or past the tip cutoff, and it
 * re-quotes while a view offers it. A view shows only an offer younger than two refreshes, takes it
 * as settled only once no quote is out, and stops loading once a quote gives up or its own wait
 * ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WithdrawalSpeedupEstimate } from "@obsidion/front-core"
import type { ProverTipQuote } from "@obsidion/sdk"
import { createClock, type QueryState } from "@obsidion/front-core"
import { fasterOffers } from "../../../src/features/withdraw/fasterOffers"
import {
  shownOffer,
  type FasterWithdrawal,
  type FasterWithdrawalQuote,
  type QuotedOffer,
} from "../../../src/features/withdraw/useFasterWithdrawal"
import {
  SWAP_QUOTE_MAX_AGE_MS,
  SWAP_QUOTE_REFRESH_MS,
} from "../../../src/features/withdraw/swapQuotes"
import { testQuery } from "../../support/query"

const TIP = 42n * 10n ** 16n
const speedup = (seconds: number, pastTipCutoff = false): WithdrawalSpeedupEstimate => ({
  epoch: 10 as WithdrawalSpeedupEstimate["epoch"],
  checkpointIndex: 3,
  standardEtaSeconds: 2_700,
  tippedEtaSeconds: 2_700 - seconds,
  worstSpeedupSeconds: seconds,
  speedupSeconds: seconds,
  confidence: "measured",
  pastTipCutoff,
})
const tipQuote = (proverTip: bigint): ProverTipQuote => ({
  proverTip,
  gasPriceWei: 10n ** 9n,
  usdPerEth: 2_500n * 10n ** 8n,
  subsidy: 0n,
})
const quotes =
  (seconds: number, tip = TIP, pastTipCutoff = false) =>
  async (): Promise<FasterWithdrawalQuote> => ({
    estimate: speedup(seconds, pastTipCutoff),
    quote: tipQuote(tip),
  })

const flush = () => vi.advanceTimersByTimeAsync(0)
/** A view offering the option. */
const offer = async (load: (signal: AbortSignal) => Promise<FasterWithdrawalQuote>) => {
  const entry = fasterOffers(testQuery(), load, () => Date.now())
  entry.subscribe(() => {})
  await flush()
  return entry
}
const offered = (entry: Awaited<ReturnType<typeof offer>>) => {
  const state = entry.get()
  return state.status === "ready" ? state.value.offer : undefined
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("fasterOffers", () => {
  it("offers a tip that saves nothing too, but none at a zero tip or past the tip cutoff", async () => {
    expect(offered(await offer(quotes(0)))?.worstSpeedupSeconds).toBe(0)
    expect(offered(await offer(quotes(1_200, 0n)))).toBeUndefined()
    expect(offered(await offer(quotes(1_200, TIP, true)))).toBeUndefined()
  })

  it("gives the standard ETA with or without a tip", async () => {
    const eta = (entry: Awaited<ReturnType<typeof offer>>) => {
      const state = entry.get()
      return state.status === "ready" ? state.value.eta : undefined
    }
    expect(eta(await offer(quotes(1_200)))).toEqual({ standardSeconds: 2_700 })
    expect(eta(await offer(quotes(1_200, 0n)))).toEqual({ standardSeconds: 2_700 })
  })

  it("is pending until the first quote answers, and offers nothing after a failure", async () => {
    let answer!: () => void
    const entry = await offer(
      () => new Promise((resolve) => (answer = () => resolve(quotes(1_200)()))),
    )
    expect(entry.get()).toEqual({ status: "pending" })
    answer()
    await flush()
    expect(offered(entry)?.proverTip).toBe(TIP)

    const failed = await offer(async () => {
      throw new Error("rpc down")
    })
    expect(failed.get().status).toBe("ready")
    expect(offered(failed)).toBeUndefined()
  })

  it("gives up on a quote that outruns two refreshes, aborts it, and stops loading", async () => {
    const signals: AbortSignal[] = []
    let answer!: () => void
    const entry = await offer((signal) => {
      signals.push(signal)
      return new Promise((resolve) => (answer = () => resolve(quotes(1_200)())))
    })
    await vi.advanceTimersByTimeAsync(SWAP_QUOTE_MAX_AGE_MS)
    expect(signals[0].aborted).toBe(true)
    expect(shownOffer(entry.get(), Date.now())).toEqual({
      offer: undefined,
      current: false,
      loading: false,
    })
    await vi.advanceTimersByTimeAsync(SWAP_QUOTE_REFRESH_MS)
    expect(signals).toHaveLength(2)
    answer()
    await flush()
    expect(offered(entry)?.proverTip).toBe(TIP)
  })

  it("quotes again at once for a view that opens on an offer two refreshes old", async () => {
    const entry = fasterOffers(testQuery(), quotes(1_200), () => Date.now())
    entry.subscribe(() => {})()
    await flush()
    await vi.advanceTimersByTimeAsync(SWAP_QUOTE_MAX_AGE_MS)
    entry.subscribe(() => {})
    expect(entry.get()).toMatchObject({ status: "ready", refreshing: true })
  })

  it("re-quotes while offered, since waiting moves the burn later in its epoch", async () => {
    let seconds = 1_200
    const entry = await offer(async () => ({ estimate: speedup(seconds), quote: tipQuote(TIP) }))
    expect(offered(entry)?.tippedEtaSeconds).toBe(1_500)
    seconds = 60
    await vi.advanceTimersByTimeAsync(SWAP_QUOTE_REFRESH_MS)
    expect(offered(entry)?.tippedEtaSeconds).toBe(2_640)
  })

  it("drops the offer when a re-quote runs past two refreshes", async () => {
    let calls = 0
    const entry = await offer(() => (++calls === 1 ? quotes(1_200)() : new Promise(() => {})))
    expect(offered(entry)?.proverTip).toBe(TIP)
    await vi.advanceTimersByTimeAsync(SWAP_QUOTE_REFRESH_MS + 2 * SWAP_QUOTE_REFRESH_MS - 1)
    expect(offered(entry)?.proverTip).toBe(TIP)
    await vi.advanceTimersByTimeAsync(1)
    expect(offered(entry)).toBeUndefined()
  })
})

describe("shownOffer", () => {
  const NOW = 1_000_000
  const OFFER = { proverTip: TIP } as FasterWithdrawal
  const ready = (quotedAt: number, refreshing = false, offer = OFFER): QueryState<QuotedOffer> => ({
    status: "ready",
    value: { offer, quotedAt },
    refreshing,
  })

  it.each([
    ["a settled quote", ready(NOW), undefined, { offer: OFFER, current: true, loading: false }],
    [
      "a quote out again",
      ready(NOW, true),
      undefined,
      { offer: OFFER, current: false, loading: false },
    ],
    [
      "a quote two refreshes old",
      ready(NOW - SWAP_QUOTE_MAX_AGE_MS),
      undefined,
      { offer: undefined, current: false, loading: true },
    ],
    [
      "no tip",
      { status: "ready", value: { quotedAt: NOW }, refreshing: false },
      undefined,
      { offer: undefined, current: false, loading: false },
    ],
    ["no quote yet", { status: "pending" }, undefined, { current: false, loading: true }],
    [
      "no quote before the view's wait ends",
      { status: "pending" },
      NOW + 1,
      { current: false, loading: true },
    ],
    [
      "no quote once the view's wait ends",
      { status: "pending" },
      NOW,
      { current: false, loading: false },
    ],
  ] as const)("shows %s", (_, state, waitEndsAt, shown) => {
    expect(shownOffer(state, NOW, waitEndsAt)).toEqual(shown)
  })

  it("drops an offer within a second of two refreshes on the page's clocks, and not before", async () => {
    vi.setSystemTime(100 * SWAP_QUOTE_REFRESH_MS + 1_000)
    const wall = () => Date.now()
    const seconds = createClock(1_000, wall)
    let calls = 0
    const load = () => (++calls === 1 ? quotes(1_200)() : new Promise<never>(() => {}))
    const entry = fasterOffers(testQuery(), load, wall)
    entry.subscribe(() => {})
    await flush()
    await vi.advanceTimersByTimeAsync(SWAP_QUOTE_MAX_AGE_MS - 1_000)
    expect(shownOffer(entry.get(), seconds.get()).offer?.proverTip).toBe(TIP)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(shownOffer(entry.get(), seconds.get()).offer).toBeUndefined()
  })
})
