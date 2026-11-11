// Guards: Standard when the note cannot cover the tip; no decision on an unread schedule.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { WithdrawalSpeedupEstimate } from "@obsidion/front-core"
import type { ProverTipQuote } from "@obsidion/sdk"
import {
  afterGate,
  REGISTRATION_TIP_BLOCKED_COPY,
  useRegistrationSpeed,
  type RegistrationSpeed,
} from "../../../src/features/paylink/registrationProverTip"
import { fasterOffers } from "../../../src/features/withdraw/fasterOffers"
import type { FasterWithdrawalQuote } from "../../../src/features/withdraw/useFasterWithdrawal"
import { closeSession } from "../../../src/session/session"
import { testQuery } from "../../support/query"
import { openTestSession } from "../../support/session"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const TICKET = { fee: dai(0.5), min: 0n }
/** The source executor's withdrawal fee. */
const FEE = dai(0.1)
/** The burn with no tip. */
const BURN = dai(0.71)
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
    pastTipCutoff: false,
  } as unknown as WithdrawalSpeedupEstimate,
  quote: { proverTip, gasPriceWei: 1n, usdPerEth: 1n, subsidy: 0n } as ProverTipQuote,
})

describe("useRegistrationSpeed", () => {
  let container: HTMLDivElement
  let root: Root
  let seen: RegistrationSpeed

  function Harness(props: Partial<Parameters<typeof useRegistrationSpeed>[0]>) {
    seen = useRegistrationSpeed({
      active: true,
      noteAmount: dai(4),
      schedule: TICKET,
      withdrawalFee: FEE,
      ...props,
    })
    return null
  }
  /** A session whose faster option quotes off `load`. */
  const quoting = (load: () => Promise<FasterWithdrawalQuote>) => {
    void openTestSession({
      wallet: {},
      fasterOffer: fasterOffers(testQuery(), load, () => Date.now()),
    })
  }
  const render = (props: Partial<Parameters<typeof useRegistrationSpeed>[0]>) =>
    act(async () => {
      root.render(<Harness {...props} />)
    })

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    closeSession()
  })

  it("falls back to Standard when the note cannot cover the tip", async () => {
    quoting(async () => loaded(600))
    await render({ noteAmount: BURN + TIP })
    expect(seen.outcome.blocked).toBe(REGISTRATION_TIP_BLOCKED_COPY)
    expect(seen.choice.speed).toBe("standard")
    expect(seen.proverTip).toBe(0n)
  })

  it("settles a tap before the quote on Standard, and a later quote keeps it", async () => {
    let answer: (value: ReturnType<typeof loaded>) => void = () => {}
    quoting(() => new Promise((resolve) => (answer = resolve)))
    await render({})
    expect(seen.decision).toBeUndefined()
    let settled: unknown
    await act(async () => void (settled = seen.settle()))
    expect(settled).toEqual({ tip: 0n, speed: "standard", withdrawalFee: FEE, picks: 0 })
    expect(seen.choice.speed).toBe("standard")
    await act(async () => answer(loaded(600)))
    expect(seen.choice.offer?.proverTip).toBe(TIP)
    expect(seen.decision).toEqual({ tip: 0n, speed: "standard", withdrawalFee: FEE, picks: 0 })
  })

  it("decides nothing while the schedule is unread, or while inactive", async () => {
    quoting(async () => loaded(600))
    await render({ schedule: undefined })
    expect(seen.decision).toBeUndefined()
    await render({ active: false })
    expect(seen.decision).toBeUndefined()
  })
})
