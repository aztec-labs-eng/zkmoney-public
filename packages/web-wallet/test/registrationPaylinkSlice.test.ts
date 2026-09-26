import { beforeEach, describe, expect, it, vi } from "vitest"
import { PendingRegistrationStore } from "@obsidion/front-core"
import { GOLDEN_TICKET_PROVER_TIP, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"
import { saveRegistrationTerms } from "../src/features/onboarding/registrationTerms"

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const CUT = dai(0.1)
const h = vi.hoisted(() => ({
  fundingCut: vi.fn(async () => 100_000_000_000_000_000n),
  frozen: vi.fn(async () => false),
  portal: { address: `0x${"11".repeat(20)}` },
}))
vi.mock("@obsidion/sdk", async (original) => ({
  ...(await original<typeof import("@obsidion/sdk")>()),
  readFpcFundingCut: h.fundingCut,
}))
vi.mock("../src/config/env", async (original) => ({
  ...(await original<typeof import("../src/config/env")>()),
  getConfig: () => ({ network: "sandbox" }),
}))
vi.mock("../src/config/oxideTuple", async (original) => ({
  ...(await original<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ portal: h.portal.address }),
  // The portal state the sdk's relayer-tip check reads before the burn.
  l1PublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "$frozen" ? h.frozen() : 100_000_000_000_000_000n,
  }),
}))
const { registrationSlice, RegistrationFundingError } = await import(
  "../src/features/paylink/sponsoredPaylink"
)
const account = `0x${"aa".repeat(20)}`
const l2Address = `0x${"bb".repeat(32)}` as const
const sipaAddress = `0x${"cc".repeat(20)}` as const
const deps = { account: { getAddress: () => ({ toString: () => l2Address }) } } as never
const noteAmount = dai(3)
const store = PendingRegistrationStore.get(webStorage)
/** Fee 0.5, no minimum, both cuts 0.1: SIPA target 0.61, burn 1.81, return 0.01. */
const BURN = dai(1.81)

const terms = (overrides: Partial<Parameters<typeof saveRegistrationTerms>[0]> = {}) =>
  saveRegistrationTerms({
    account,
    tag: "alice",
    deadline: 4102444800,
    fee: String(dai(0.5)),
    minDeposit: "0",
    feeWaived: true,
    paylinkFunded: true,
    paylinkId: "id:link",
    ...overrides,
  })

async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (err) {
    if (err instanceof RegistrationFundingError) return err.reason
    throw err
  }
  return "claimed"
}

let portals = 0
beforeEach(async () => {
  localStorage.clear()
  await store.load()
  vi.clearAllMocks()
  h.fundingCut.mockResolvedValue(CUT)
  // A fresh portal per test: the cut reader caches one read per deployment.
  h.portal.address = `0x${String(++portals).padStart(40, "0")}`
  await store.upsert(
    account,
    {},
    {
      tag: "alice",
      nameHash: `0x${"dd".repeat(32)}`,
      l2Address,
      l1ChainId: 31337,
      sipaAddress,
      depositToken: `0x${"ee".repeat(20)}`,
      broadcast: true,
      phase: "awaiting_deposit",
      retries: 0,
      startTime: Date.now(),
    },
  )
  terms()
})

describe("paylink registration funding", () => {
  it("never burns for an ordinary claim, even with an unfunded pending reservation", async () => {
    expect(await registrationSlice(deps, noteAmount, false)).toBeUndefined()
    expect(h.fundingCut).not.toHaveBeenCalled()
    // A second ordinary claim before L1 finalization must also retain its entire note.
    expect(await registrationSlice(deps, noteAmount, false)).toBeUndefined()
  })

  it("burns the two-cut quote to the reserved SIPA when asked to fund it", async () => {
    const slice = await registrationSlice(deps, noteAmount, true)
    expect(slice?.l1Recipient.toString().toLowerCase()).toBe(sipaAddress)
    expect(slice?.amount).toBe(BURN)
    expect(slice?.relayerTip).toBe(WITHDRAW_RELAYER_TIP)
    expect(slice?.proverTip).toBe(GOLDEN_TICKET_PROVER_TIP)
    expect(slice?.fundingCut).toBe(CUT)
    expect(slice?.target).toBe(dai(0.61))
    expect(slice?.withdrawal).toEqual({
      tuple: { portal: h.portal.address },
      portal: { fpcFundingCut: CUT, frozen: false },
    })
  })

  it("refuses lapsed terms and an unpublished address before pricing anything", async () => {
    const lapsed = Math.floor(Date.now() / 1000) - 60
    terms({ deadline: lapsed })
    expect(await refusal(registrationSlice(deps, noteAmount, true))).toBe("expired")
    // The clock the caller passes decides, not the wall clock alone.
    expect((await registrationSlice(deps, noteAmount, true, lapsed * 1000 - 1))?.amount).toBe(BURN)
    terms()
    await store.upsert(account, { broadcast: false })
    expect(await refusal(registrationSlice(deps, noteAmount, true))).toBe("unpublished")
    expect(h.fundingCut).toHaveBeenCalledOnce()
    // A deadline of zero is a stamp with no reservation behind it, not a lapse.
    await store.upsert(account, { broadcast: true })
    terms({ deadline: 0 })
    expect((await registrationSlice(deps, noteAmount, true))?.amount).toBe(BURN)
  })

  it("funds a signed minimum above the cut once, never on top of the cut", async () => {
    terms({ minDeposit: String(dai(1)) })
    const slice = await registrationSlice(deps, noteAmount, true)
    expect(slice?.amount).toBe(dai(2.7))
  })

  it("burns less at a zero cut", async () => {
    h.fundingCut.mockResolvedValue(0n)
    const slice = await registrationSlice(deps, noteAmount, true)
    expect(slice?.amount).toBe(dai(1.61))
  })

  it("refuses a note that only equals the burn, and takes one a wei over it", async () => {
    expect(await refusal(registrationSlice(deps, BURN, true))).toBe("uncovered")
    expect((await registrationSlice(deps, BURN + 1n, true))?.amount).toBe(BURN)
  })

  it("refuses to price the burn while the cut is unread", async () => {
    h.fundingCut.mockRejectedValue(new Error("rpc down"))
    expect(await refusal(registrationSlice(deps, noteAmount, true))).toBe("unpriced")
  })

  it("refuses to burn while the portal's withdrawal state is unread", async () => {
    // The sdk's relayer-tip check needs it; a burn without it could not be released.
    h.frozen.mockRejectedValueOnce(new Error("rpc down"))
    const err = await registrationSlice(deps, noteAmount, true).catch((e: Error) => e)
    expect(err).toBeInstanceOf(RegistrationFundingError)
    expect((err as InstanceType<typeof RegistrationFundingError>).reason).toBe("unpriced")
    expect((err as Error).message).toMatch(/withdrawal state/)
  })

  it("refuses an unknown note amount", async () => {
    expect(await refusal(registrationSlice(deps, undefined, true))).toBe("unpriced")
  })

  it("refuses a registration with no signed schedule instead of guessing one", async () => {
    terms({ fee: undefined, minDeposit: undefined })
    expect(await refusal(registrationSlice(deps, noteAmount, true))).toBe("no_schedule")
    terms({ fee: "0", minDeposit: "0" })
    expect(await refusal(registrationSlice(deps, noteAmount, true))).toBe("no_schedule")
  })

  it("refuses when no registration waits for the deposit", async () => {
    await store.remove(account)
    expect(await refusal(registrationSlice(deps, noteAmount, true))).toBe("no_registration")
  })

  it("refuses terms no paylink funds, whatever the waiver flag says, before reading anything", async () => {
    terms({ fee: String(dai(10)), minDeposit: String(dai(5)), paylinkFunded: false })
    expect(await refusal(registrationSlice(deps, noteAmount, true))).toBe("not_ticket")
    terms({ paylinkFunded: false })
    expect(await refusal(registrationSlice(deps, noteAmount, true))).toBe("not_ticket")
    localStorage.clear()
    expect(await refusal(registrationSlice(deps, noteAmount, true))).toBe("not_ticket")
    expect(h.fundingCut).not.toHaveBeenCalled()
  })

  it("refuses a binding the last renewal blocked", async () => {
    terms({ paylinkBlocked: true })
    expect(await refusal(registrationSlice(deps, noteAmount, true))).toBe("blocked")
    expect(h.fundingCut).not.toHaveBeenCalled()
  })
})
