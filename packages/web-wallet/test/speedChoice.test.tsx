import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WithdrawalSpeedupNode } from "@obsidion/front-core"

const faster = vi.hoisted(() => ({
  offer: undefined as
    | {
        proverTip: bigint
        standardEtaSeconds: number
        tippedEtaSeconds: number
        worstSpeedupSeconds: number
      }
    | undefined,
  loading: false,
}))
vi.mock("../src/features/withdraw/useFasterWithdrawal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/withdraw/useFasterWithdrawal")>()),
  useFasterWithdrawal: () => ({ offer: faster.offer, loading: faster.loading }),
}))

const { useSpeedChoice, useSpeedOutcome } = await import("../src/features/withdraw/speedChoice")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const TIP = 5n
const OFFER = {
  proverTip: TIP,
  standardEtaSeconds: 2_700,
  tippedEtaSeconds: 900,
  worstSpeedupSeconds: 1_800,
}

describe("useSpeedChoice + useSpeedOutcome", () => {
  let container: HTMLDivElement
  let root: Root
  let seen: { speed: string; pricedTip: bigint; proverTip: bigint; blocked?: string }

  function Harness({ initial, covers }: { initial?: "standard" | "faster"; covers?: boolean }) {
    const choice = useSpeedChoice({
      active: true,
      node: {} as WithdrawalSpeedupNode,
      initialSpeed: initial,
    })
    const outcome = useSpeedOutcome(choice, covers)
    seen = { speed: choice.speed, pricedTip: choice.pricedTip, ...outcome }
    return null
  }
  const render = (props: { initial?: "standard" | "faster"; covers?: boolean }) =>
    act(async () => root.render(<Harness {...props} />))

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    faster.offer = OFFER
    container = document.createElement("div")
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it("starts on Standard and burns no tip by default", async () => {
    await render({ covers: true })
    expect(seen).toMatchObject({ speed: "standard", pricedTip: 0n, proverTip: 0n })
  })

  it("starts on Faster when asked, and burns the tip it can cover", async () => {
    await render({ initial: "faster", covers: true })
    expect(seen).toMatchObject({ speed: "faster", pricedTip: TIP, proverTip: TIP })
  })

  it("falls back to Standard when the tip cannot be covered", async () => {
    await render({ initial: "faster", covers: false })
    expect(seen).toMatchObject({ speed: "standard", proverTip: 0n })
    expect(seen.blocked).toBeDefined()
  })

  it("waits on an unknown cover without blocking", async () => {
    await render({ initial: "faster", covers: undefined })
    expect(seen).toMatchObject({ speed: "faster", proverTip: TIP, blocked: undefined })
  })

  it("burns nothing when the tip would not help", async () => {
    faster.offer = { ...OFFER, worstSpeedupSeconds: 10 }
    await render({ initial: "faster", covers: true })
    expect(seen).toMatchObject({ speed: "faster", pricedTip: 0n, proverTip: 0n })
  })
})
