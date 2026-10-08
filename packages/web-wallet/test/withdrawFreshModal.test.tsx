/** The fresh-address sheet: chips, per-leg pricing, MAX, review, speed, the hand-off, resume. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseGwei, parseUnits } from "viem"
import { ScreeningProvider, passThroughScreener, type AddressScreener } from "@obsidion/front-core"
import { provingProgress } from "@obsidion/proving-progress"
import { showReportableError } from "../src/errors/errorModal"
import { fireEvent } from "../src/lib/analytics"
import { asOperation, endSigningAndHandOff } from "./support/handOff"
import type { WithdrawalQuoteState } from "../src/features/withdraw/withdrawQuote"
import type { FreshWithdrawStage } from "../src/features/withdraw/freshAddressGateway"

type Route = "USDC" | "USDT" | "ETH" | "DAI"
type Stage = FreshWithdrawStage["stage"]
const submit = vi.fn()
const resumeSubmit = vi.fn()
const cfg = { network: "sandbox" }
const walletAsset = { balance: 100, balanceAtomic: parseUnits("100", 18) }
const priced = (floor: string, tip: string) => ({
  floor: parseUnits(floor, 18),
  tip: parseUnits(tip, 18),
  status: "ready" as WithdrawalQuoteState["status"],
  amounts: [] as (bigint | undefined)[],
})
const ETH_GAS = { baseFee: parseGwei("2.4"), priorityFee: parseGwei("1") }
/** Each route's live answer: the floor it charges, the tip inside it, and whether it has priced. */
const freshRoutes = (): Record<Route, ReturnType<typeof priced>> => ({
  USDC: priced("0.35", "0.05"),
  USDT: priced("0.3", "0.04"),
  ETH: priced("0.45", "0.15"),
  // The direct route: a DAI funds leg, and what a resume prices in place of the gas leg.
  DAI: priced("0.1", "0"),
})
let routes = freshRoutes()

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({ obsidionAccount: {} }),
  useAssetContext: () => ({ tokenService: {} }),
  useAztecContext: () => ({ obsidionWallet: {} }),
  useContractServiceContext: () => ({ contractService: {} }),
  useBalance: () => ({ walletAsset, walletBalance: "100", assetsLoaded: true }),
  upsertSavedL1WalletContact: vi.fn(),
}))
vi.mock("../src/features/withdraw/freshAddressGateway", () => ({
  submitFreshAddressWithdrawal: submit,
  resumeFreshAddressFunds: resumeSubmit,
  freshLegBurnAmount: (display: string, floor: bigint) => parseUnits(display, 18) + floor,
}))
vi.mock("../src/config/env", () => ({ getConfig: () => cfg }))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "under_50",
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// One synchronous quote per route: the fee always, the estimate for a burn above the floor. The
// stable routes pay out the burn less their floor, the ETH route that at $3000 an ether.
vi.mock("../src/features/withdraw/withdrawQuote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/withdraw/withdrawQuote")>()),
  useSwapSimulation: (args: { receiveAsset: Route; amountAtomic?: bigint; proverTip?: bigint }) => {
    const { floor, tip: swapRelayerTip, status, amounts } = routes[args.receiveAsset]
    amounts.push(args.amountAtomic)
    if (status === "unavailable") return { status }
    const swapGas = args.receiveAsset === "ETH" ? ETH_GAS : undefined
    const proverTip = args.proverTip ?? 0n
    const floorAtomic = floor + proverTip
    const fee = {
      withdrawalRelayerTip: 0n,
      fpcFundingCut: 0n,
      swapRelayerTip,
      swapGas,
      proverTip,
      floorAtomic,
    }
    const net = (args.amountAtomic ?? 0n) - floorAtomic
    if (status !== "ready" || net <= 0n) return { status, fee }
    const eth = args.receiveAsset === "ETH"
    const amountOut = net / (eth ? 3000n : 10n ** 12n)
    return { status, fee, estimate: { amountOut, decimals: eth ? 18 : 6 } }
  },
}))

// The faster option the review offers, and how many burns it was asked to cover.
const faster = vi.hoisted(() => ({
  offer: undefined as
    | {
        proverTip: bigint
        standardEtaSeconds: number
        tippedEtaSeconds: number
        worstSpeedupSeconds: number
      }
    | undefined,
  legs: [] as (number | undefined)[],
  loading: false,
}))
vi.mock("../src/features/withdraw/useFasterWithdrawal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/withdraw/useFasterWithdrawal")>()),
  useFasterWithdrawal: ({ active, legs }: { active: boolean; legs?: number }) => {
    if (!active) return { loading: false }
    faster.legs.push(legs)
    return { offer: faster.offer, loading: faster.loading }
  },
}))
vi.mock("../src/features/withdraw/burnTiming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/withdraw/burnTiming")>()),
  recordBurnDuration: vi.fn(),
}))

const { recordBurnDuration } = await import("../src/features/withdraw/burnTiming")
const { FEE_UNAVAILABLE_COPY } = await import("../src/features/withdraw/withdrawQuote")
const sheet = await import("../src/features/withdraw/WithdrawFreshModal")
const speedCopy = await import("../src/features/withdraw/speedChoice")

const RECIPIENT = "0x1111111111111111111111111111111111111111" as const
const GROUP = "0x0102030405060708090a0b0c0d0e0f10" as const
const MINED = { phase: "pending-l1" }
const stageOf = (leg: "gas" | "funds", stage: Stage) =>
  ({ leg, index: leg === "gas" ? 1 : 2, stage } as FreshWithdrawStage)
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!

describe("WithdrawFreshModal", () => {
  let container: HTMLDivElement
  let root: Root
  const onDone = vi.fn()

  const input = () => container.querySelector("input") as HTMLInputElement
  const buttons = () => Array.from(container.querySelectorAll("button"))
  const button = (text: string) =>
    buttons().find((b) => (b.getAttribute("aria-label") ?? b.textContent) === text)!
  const click = (text: string) => act(async () => button(text).click())
  const picker = () => container.querySelector<HTMLElement>('button[aria-haspopup="listbox"]')!
  const pick = async (symbol: string) => {
    await act(async () => picker().click())
    const opts = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
    await act(async () => opts.find((o) => o.querySelector("b")?.textContent === symbol)!.click())
  }
  const type = (value: string) =>
    act(async () => {
      setValue.call(input(), value)
      input().dispatchEvent(new Event("input", { bubbles: true }))
    })
  const row = (label: string) =>
    Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((f) => f.querySelector("span")?.textContent === label)
      ?.querySelector("b")?.textContent
  const quote = (route: Route, amountOut: bigint, decimals: number, proverTip = 0n) => {
    const { tip: relayerTip, floor } = routes[route]
    return { relayerTip, amountOut, decimals, floorAtomic: floor + proverTip, proverTip }
  }
  const fired = (event: string) =>
    vi.mocked(fireEvent).mock.calls.filter(([name]) => name === event).length
  // The recipient is screened before the CTA can enable.
  const mount = async (
    resume?: Parameters<typeof sheet.WithdrawFreshModal>[0]["resume"],
    screener: AddressScreener = passThroughScreener,
  ) => {
    const props = { recipient: RECIPIENT, walletName: "Cold", resume, onClose: vi.fn(), onDone }
    await act(async () => root.render(null))
    await act(async () =>
      root.render(
        <ScreeningProvider screener={screener}>
          <sheet.WithdrawFreshModal {...props} />
        </ScreeningProvider>,
      ),
    )
    await act(() => new Promise((r) => setTimeout(r, 350)))
  }
  const confirm = async (cta = "Withdraw privately") => {
    await type("20")
    await click("Review")
    await click(cta)
  }

  beforeEach(async () => {
    vi.mocked(fireEvent).mockClear()
    vi.mocked(showReportableError).mockClear()
    vi.mocked(recordBurnDuration).mockClear()
    faster.offer = undefined
    faster.loading = false
    faster.legs = []
    submit.mockReset().mockImplementation(() => new Promise(() => {}))
    resumeSubmit.mockReset().mockImplementation(() => new Promise(() => {}))
    onDone.mockReset()
    routes = freshRoutes()
    cfg.network = "sandbox"
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await mount()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("offers every gas share, whatever the ETH floor", async () => {
    routes.ETH.floor = parseUnits("20", 18)
    await type("21")
    expect(button("$5").getAttribute("aria-pressed")).toBe("true")
    await click("$1")
    expect(button("$1").getAttribute("aria-pressed")).toBe("true")
    expect(button("Review").disabled).toBe(false)
  })

  it("sends the funds alone at a $0 gas share: one withdrawal, the funds floor as the fee, no ETH", async () => {
    await click("$0")
    expect(button("$0").getAttribute("aria-pressed")).toBe("true")
    expect(container.textContent).toContain(
      "No separate gas withdrawal. The address needs ETH from elsewhere before it can spend.",
    )
    // Funds landing as ETH are the address's gas: the note says so instead.
    await pick("ETH")
    expect(container.textContent).toContain(
      "No separate gas withdrawal. The funds arrive as ETH, so the address can spend them.",
    )
    await pick("DAI")
    const ethCalls = routes.ETH.amounts.length
    await type("20")
    // The funds route alone prices a burn; the ETH route is not asked for one.
    expect(routes.DAI.amounts).toContain(parseUnits("20.1", 18))
    expect(routes.ETH.amounts).toHaveLength(ethCalls)
    expect(row("Withdrawal fee")).toBe("$0.10")
    await click("Review")
    expect(row("Arrives as gas")).toBeUndefined()
    expect(row("Send")).toBe("$20")
    expect(row("Sending total")).toBe("$20.10")
    expect(row("Network")).toBe("Ethereum · 1 withdrawal")
    expect(faster.legs.at(-1)).toBe(1)
    await click("Withdraw privately")
    expect(submit).toHaveBeenCalledTimes(1)
    const [, input] = submit.mock.calls[0]!
    expect(input).toMatchObject({ gasDisplay: "0", fundsDisplay: "20", fundsAsset: "DAI" })
    expect(input.quotes.gas).toEqual({
      relayerTip: 0n,
      amountOut: 0n,
      decimals: 18,
      floorAtomic: 0n,
    })
  })

  it("hands the gateway the floor the burn was priced on, not a quote a hair off it", async () => {
    await pick("USDC")
    await type("20")
    expect(routes.USDC.amounts.at(-1)).toBe(parseUnits("20.35", 18))
    // The next quotes answer one atomic unit higher: the burn does not chase them.
    routes.USDC.floor = parseUnits("0.35", 18) + 1n
    await click("$10")
    await click("$5")
    expect(routes.USDC.amounts.at(-1)).toBe(parseUnits("20.35", 18))
    await click("Review")
    expect(row("Withdrawal fee")).toBe("$0.80")
    await click("Withdraw privately")
    const [, input] = submit.mock.calls[0]!
    expect(input.quotes.funds.floorAtomic).toBe(parseUnits("0.35", 18))
    expect(input.quotes.gas.floorAtomic).toBe(parseUnits("0.45", 18))
  })

  it("prices each burn with its own floor on top", async () => {
    await pick("USDC")
    await type("20")
    expect(routes.USDC.amounts.at(-1)).toBe(parseUnits("20.35", 18))
    expect(routes.ETH.amounts.at(-1)).toBe(parseUnits("5.45", 18))
  })

  it("says when the balance cannot cover the gas share, the fees and the minimum", async () => {
    walletAsset.balanceAtomic = parseUnits("6", 18)
    try {
      await click("MAX")
      expect(input().value).toBe("")
      expect(container.textContent).toContain(
        "Your balance can't cover the gas share and fees ($5.55) plus the $1 minimum.",
      )
      expect(button("Review").disabled).toBe(true)
    } finally {
      walletAsset.balanceAtomic = parseUnits("100", 18)
    }
  })

  it("MAX leaves room for the gas and both fees, and follows them until the amount is edited", async () => {
    await pick("USDC")
    await click("MAX")
    expect(input().value).toBe("94.2")
    expect(button("Review").disabled).toBe(false)
    await click("$10")
    expect(input().value).toBe("89.2")

    // One cent over the balance closes Review, and an edited amount stops following.
    await type("89.21")
    expect(button("Review").disabled).toBe(true)
    await click("$15")
    expect(input().value).toBe("89.21")
  })

  it("says what the gas leg's tip was priced on, under the fee, and not on a resume", async () => {
    const note = "Includes $0.15 for L1 gas at 3.4 gwei."
    expect(row("Withdrawal fee")).toBe("$0.55")
    expect(container.textContent).toContain(note)
    await pick("USDC")
    await type("20")
    expect(container.textContent).toContain(note)

    routes.ETH.status = "unavailable"
    await type("21")
    expect(container.textContent).not.toContain("for L1 gas")
    expect(container.textContent).not.toContain("Withdraw DAI instead")

    routes = freshRoutes()
    await mount({ groupId: GROUP, fundsDisplay: "20", fundsAsset: "USDT" })
    expect(container.textContent).not.toContain("for L1 gas")
  })

  it("keeps Review closed until both routes have priced the amount", async () => {
    routes.ETH.status = "loading"
    await type("20")
    expect(button("Review").disabled).toBe(true)
  })

  it.each([
    ["sandbox", FEE_UNAVAILABLE_COPY],
    ["testnet", sheet.NO_SWAP_STACK_COPY],
  ])("closes Review and says why when a route cannot be priced on %s", async (network, copy) => {
    cfg.network = network
    routes.USDC.status = "unavailable"
    await pick("USDC")
    await type("20")
    expect(row("Withdrawal fee")).toBe("$--")
    expect(container.textContent).not.toContain("for L1 gas")
    expect(button("Review").disabled).toBe(true)
    expect(container.textContent).toContain(copy)
  })

  it("reviews the picked asset's figures, then hands the gateway both quotes", async () => {
    expect(picker().textContent).toBe("DAI")
    expect(row("Withdrawal fee")).toBe("$0.55")
    await pick("USDT")
    await type("20")
    expect(routes.USDT.amounts.at(-1)).toBe(parseUnits("20.3", 18))
    await click("Review")
    expect(row("To")).toBe(`Cold${RECIPIENT}`)
    expect(row("Token")).toBe("USDT")
    expect(row("Send")).toBe("$20 ≈ 20 USDT")
    expect(row("Arrives as gas")).toBe("$5 ≈ 0.00167 ETH")
    expect(row("Withdrawal fee")).toBe("$0.75")
    expect(row("Sending total")).toBe("$25.75")
    expect(row("Network")).toBe("Ethereum · 2 withdrawals")
    expect(container.textContent).toContain("up to 40 minutes")

    await click("Back")
    expect(input().value).toBe("20")
    await click("Review")
    await click("Withdraw privately")
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][1]).toEqual({
      recipient: RECIPIENT,
      recipientAlias: "Cold",
      fundsDisplay: "20",
      gasDisplay: "5",
      fundsAsset: "USDT",
      quotes: {
        funds: quote("USDT", 20_000_000n, 6),
        gas: quote("ETH", parseUnits("5", 18) / 3000n, 18),
      },
    })
    expect(fireEvent).toHaveBeenCalledWith("withdraw_confirmed")
  })

  describe("speed", () => {
    const TIP = parseUnits("0.5", 18)
    const offer = {
      proverTip: TIP,
      standardEtaSeconds: 44 * 60,
      tippedEtaSeconds: 12 * 60,
      worstSpeedupSeconds: 30 * 60,
    }
    const speed = () => container.querySelector('[aria-haspopup="listbox"]')?.textContent
    const openSpeeds = async () => {
      await act(async () => picker().click())
      return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    }
    const toReview = async (amount = "20") => {
      await type(amount)
      await click("Review")
    }
    const sentTips = () => {
      const { quotes } = submit.mock.calls[0][1]
      return [quotes.gas.proverTip, quotes.funds.proverTip]
    }

    it("says it is checking while the first Faster quote loads", async () => {
      faster.loading = true
      await toReview()
      expect(speed()).toBeUndefined()
      expect(container.querySelector('[aria-busy="true"]')?.textContent).toBe("SpeedChecking…")
    })

    it("offers Standard alone without a faster option", async () => {
      await toReview()
      expect(speed()).toBeUndefined()
      await click("Withdraw privately")
      expect(sentTips()).toEqual([0n, 0n])
    })

    it("asks for an offer covering both legs, and one leg on a resume", async () => {
      await toReview()
      expect(faster.legs.at(-1)).toBe(2)
      await mount({ groupId: GROUP, fundsDisplay: "20" })
      await click("Review")
      expect(faster.legs.at(-1)).toBe(1)
    })

    it("shows Faster settled, with no tips, when a tip would not save a minute for certain", async () => {
      faster.offer = { ...offer, worstSpeedupSeconds: 59 }
      await toReview()
      expect(speed()).toBe("Faster")
      expect((picker() as HTMLButtonElement).disabled).toBe(true)
      expect(row("Withdrawal fee")).toBe("$0.55")
      await click("Withdraw privately")
      expect(sentTips()).toEqual([0n, 0n])
    })

    it("prices Faster at one tip, on the funds leg alone, and submits it", async () => {
      faster.offer = offer
      await toReview()
      expect(speed()).toBe("Standard")
      const options = await openSpeeds()
      expect(options.map((o) => o.textContent)).toEqual([
        "StandardAbout 44 min once confirmed",
        "FasterAbout 12 min once confirmed · 0.5 DAI",
      ])
      await act(async () => options[1]!.click())
      expect(speed()).toBe("Faster")
      expect(routes.DAI.amounts.at(-1)).toBe(parseUnits("20.6", 18))
      expect(routes.ETH.amounts.at(-1)).toBe(parseUnits("5.45", 18))
      expect(row("Withdrawal fee")).toBe("$1.05")
      expect(row("Sending total")).toBe("$26.05")
      await click("Withdraw privately")
      expect(submit.mock.calls[0][1].quotes).toEqual({
        funds: quote("DAI", 20_000_000n, 6, TIP),
        gas: quote("ETH", parseUnits("5", 18) / 3000n, 18),
      })
    })

    it("keeps a maxed amount and greys Faster out: no tip fits on top of MAX", async () => {
      faster.offer = offer
      await click("MAX")
      expect(input().value).toBe("94.45")
      await click("Review")
      const [, fasterOption] = await openSpeeds()
      expect(fasterOption!.disabled).toBe(true)
      expect(fasterOption!.textContent).toBe(`Faster${speedCopy.BALANCE_TIP_BLOCKED_COPY}`)
      expect(row("Send")).toBe("$94.45")
      expect(row("Sending total")).toBe("$100")
    })

    it("disables Faster when the balance can't cover the tip", async () => {
      // $25.55 at Standard leaves $74.45.
      faster.offer = { ...offer, proverTip: parseUnits("75", 18) }
      await toReview()
      const [, fasterOption] = await openSpeeds()
      expect(fasterOption!.disabled).toBe(true)
      expect(fasterOption!.textContent).toBe(`Faster${speedCopy.BALANCE_TIP_BLOCKED_COPY}`)
      await act(async () => picker().click())
      await click("Withdraw privately")
      expect(sentTips()).toEqual([0n, 0n])

      await mount({ groupId: GROUP, fundsDisplay: "20" })
      faster.offer = { ...offer, proverTip: parseUnits("74", 18) }
      await click("Review")
      const [, fits] = await openSpeeds()
      expect(fits!.disabled).toBe(false)
      expect(fits!.textContent).toBe("FasterAbout 12 min once confirmed · 74 DAI")
    })
  })

  it("offers DAI as a direct withdrawal: its own floor, and no swap estimate to review", async () => {
    await pick("DAI")
    await click("MAX")
    expect(input().value).toBe("94.45")
    await type("20")
    expect(routes.DAI.amounts.at(-1)).toBe(parseUnits("20.1", 18))
    await click("Review")
    expect(row("Token")).toBe("DAI")
    expect(row("Send")).toBe("$20")
    expect(row("Withdrawal fee")).toBe("$0.55")
    expect(row("Sending total")).toBe("$25.55")
    await click("Withdraw privately")
    expect(submit.mock.calls[0][1]).toMatchObject({
      fundsAsset: "DAI",
      quotes: { funds: { relayerTip: 0n, floorAtomic: routes.DAI.floor } },
    })
  })

  it.each([
    ["fails, unmounted", true, undefined, 1],
    ["fails, still mounted", false, undefined, 1],
    ["finishes", false, { groupId: GROUP, gas: MINED, funds: MINED }, 2],
  ])("leaves once when signing ends, whatever follows: %s", async (_, unmounts, result, mined) => {
    if (unmounts) onDone.mockImplementation(() => root.render(null))
    let onStage!: (s: FreshWithdrawStage) => void
    let end!: () => void
    submit.mockImplementation(
      asOperation(
        (_deps, _input, advance: typeof onStage) =>
          new Promise((resolve, reject) => {
            onStage = advance
            end = () => (result ? resolve(result) : reject(new Error("Withdrawal failed")))
          }),
        "withdraw",
      ),
    )
    await confirm()
    await act(async () => provingProgress.emitSigningStart())
    expect(onDone).not.toHaveBeenCalled()
    await endSigningAndHandOff()
    expect(onDone).toHaveBeenCalledOnce()

    await act(async () => {
      onStage(stageOf("funds", "building"))
      end()
    })
    expect(onDone).toHaveBeenCalledOnce()
    expect(button("Withdraw privately")).toBeUndefined()
    expect(showReportableError).not.toHaveBeenCalled()
    expect(fired("proving_cancelled")).toBe(0)
    // The funds leg starts only once the gas leg has mined.
    expect(fired("withdraw_submitted")).toBe(mined)
  })

  it.each([
    ["the full flow", undefined, "gas", "Withdraw privately"],
    ["a resume", { groupId: GROUP, fundsDisplay: "20" }, "funds", "Send remaining funds"],
  ] as const)("keeps the first leg's confirm → mined time: %s", async (_, resume, leg, cta) => {
    const gateway = resume ? resumeSubmit : submit
    gateway.mockImplementation(async (_deps, _input, onStage) => {
      for (const l of resume ? ["funds"] : ["gas", "funds"]) {
        for (const s of ["building", "proving", "submitting"])
          onStage(stageOf(l as never, s as Stage))
      }
      return { groupId: GROUP, [leg]: MINED }
    })
    if (resume) await mount(resume)
    await confirm(cta)
    expect(recordBurnDuration).toHaveBeenCalledOnce()
  })

  it.each([
    ["the gas leg left to chain", { gas: { phase: "submitting" } }, 0],
    ["both legs mined", { gas: MINED, funds: MINED }, 2],
    ["the funds leg failed", undefined, 1],
  ])("closes through onDone when the flow ends first: %s", async (_, legs, mined) => {
    submit.mockImplementation(async (_deps, _input, onStage) => {
      if (legs) return { groupId: GROUP, ...legs }
      onStage(stageOf("funds", "building"))
      throw new Error("Withdrawal failed")
    })
    await confirm()
    expect(onDone).toHaveBeenCalledOnce()
    expect(button("Withdraw privately")).toBeUndefined()
    expect(fired("withdraw_submitted")).toBe(mined)
  })

  it("offers Cancel only while the first leg is building, and honors none clicked later", async () => {
    let onStage!: (s: FreshWithdrawStage) => void
    submit.mockImplementation((_deps, _input, advance) => {
      onStage = advance
      return new Promise(() => {})
    })
    await confirm()
    await act(async () => {
      onStage(stageOf("gas", "proving"))
      // React has not yet removed the Cancel handler for the new stage.
      button("Cancel").click()
    })
    expect(button("Cancel")).toBeUndefined()
    await act(async () => {
      onStage(stageOf("gas", "submitting"))
      onStage(stageOf("funds", "building"))
    })
    expect(button("Cancel")).toBeUndefined()
    await act(async () => onStage(stageOf("funds", "proving")))
  })

  it.each([
    ["the full flow", undefined, "gas", "Withdraw privately"],
    ["a resume", { groupId: GROUP, fundsDisplay: "20" }, "funds", "Send remaining funds"],
  ] as const)("honors a cancel at the proving checkpoint: %s", async (_, resume, leg, cta) => {
    let proceed!: () => void
    const gateway = resume ? resumeSubmit : submit
    gateway.mockImplementation(async (_deps, _input, onStage) => {
      onStage(stageOf(leg, "building"))
      await new Promise<void>((resolve) => (proceed = resolve))
      onStage(stageOf(leg, "proving"))
      return { groupId: GROUP }
    })
    if (resume) await mount(resume)
    await confirm(cta)
    await click("Cancel")
    await act(async () => proceed())
    expect(button(cta)).toBeDefined()
    expect(onDone).not.toHaveBeenCalled()
  })

  it.each([
    ["a failure", new Error("Withdrawal failed"), 1],
    ["a closed passkey prompt", Object.assign(new Error("Closed"), { name: "NotAllowedError" }), 0],
  ])("returns to confirm on %s before the sheet has left", async (_, error, failures) => {
    submit.mockRejectedValue(error)
    await confirm()
    expect(onDone).not.toHaveBeenCalled()
    expect(showReportableError).toHaveBeenCalledTimes(failures)
    expect(fired("action_failed")).toBe(failures)
    await click("Withdraw privately")
    expect(fired("retry_clicked")).toBe(failures)
  })

  describe("the per-withdrawal limit", () => {
    // Each burn is its own withdrawal: the funds burn, its floor included, may be $2,500, and the
    // gas burn is a second withdrawal counted on its own.
    const notice = () => container.querySelector('[data-testid="limit-notice"]')?.textContent
    const OVER = "Over the $2,500 limit"
    const rerender = async () => {
      await click("$10")
      await click("$5")
    }

    beforeEach(async () => {
      walletAsset.balanceAtomic = parseUnits("10000", 18)
      await mount()
    })
    afterEach(() => {
      walletAsset.balanceAtomic = parseUnits("100", 18)
    })

    it("names the limit per withdrawal beside the amount, with its explanation", async () => {
      const line = container.querySelector('[data-testid="operation-limits"]')!
      expect(line.textContent).toBe("Min $1 · Max per withdrawal: $2,500 incl. fees")
      const info = line.querySelector('[data-testid="about-limits-link"]')!
      expect(info.getAttribute("aria-label")).toBe("About the withdrawal limit")
    })

    it.each([
      ["DAI", "2499.9"],
      ["USDC", "2499.65"],
    ])(
      "MAX on a large balance stops the %s funds burn, its floor included, at $2,500",
      async (asset, max) => {
        await pick(asset)
        await click("MAX")
        expect(input().value).toBe(max)
        expect(routes[asset as Route].amounts.at(-1)).toBe(parseUnits("2500", 18))
        expect(notice()).toBeUndefined()
        await click("Review")
        await click("Withdraw privately")
        expect(submit.mock.calls[0][1]).toMatchObject({ fundsDisplay: max, gasDisplay: "5" })
      },
    )

    it("MAX subtracts the funds fee as soon as it is priced, before the gas route answers", async () => {
      routes.ETH.status = "unavailable"
      await click("MAX")
      expect(input().value).toBe("2499.9")
      expect(notice()).toBeUndefined()
    })

    it("takes a funds burn of exactly $2,500 and refuses one cent more, offering the maximum", async () => {
      await type("2499.9")
      expect(notice()).toBeUndefined()
      expect(button("Review").disabled).toBe(false)

      await type("2499.91")
      expect(notice()).toContain(OVER)
      expect(button("Review").disabled).toBe(true)
      expect(input().value).toBe("2499.91")
      await click("Use maximum ($2,499.90)")
      expect(input().value).toBe("2499.9")
      expect(button("Review").disabled).toBe(false)
    })

    it("keeps MAX within the limit as the floor moves, and flags a typed amount it pushes over", async () => {
      await pick("USDC")
      await click("MAX")
      expect(input().value).toBe("2499.65")
      routes.USDC.floor = parseUnits("0.5", 18)
      await rerender()
      expect(input().value).toBe("2499.5")
      expect(notice()).toBeUndefined()

      // A typed amount, not MAX: the field must change for the edit to register.
      await type("2499")
      await type("2499.5")
      routes.USDC.floor = parseUnits("0.6", 18)
      await rerender()
      expect(input().value).toBe("2499.5")
      expect(notice()).toContain(OVER)
      expect(button("Review").disabled).toBe(true)
    })

    it("says a moved fee put the reviewed burn over the limit, and holds Confirm", async () => {
      await type("2499.9")
      await click("Review")
      routes.DAI.floor = parseUnits("0.2", 18)
      // The same sheet renders again, as it does when its quotes refresh.
      await act(async () =>
        root.render(
          <ScreeningProvider screener={passThroughScreener}>
            <sheet.WithdrawFreshModal recipient={RECIPIENT} onClose={vi.fn()} onDone={onDone} />
          </ScreeningProvider>,
        ),
      )
      expect(row("Send")).toBe("$2499.90")
      expect(notice()).toContain(OVER)
      expect(button("Withdraw privately").disabled).toBe(true)
    })

    describe("Faster", () => {
      const TIP = parseUnits("0.5", 18)
      beforeEach(() => {
        faster.offer = {
          proverTip: TIP,
          standardEtaSeconds: 44 * 60,
          tippedEtaSeconds: 12 * 60,
          worstSpeedupSeconds: 30 * 60,
        }
      })
      const openSpeeds = async () => {
        await act(async () => picker().click())
        return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      }

      it("is blocked when its tip would put a typed amount's funds burn over the limit", async () => {
        await type("2499.9")
        await click("Review")
        const [, fasterOption] = await openSpeeds()
        expect(fasterOption!.disabled).toBe(true)
        expect(fasterOption!.textContent).toBe(`Faster${speedCopy.LIMIT_TIP_BLOCKED_COPY}`)
        await act(async () => picker().click())
        await click("Withdraw privately")
        expect(submit.mock.calls[0][1].quotes.funds.proverTip).toBe(0n)
      })

      it("keeps a maxed amount and refuses the tip that would put it over the limit", async () => {
        await click("MAX")
        expect(input().value).toBe("2499.9")
        await click("Review")
        const [, fasterOption] = await openSpeeds()
        expect(fasterOption!.disabled).toBe(true)
        expect(fasterOption!.textContent).toBe(`Faster${speedCopy.LIMIT_TIP_BLOCKED_COPY}`)
        expect(row("Send")).toBe("$2499.90")
        await act(async () => picker().click())
        await click("Withdraw privately")
        expect(submit.mock.calls[0][1]).toMatchObject({
          fundsDisplay: "2499.9",
          quotes: { funds: { proverTip: 0n } },
        })
      })
    })

    it("resumes a funds leg of exactly $2,500, and refuses one cent more", async () => {
      await mount({ groupId: GROUP, fundsDisplay: "2499.9", fundsAsset: "DAI" })
      expect(notice()).toBeUndefined()
      await click("Review")
      await click("Send remaining funds")
      expect(resumeSubmit.mock.calls[0][1]).toMatchObject({ fundsDisplay: "2499.9" })

      await mount({ groupId: GROUP, fundsDisplay: "2499.91", fundsAsset: "DAI" })
      expect(notice()).toContain(OVER)
      expect(button("Review").disabled).toBe(true)
    })

    it("names the balance, not the limit, when an amount is over both", async () => {
      walletAsset.balanceAtomic = parseUnits("100", 18)
      await type("3000")
      expect(notice()).toBeUndefined()
      expect(container.textContent).toContain("Balance not enough")
      expect(button("Review").disabled).toBe(true)
    })

    it("keeps screening the address: a blocked one holds Review for an amount within the limit", async () => {
      const blocked: AddressScreener = {
        screen: async () => ({
          compliant: false,
          reason: { code: "blocked", message: "Sanctioned address" },
        }),
      }
      await mount(undefined, blocked)
      await type("2499.9")
      expect(container.textContent).toContain("Sanctioned address")
      expect(button("Review").disabled).toBe(true)
    })
  })

  it("resumes with the funds leg alone, in the asset the failed leg was to land", async () => {
    await mount({ groupId: GROUP, fundsDisplay: "20", fundsAsset: "USDT" })
    expect(input().value).toBe("20")
    expect(picker().textContent).toBe("USDT")
    expect(button("$5")).toBeUndefined()
    expect(row("Withdrawal fee")).toBe("$0.30")

    await click("Review")
    expect(row("Arrives as gas")).toBeUndefined()
    expect(row("Sending total")).toBe("$20.30")
    expect(row("Network")).toBe("Ethereum · 1 withdrawal")
    await click("Send remaining funds")
    expect(submit).not.toHaveBeenCalled()
    const [, sent] = resumeSubmit.mock.calls[0]
    expect(sent).toMatchObject({ groupId: GROUP, fundsDisplay: "20", gasDisplay: "0" })
    expect(sent.quotes.funds.floorAtomic).toBe(routes.USDT.floor)
  })
})
