/** Guards: no address while the claim is unsettled; one per open; no early spot; the right QR. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type PendingRegistrationRecord,
  type RegistrationTerms,
  ScreeningProvider,
  passThroughScreener,
} from "@obsidion/front-core"
import type { Hex } from "viem"
import type { DepositAddress } from "../../../src/features/sipa/depositTarget"
import { MAINNET_USDC, tokenOption } from "../../support/depositTokens"
import { testScreenings } from "../../support/page"

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex

/** The pool reads empty (the open's limit-0 read refuses), and the coin row derives. */
const resolveDefault = async (...args: unknown[]): Promise<DepositAddress> => {
  if ((args[1] as { publishingLimit?: number } | undefined)?.publishingLimit === 0) {
    throw new AddressesPublishingError()
  }
  return { address: "0xdeadbeef", name: "alice.oxide.eth" }
}
const depositAddress = vi.fn<(...args: unknown[]) => Promise<DepositAddress>>(resolveDefault)
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb" as Hex

// Stable identities so `resolveAddress` keeps one identity across renders.
const aztec = { obsidionWallet: { networkId: "0xnet" } }

const navigate = vi.hoisted(() => vi.fn())
// What the rail observes at the address.
const held = vi.hoisted(() => vi.fn(async (): Promise<bigint> => 0n))
const fireEvent = vi.hoisted(() => vi.fn())
/** Coins offered past the network's own. */
const extraCoins = vi.hoisted(
  () => [] as import("../../../src/features/sipa/loadDepositFacts").DepositTokenOption[],
)
// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({ availableAtomic: 40_000n * 10n ** 18n }))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent,
  fireOnboardingEvent: fireEvent,
}))
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))
// One instance, like the session's: the screen keys effects off its identity.
const gateway = { depositAddress }
vi.mock("../../../src/features/sipa/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../support/depositTokens")
  const own = singleToken(MANIFEST_TOKEN, "TEST")
  return mockLoadDepositFacts(
    importOriginal,
    () => ({
      ...own,
      options: [...own.options, ...extraCoins],
      offered: [...own.offered, ...extraCoins],
    }),
    async () => ({
      fee: "0.25",
      token: MANIFEST_TOKEN,
      sweepFeeAtomic: 250_000_000_000_000_000n,
      txAmountCap: 5166n * 10n ** 18n,
    }),
  )
})
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// A test's own target stands in for the registration's, so the screen's handling of a target is
// tested apart from how a registration makes one.
const targeted = vi.hoisted(() => ({
  target: undefined as import("../../../src/features/sipa/depositTarget").DepositTarget | undefined,
}))
vi.mock("../../../src/features/registration/registrationDepositTarget", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../../../src/features/registration/registrationDepositTarget")
  >()
  return {
    useRegistrationDepositTarget: (
      ...args: Parameters<typeof real.useRegistrationDepositTarget>
    ) => {
      const made = real.useRegistrationDepositTarget(...args)
      return targeted.target ?? made
    },
  }
})

const { DepositScreen } = await import("../../../src/features/deposit/DepositScreen/DepositScreen")
const { backToMethod, openDepositSheet, toDepositCoinStep } = await import(
  "../../support/depositFlow"
)
const { setIdentity } = await import("../../support/identity")
const noClaim = () => async () => {}
const { seedRegistration } = await import("../../support/registrationFixtures")
const { AddressesPublishingError } = await import(
  "../../../src/features/deposit/addressesPublishing"
)
const { defaultConfig } = await import("../../support/page")
const { provideFakeDepositRail } = await import("../../support/fakeDepositRail")
import { PAID_ASK, RANDOM, usd } from "../../support/registrationPrices"

/**
 * The deposit gates are effectful, not cosmetic: no address may be derived or published while the
 * tag is unconfirmed. A settled tag reads the pool on open and derives one on the coin row, which
 * opens the address sheet.
 */
const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")
const { writeDeviceKeys } = await import("../../../src/platform/storage/deviceKeys")
const { testPage } = await import("../../support/page")
const deviceDb = testPage().database
const { fakeL1Wallet, withL1Wallet } = await import("../../support/fakeL1Wallet")
let wallet: ReturnType<typeof fakeL1Wallet>
beforeEach(async () => {
  // An account's session: a visitor's files no registration.
  await writeDeviceKeys(deviceDb, { storageId: "a1" })
  const session = openTestSession({
    wallet: aztec.obsidionWallet,
    contractService: {},
    account: { getAddress: () => "0xaztec" },
    sipaAddresses: gateway,
  })
  wallet = fakeL1Wallet()
  withL1Wallet(session, wallet.wallet)
  await session.registrations.ready
})
afterEach(closeSession)

describe("DepositScreen — claiming gate", () => {
  let container: HTMLDivElement
  let root: Root

  let seeded: PendingRegistrationRecord
  /** Lays `patch` over the seeded record, as the writers would leave it. */
  const patch = (fields: Partial<PendingRegistrationRecord>) =>
    seedRegistration((seeded = { ...seeded, ...fields }))
  const saveTerms = (terms: RegistrationTerms) => patch({ terms })

  async function seedPendingClaim(
    over: { fundedAt?: number; l1ChainId?: number; broadcast?: boolean } = { fundedAt: Date.now() },
  ) {
    localStorage.clear()
    seeded = {
      account: ACCOUNT,
      tag: "alice",
      nameHash: `0x${"77".repeat(32)}` as Hex,
      l2Address: L2_ADDRESS,
      l1ChainId: 11155111,
      sipaAddress: `0x${"5a".repeat(20)}`,
      fee: String(RANDOM.fee),
      beneficiary: ACCOUNT as Hex,
      depositToken: `0x${"bb".repeat(20)}` as Hex,
      broadcast: true,
      phase: "awaiting_deposit",
      retries: 0,
      startTime: Date.now(),
      ...over,
    }
    await seedRegistration(seeded)
    await setIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1, pending: true })
    return {
      close: () => patch({ phase: "confirmed", endTime: Date.now() }),
      upsert: patch,
    }
  }

  /** `start` opens on the flow's first step, whose picks lead to the method step. */
  const render = (start = false) =>
    act(async () => {
      root.render(
        <MemoryRouter
          initialEntries={[{ pathname: "/deposit", state: start ? { startDeposit: true } : null }]}
        >
          <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
            <DepositScreen claimName={noClaim} />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })

  const coinRow = () =>
    container.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-TEST']")
  const openCoin = async () => {
    const row = coinRow()
    if (row) await act(async () => row.click())
    else await openDepositSheet("TEST")
  }
  const tagRow = () => container.querySelector("[data-testid='deposit-tag-row']")
  // The funding sheet's amount field: the sheet is a step of the deposit flow's dialog.
  const fundSheet = () => document.querySelector("[aria-label='Amount to send']")

  /** First visit opens the privacy disclaimer in front of the coin list. */
  const dismissDisclaimer = () =>
    act(async () => {
      const gotIt = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Got it!",
      )
      gotIt?.click()
    })

  let check: ReturnType<typeof provideFakeDepositRail>
  beforeEach(() => {
    vi.clearAllMocks()
    held.mockResolvedValue(0n)
    check = provideFakeDepositRail({
      addresses: () => ["0xdeadbeef", `0x${"5a".repeat(20)}`, "0xfeedbeef"],
      held,
      token: () => MANIFEST_TOKEN as Hex,
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("derives nothing while the tag is unconfirmed, then shows an address on its own once it settles", async () => {
    const store = await seedPendingClaim()
    await render()

    expect(container.textContent).toContain("still being claimed")
    expect(container.querySelector("[data-testid='deposit-registration-ask']")).toBeNull()
    expect(tagRow()).toBeNull()
    expect(depositAddress).not.toHaveBeenCalled()

    // Confirmation is the record's close, whose listener re-renders this screen.
    await act(async () => {
      await store.close()
    })

    expect(container.textContent).not.toContain("still being claimed")
    expect(tagRow()).toBeNull()
    // Settling reads the pool, which is empty, and derives nothing: generation waits for the coin row.
    expect(depositAddress).toHaveBeenCalledTimes(1)
    expect(depositAddress).toHaveBeenLastCalledWith("alice", {
      onStage: expect.any(Function),
      publishingLimit: 0,
      signal: expect.any(AbortSignal),
    })
    expect(container.innerHTML).not.toContain("0xdeadbeef")

    await openCoin()
    expect(depositAddress).toHaveBeenCalledTimes(2)
    expect(depositAddress).toHaveBeenLastCalledWith("alice", {
      onStage: expect.any(Function),
      publishingLimit: 2,
      signal: expect.any(AbortSignal),
    })
    expect(container.textContent).toContain("0xdeadbeef")
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Generate",
    )
  })

  it("holds the connect-wallet rail while the tag is unconfirmed", async () => {
    await seedPendingClaim()
    await render()

    // The claim hold covers the connected-wallet rail too: nothing opens a picker or resolves an
    // address while the name is still landing.
    expect(container.textContent).toContain("still being claimed")
    expect(container.querySelector("[data-testid='deposit-connect-link']")).toBeNull()
    expect(depositAddress).not.toHaveBeenCalled()
  })

  it("shows the registration's own address from the coins while the name is owed its deposit", async () => {
    await seedPendingClaim({ l1ChainId: defaultConfig.l1ChainId, broadcast: false })
    await render()
    await dismissDisclaimer()

    expect(container.textContent).not.toContain("still being claimed")
    expect(container.querySelector("[data-testid='deposit-registration-ask']")?.textContent).toBe(
      `Deposit at least ${usd(PAID_ASK)} to activate your account.`,
    )
    expect(tagRow()?.textContent).toBe("Your name@aliceChoose your own")
    expect(fireEvent).toHaveBeenCalledWith("registration_deposit_opened")
    expect(fireEvent).toHaveBeenCalledWith("deposit_sheet_opened", { registration: true })
    await act(async () => tagRow()!.querySelector("button")!.click())
    expect(document.querySelector("dialog[aria-label='Choose your name']")).not.toBeNull()
    expect(fireEvent).toHaveBeenCalledWith("name_sheet_opened", { screen: "deposit" })

    // No address, and no broadcast, until the drawn tag is kept; keeping it locks the tag.
    expect(coinRow()).toBeNull()
    const keep = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Keep @alice",
    )
    await act(async () => keep!.click())
    expect(tagRow()?.textContent).toBe("Your name@alice")
    await openCoin()
    expect(container.innerHTML).toContain(`0x${"5a".repeat(20)}`)
    // The registration's address reports from its record's creation, never as a plain deposit's.
    expect(fireEvent.mock.calls.map(([e]) => e)).not.toContain("deposit_address_shown")
    expect(container.querySelector("[data-testid='activation-sheet']")).toBeNull()

    const connect = container.querySelector<HTMLButtonElement>(
      "[data-testid='deposit-connect-link']",
    )
    expect(connect!.disabled).toBe(false)
    await act(async () => connect!.click())
    expect(depositAddress).not.toHaveBeenCalled()
  })

  it("goes Home when the registration's funds land, instead of turning into a plain deposit", async () => {
    const store = await seedPendingClaim({ l1ChainId: defaultConfig.l1ChainId, broadcast: false })
    await render()
    expect(tagRow()).not.toBeNull()
    expect(navigate).not.toHaveBeenCalledWith("/", { replace: true })

    await act(async () => {
      await store.upsert({ fundedAt: Date.now() })
    })
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("sends an owed registration the deposit screen cannot take to its pending step", async () => {
    // A lapsed quote needs a re-sign, which only the pending step runs.
    await seedPendingClaim({ l1ChainId: defaultConfig.l1ChainId })
    await saveTerms({ deadline: 1 })
    await render()

    expect(container.textContent).toContain("Registration needs a checkCheck on @alice")
    expect(coinRow()).toBeNull()
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid='deposit-claiming']")!.click(),
    )
    expect(navigate).toHaveBeenCalledWith("/claim/alice")
    expect(depositAddress).not.toHaveBeenCalled()
  })

  it("encodes an EIP-681 transfer URI so a wallet scan pre-fills send", async () => {
    localStorage.clear()
    await setIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    await render()
    await dismissDisclaimer()

    await openCoin()

    // Desktop layout: the code sits in the sheet.
    const qr = container.querySelector("[aria-label='Deposit address QR code']")
    expect(qr?.innerHTML).toContain(
      `ethereum:${MANIFEST_TOKEN}@${defaultConfig.l1ChainId}/transfer?address=0xdeadbeef`,
    )
  })

  it("keeps a registration address short of its floor waiting instead of spotting it", async () => {
    await seedPendingClaim({ l1ChainId: defaultConfig.l1ChainId })
    // The earned schedule's minimum is above the 0.1 cut, so its floor is the fee plus the minimum.
    const floor = RANDOM.fee + RANDOM.min
    await saveTerms({
      deadline: 0,
      fee: String(RANDOM.fee),
      minDeposit: String(RANDOM.min),
      feeWaived: true,
    })
    vi.useFakeTimers()
    try {
      await render()
      await dismissDisclaimer()
      await openCoin()
      held.mockResolvedValue(floor - 1n)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(check).toHaveBeenCalled()
      expect(container.textContent).not.toContain("spotted")
      expect(fireEvent).not.toHaveBeenCalledWith("deposit_funded", expect.anything())
      // At the floor the sweep accepts it, so the screen spots it.
      held.mockResolvedValue(floor)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(fireEvent).toHaveBeenCalledWith("deposit_funded", expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it("carries one connect click through to the funding sheet when the wallet lands", async () => {
    localStorage.clear()
    await setIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    // A pool hit gives the sheet an address to fund without a derivation.
    depositAddress.mockResolvedValueOnce({ address: "0xp001ed", name: "alice.oxide.eth" })
    await render(true)
    await openCoin()

    const connect = await backToMethod()
    await act(async () => connect!.click())

    // The wallet picker is open and there is still nothing to fund from.
    await act(async () => wallet.set({ connecting: true }))
    expect(fundSheet()).toBeNull()

    // The account arrives a render later; the held intent opens the sheet with no second click.
    await act(async () => wallet.connect(ACCOUNT))
    expect(fundSheet()).not.toBeNull()
  })
})

/**
 * A registration's target takes the place of a fresh deposit address: it names the fee and the least
 * to send, and hears when funds land.
 */
describe("DepositScreen — a target", () => {
  let container: HTMLDivElement
  let root: Root
  const onFunded = vi.fn()
  const fee = 5n * 10n ** 17n
  const target = (
    over: Partial<import("../../../src/features/sipa/depositTarget").DepositTarget> = {},
  ): import("../../../src/features/sipa/depositTarget").DepositTarget => ({
    kind: "registration",
    address: { address: "0xfeedbeef", name: "alice" },
    fee,
    floor: fee + 1n,
    ask: 10n ** 18n,
    onFunded,
    onShown: () => {},
    ...over,
  })
  const render = (shown: ReturnType<typeof target>) =>
    act(async () => {
      targeted.target = shown
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
            <DepositScreen claimName={noClaim} onClose={() => {}} />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })
  const press = (title: string) =>
    act(async () =>
      [...document.querySelectorAll("button")].find((b) => b.textContent === title)!.click(),
    )

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await setIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    targeted.target = undefined
    container.remove()
  })

  it("rounds the floor up in a coin with fewer decimals, so a fee-only balance still waits", async () => {
    extraCoins.push(tokenOption("USDC", MAINNET_USDC, 6, MANIFEST_TOKEN))
    vi.useFakeTimers()
    try {
      await render(target())
      await toDepositCoinStep()
      await act(async () =>
        document.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-select']")!.click(),
      )
      await act(async () =>
        document.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-USDC']")!.click(),
      )
      await press("Continue")
      held.mockResolvedValue(fee)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(onFunded).not.toHaveBeenCalled()
    } finally {
      extraCoins.length = 0
      held.mockResolvedValue(0n)
      vi.useRealTimers()
    }
  })

  it("spots funds only at the target's floor, and tells the target", async () => {
    vi.useFakeTimers()
    provideFakeDepositRail({
      addresses: () => ["0xfeedbeef"],
      held,
      token: () => MANIFEST_TOKEN as Hex,
    })
    try {
      await render(target())
      await toDepositCoinStep()
      await press("Continue")
      held.mockResolvedValue(fee)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(onFunded).not.toHaveBeenCalled()
      held.mockResolvedValue(fee + 1n)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(onFunded).toHaveBeenCalledWith(fee + 1n, 18)
      expect(fireEvent).toHaveBeenCalledWith("deposit_funded", {
        funding: "external",
        amount_bucket: expect.anything(),
        registration: true,
      })
    } finally {
      held.mockResolvedValue(0n)
      vi.useRealTimers()
    }
  })
})
