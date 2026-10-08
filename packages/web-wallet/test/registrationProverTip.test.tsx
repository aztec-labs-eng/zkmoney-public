/**
 * A ticket registration's speed starts on Faster, and its burn tips the prover only when that is
 * worth it and the note still covers the burn with the tip; Standard, a failed or a stalled quote
 * commits none.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WithdrawalSpeedupEstimate, WithdrawalSpeedupNode } from "@obsidion/front-core"
import type { ProverTipQuote } from "@obsidion/sdk"
import {
  REGISTRATION_OFFER_TIMEOUT_MS,
  REGISTRATION_TIP_BLOCKED_COPY,
  useRegistrationSpeed,
  type RegistrationSpeed,
} from "../src/features/paylink/registrationProverTip"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const NODE = {} as WithdrawalSpeedupNode
const TICKET = { fee: dai(0.5), min: 0n }
const CUTS = { withdrawalCut: dai(0.1), depositCut: dai(0.1) }
/** The burn at these cuts with no tip. */
const BURN = dai(0.81)
const TIP = dai(0.4)
const loaded = (worstSpeedupSeconds: number, proverTip = TIP) => ({
  estimate: {
    epoch: 10,
    checkpointIndex: 3,
    standardEtaSeconds: 2_700,
    tippedEtaSeconds: 2_700 - worstSpeedupSeconds,
    worstSpeedupSeconds,
    speedupSeconds: worstSpeedupSeconds,
    confidence: "measured",
  } as unknown as WithdrawalSpeedupEstimate,
  quote: { proverTip, gasPriceWei: 1n, usdPerEth: 1n, subsidy: 0n } as ProverTipQuote,
})

describe("useRegistrationSpeed", () => {
  let container: HTMLDivElement
  let root: Root
  let seen: RegistrationSpeed
  const onCommit = vi.fn((_tip: bigint, _speed: string) => {})

  function Harness(props: Partial<Parameters<typeof useRegistrationSpeed>[0]>) {
    seen = useRegistrationSpeed({
      active: true,
      node: NODE,
      noteAmount: dai(3),
      schedule: TICKET,
      cuts: CUTS,
      onCommit,
      ...props,
    })
    return null
  }
  const render = (props: Partial<Parameters<typeof useRegistrationSpeed>[0]>) =>
    act(async () => {
      root.render(<Harness {...props} />)
    })

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    onCommit.mockClear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it("starts on Faster and commits the tip with it, and holds it once inactive", async () => {
    const load = vi.fn(async () => loaded(600))
    await render({ load })
    expect(seen.choice.speed).toBe("faster")
    expect(seen.proverTip).toBe(TIP)
    expect(onCommit).toHaveBeenLastCalledWith(TIP, "faster")
    await render({ load, active: false })
    expect(seen.proverTip).toBe(TIP)
  })

  it("starts from the speed it committed before", async () => {
    await render({ load: async () => loaded(600), initialSpeed: "standard" })
    expect(seen.choice.speed).toBe("standard")
    expect(seen.proverTip).toBe(0n)
    expect(onCommit).toHaveBeenLastCalledWith(0n, "standard")
  })

  it("commits no tip once Standard is picked", async () => {
    await render({ load: async () => loaded(600) })
    await act(async () => seen.choice.setSpeed("standard"))
    expect(seen.proverTip).toBe(0n)
    expect(onCommit).toHaveBeenLastCalledWith(0n, "standard")
  })

  it("commits the same choice again once its target appears", async () => {
    const load = vi.fn(async () => loaded(600))
    await render({ load })
    const calls = onCommit.mock.calls.length
    await render({ load, commitKey: "account:tag" })
    expect(onCommit).toHaveBeenCalledTimes(calls + 1)
    expect(onCommit).toHaveBeenLastCalledWith(TIP, "faster")
  })

  it("commits no tip when the offer is not worth it", async () => {
    await render({ load: async () => loaded(30) })
    expect(seen.choice.settled).toBe(true)
    expect(seen.proverTip).toBe(0n)
  })

  it("falls back to Standard when the note cannot cover the tip", async () => {
    await render({ load: async () => loaded(600), noteAmount: BURN + TIP })
    expect(seen.outcome.blocked).toBe(REGISTRATION_TIP_BLOCKED_COPY)
    expect(seen.choice.speed).toBe("standard")
    expect(seen.proverTip).toBe(0n)
  })

  it("decides nothing while the quote is out, then goes ahead without a tip", async () => {
    vi.useFakeTimers()
    await render({ load: () => new Promise(() => {}) })
    expect(seen.proverTip).toBeUndefined()
    expect(seen.choice.loading).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REGISTRATION_OFFER_TIMEOUT_MS)
    })
    expect(seen.choice.loading).toBe(false)
    expect(seen.proverTip).toBe(0n)
  })

  it("decides nothing while the cuts are unread", async () => {
    await render({ load: async () => loaded(600), cuts: undefined })
    expect(seen.proverTip).toBeUndefined()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("reads nothing while inactive", async () => {
    const load = vi.fn(async () => loaded(600))
    await render({ load, active: false })
    expect(seen.proverTip).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })
})
