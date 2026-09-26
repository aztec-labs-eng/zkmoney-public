/**
 * The swap quote hook is the only source of the tip a swap withdrawal commits to, so what is pinned is
 * its lifecycle: the debounce, the 30 s refresh feeding the last tip back, stale answers dropped, the fee
 * surviving a reload, and the route closing — not falling back — when the simulation fails.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatUnits, parseUnits, type Address } from "viem"
import { Network, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  SWAP_QUOTE_REFRESH_MS,
  SwapFeeNote,
  swapFloorAtomic,
  swapTipIsHigh,
  useSwapSimulation,
  WithdrawalEstimate,
  withdrawalFeeDisplay,
  type SimulateSwap,
  type SwapQuote,
  type WithdrawalQuoteState,
} from "../src/features/withdraw/withdrawQuote"
import type { WithdrawalReceiveAsset } from "../src/features/withdraw/withdrawAssets"

const TIP = 3n * 10n ** 18n
const CUT = 250_000_000_000_000_000n
const fee = (swapRelayerTip = TIP) => ({
  withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
  fpcFundingCut: CUT,
  swapRelayerTip,
  floorAtomic: WITHDRAW_RELAYER_TIP + CUT + swapRelayerTip,
})
const usdc = (amountOut: bigint): SwapQuote => ({
  fee: fee(),
  estimate: { amountOut, decimals: 6 },
})
const RECIPIENT = `0x${"dd".repeat(20)}` as Address
// Stable across renders, like the module-level default the hook uses in the app.
const readPortalCut = async () => CUT
const readPortalCutFails = async (): Promise<bigint> => {
  throw new Error("RPC unavailable")
}

function Harness({
  receiveAsset,
  amountAtomic,
  network = Network.MAINNET,
  sourceKey,
  simulate,
  readCut = readPortalCut,
  onState,
}: {
  receiveAsset: WithdrawalReceiveAsset
  amountAtomic?: bigint
  network?: Network
  sourceKey?: string
  simulate: SimulateSwap
  readCut?: () => Promise<bigint>
  /** Every render's status, so a one-frame flash the DOM no longer holds is still catchable. */
  onState?: (state: WithdrawalQuoteState) => void
}) {
  const state = useSwapSimulation({
    receiveAsset,
    amountAtomic,
    recipient: RECIPIENT,
    network,
    sourceKey,
    simulate,
    readCut,
    debounceMs: 300,
  })
  onState?.(state)
  return (
    <>
      <WithdrawalEstimate receiveAsset={receiveAsset} state={state} />
      <SwapFeeNote state={state} amountAtomic={amountAtomic} />
      <output data-testid="floor">{swapFloorAtomic(state).toString()}</output>
    </>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("useSwapSimulation", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  const render = (props: React.ComponentProps<typeof Harness>) =>
    act(async () => root.render(<Harness {...props} />))
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
  const state = () =>
    container.querySelector("[data-quote-state]")?.getAttribute("data-quote-state")
  const floor = () => BigInt(container.querySelector("[data-testid=floor]")!.textContent!)

  it("does not carry a fee or prior tip to another source deployment", async () => {
    const simulate = vi.fn<SimulateSwap>().mockResolvedValue(usdc(12n))
    const props = { receiveAsset: "USDC" as const, amountAtomic: 100n * 10n ** 18n, simulate }
    await render({ ...props, sourceKey: "old-token" })
    await tick(300)
    const frames: WithdrawalQuoteState[] = []
    await render({ ...props, sourceKey: "new-token", onState: (state) => frames.push(state) })
    expect(frames.every((state) => state.fee === undefined && state.status !== "ready")).toBe(true)
    await tick(300)
    expect(simulate.mock.lastCall?.[0].previousTip).toBeUndefined()
  })

  it("exposes idle, loading, and exact stablecoin ready states", async () => {
    const pending = deferred<SwapQuote>()
    const simulate = vi.fn(() => pending.promise)
    await render({ receiveAsset: "USDC", simulate })
    // No amount yet: the route is priced on its own, which is still a load.
    expect(state()).toBe("loading")

    await render({ receiveAsset: "USDC", amountAtomic: parseUnits("2", 18), simulate })
    expect(state()).toBe("loading")
    expect(container.textContent).toContain("Loading…")

    await tick(300)
    expect(simulate).toHaveBeenLastCalledWith({
      output: "USDC",
      amountAtomic: 2_000_000_000_000_000_000n,
      recipient: RECIPIENT,
      previousTip: undefined,
    })
    await act(async () => pending.resolve(usdc(1_999_123n)))
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("1.99912 USDC")
    expect(container.textContent).toContain("current pool state")
    expect(container.textContent).toContain("Includes 3 DAI for L1 gas")
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT + TIP)
  })

  it("prices the direct DAI route off the portal's cut, with no simulation", async () => {
    const simulate = vi.fn()
    await render({ receiveAsset: "DAI", simulate })
    // The route is priced before an amount exists: the fee does not depend on one.
    expect(state()).toBe("ready")
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT)

    await render({ receiveAsset: "DAI", amountAtomic: parseUnits("2", 18), simulate })
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("2 DAI")
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT)
    expect(simulate).not.toHaveBeenCalled()
  })

  it("closes the direct route when the portal's cut cannot be read", async () => {
    const seen: WithdrawalQuoteState[] = []
    await render({
      receiveAsset: "DAI",
      amountAtomic: parseUnits("2", 18),
      simulate: vi.fn(),
      readCut: readPortalCutFails,
      onState: (s) => seen.push(s),
    })
    expect(state()).toBe("unavailable")
    expect(floor()).toBe(0n)
    // The amount still lands whole; it is the fee the screen cannot state.
    expect(seen.at(-1)?.estimate?.amountOut).toBe(parseUnits("2", 18))
  })

  it("answers the direct route's estimate before the cut lands, and never loads", async () => {
    const cut = deferred<bigint>()
    const readCut = () => cut.promise
    const seen: WithdrawalQuoteState[] = []
    const props = { receiveAsset: "DAI" as const, simulate: vi.fn(), readCut }
    await render({ ...props, amountAtomic: parseUnits("2", 18), onState: (s) => seen.push(s) })

    // The typed amount is what lands, so only the fee is outstanding.
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("2 DAI")
    expect(floor()).toBe(0n)

    await act(async () => cut.resolve(CUT))
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT)

    // A new amount re-keys the hook, and the direct route answers the new one outright.
    seen.length = 0
    await render({ ...props, amountAtomic: parseUnits("5", 18), onState: (s) => seen.push(s) })
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("5 DAI")
    expect(seen.map((s) => s.status)).not.toContain("loading")
    expect(container.textContent).not.toContain("Loading…")
  })

  it("trims a full-precision ETH quote to five decimals", async () => {
    const simulate = vi.fn(async () => ({
      fee: fee(),
      estimate: { amountOut: 123_456_789_012_345_678n, decimals: 18 },
    }))
    await render({ receiveAsset: "ETH", amountAtomic: parseUnits("500", 18), simulate })
    await tick(300)
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("0.12346 ETH")
  })

  it("quotes on sandbox too — only testnet has no swap stack", async () => {
    const simulate = vi.fn(async () => usdc(1_980_000n))
    await render({
      receiveAsset: "USDC",
      amountAtomic: parseUnits("2", 18),
      network: Network.SANDBOX,
      simulate,
    })
    await tick(300)
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("1.98 USDC")
  })

  it("closes the route on testnet and on a failed simulation — there is no fallback tip", async () => {
    const simulate = vi.fn(async () => usdc(1n))
    await render({
      receiveAsset: "USDT",
      amountAtomic: parseUnits("2", 18),
      network: Network.TESTNET,
      simulate,
    })
    expect(state()).toBe("unavailable")
    expect(simulate).not.toHaveBeenCalled()

    const failed = vi.fn(async () => {
      throw new Error("RPC unavailable")
    })
    await render({ receiveAsset: "USDT", amountAtomic: parseUnits("3", 18), simulate: failed })
    await tick(300)
    expect(state()).toBe("unavailable")
    expect(container.textContent).toContain("Estimate unavailable")
    expect(container.textContent).toContain("Swap fee unavailable. Withdraw DAI instead.")
    expect(floor()).toBe(0n)
  })

  it("ignores a stale response after the amount and route change", async () => {
    const first = deferred<SwapQuote>()
    const eth = deferred<SwapQuote>()
    const simulate = vi.fn(({ output }: { output: string }) =>
      output === "USDC" ? first.promise : eth.promise,
    )

    await render({ receiveAsset: "USDC", amountAtomic: parseUnits("2", 18), simulate })
    await tick(300)
    await render({ receiveAsset: "ETH", amountAtomic: parseUnits("3", 18), simulate })
    await tick(300)

    await act(async () => first.resolve(usdc(9_999_999n)))
    expect(state()).toBe("loading")
    expect(container.textContent).not.toContain("10 USDC")

    await act(async () =>
      eth.resolve({ fee: fee(), estimate: { amountOut: 10n ** 18n, decimals: 18 } }),
    )
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("1 ETH")
  })

  it("re-simulates every 30 s with the last tip fed back, staying ready in between", async () => {
    const simulate = vi
      .fn<SimulateSwap>()
      .mockResolvedValueOnce(usdc(1_000_000n))
      .mockResolvedValueOnce({
        fee: fee(TIP + 10n ** 18n),
        estimate: { amountOut: 900_000n, decimals: 6 },
      })
    await render({ receiveAsset: "USDC", amountAtomic: parseUnits("5", 18), simulate })
    await tick(300)
    expect(state()).toBe("ready")
    expect(simulate).toHaveBeenCalledTimes(1)

    await tick(SWAP_QUOTE_REFRESH_MS - 300)
    expect(simulate).toHaveBeenCalledTimes(2)
    expect(simulate.mock.calls[1]![0].previousTip).toBe(TIP)
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("0.9 USDC")
    expect(container.textContent).toContain("Includes 4 DAI")
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT + TIP + 10n ** 18n)
  })

  it("carries the fee through a reload, so the floor never flickers away while the amount changes", async () => {
    const simulate = vi.fn(async () => usdc(1_000_000n))
    await render({ receiveAsset: "USDC", amountAtomic: parseUnits("5", 18), simulate })
    await tick(300)
    expect(state()).toBe("ready")

    await render({ receiveAsset: "USDC", amountAtomic: parseUnits("6", 18), simulate })
    expect(state()).toBe("loading")
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT + TIP)
    expect(container.textContent).toContain("Includes 3 DAI")
    // The last tip seeds the next estimate.
    await tick(300)
    expect(simulate).toHaveBeenLastCalledWith(expect.objectContaining({ previousTip: TIP }))
  })

  it("prices the direct route afresh after a swap route, never off the swap's fee", async () => {
    const simulate = vi.fn(async () => usdc(1_000_000n))
    await render({ receiveAsset: "USDC", amountAtomic: parseUnits("5", 18), simulate })
    await tick(300)
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT + TIP)

    const cut = deferred<bigint>()
    const seen: WithdrawalQuoteState[] = []
    await render({
      receiveAsset: "DAI",
      amountAtomic: parseUnits("5", 18),
      simulate,
      readCut: () => cut.promise,
      onState: (s) => seen.push(s),
    })
    // The amount is answered outright, but no fee is stated until the portal's cut is read.
    expect(state()).toBe("ready")
    expect(container.textContent).toContain("5 DAI")
    expect(floor()).toBe(0n)
    expect(seen.some((s) => s.fee !== undefined)).toBe(false)

    await act(async () => cut.resolve(CUT))
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT)
  })

  it("prices a swap route afresh after the direct route, with no fee or tip carried over", async () => {
    const pending = deferred<SwapQuote>()
    const simulate = vi.fn(() => pending.promise)
    await render({ receiveAsset: "DAI", amountAtomic: parseUnits("5", 18), simulate })
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT)

    const seen: WithdrawalQuoteState[] = []
    await render({
      receiveAsset: "USDC",
      amountAtomic: parseUnits("5", 18),
      simulate,
      onState: (s) => seen.push(s),
    })
    expect(state()).toBe("loading")
    expect(floor()).toBe(0n)
    expect(container.textContent).not.toContain("Includes")
    expect(seen.some((s) => s.fee !== undefined)).toBe(false)

    await tick(300)
    expect(simulate).toHaveBeenLastCalledWith(expect.objectContaining({ previousTip: undefined }))
    await act(async () => pending.resolve(usdc(4_990_000n)))
    expect(state()).toBe("ready")
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT + TIP)
  })

  it("shows the fee without an estimate for an amount the tip leaves nothing of", async () => {
    const simulate = vi.fn(async () => ({ fee: fee() }))
    await render({ receiveAsset: "USDC", amountAtomic: parseUnits("2", 18), simulate })
    await tick(300)
    expect(state()).toBe("ready")
    expect(container.querySelector(".ww-withdraw__estimate b")?.textContent).toBe("—")
    expect(floor()).toBe(WITHDRAW_RELAYER_TIP + CUT + TIP)
  })

  it("warns when the tip would eat more than a fifth of the amount", async () => {
    const simulate = vi.fn(async () => usdc(9_000_000n))
    await render({ receiveAsset: "USDC", amountAtomic: parseUnits("12", 18), simulate })
    await tick(300)
    expect(container.textContent).toContain("over 20% of this amount")

    await render({ receiveAsset: "USDC", amountAtomic: parseUnits("50", 18), simulate })
    await tick(300)
    expect(container.textContent).not.toContain("over 20% of this amount")
  })
})

describe("swap fee helpers", () => {
  const priced: WithdrawalQuoteState = { status: "ready", fee: fee() }

  it("states the whole floor, and nothing until the route is priced", () => {
    expect(withdrawalFeeDisplay({ status: "idle" })).toBeUndefined()
    expect(withdrawalFeeDisplay({ status: "loading" })).toBeUndefined()
    expect(withdrawalFeeDisplay({ status: "unavailable" })).toBeUndefined()
    expect(withdrawalFeeDisplay(priced)).toBe(formatUnits(WITHDRAW_RELAYER_TIP + CUT + TIP, 18))
  })

  it("flags a tip above 20% of the amount, and only with both figures known", () => {
    expect(swapTipIsHigh(priced, TIP * 5n)).toBe(false)
    expect(swapTipIsHigh(priced, TIP * 5n - 1n)).toBe(true)
    expect(swapTipIsHigh(priced, undefined)).toBe(false)
    expect(swapTipIsHigh({ status: "loading" }, 1n)).toBe(false)
  })
})
