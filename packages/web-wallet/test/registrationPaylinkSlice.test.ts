import { beforeEach, describe, expect, it, vi } from "vitest"
import { PendingRegistrationStore } from "@obsidion/front-core"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"
import {
  commitRegistrationProverTip,
  rememberReissuedClaim,
  saveRegistrationTerms,
  type RegistrationTerms,
} from "../src/features/onboarding/registrationTerms"
import {
  dai,
  earnedTerms,
  FAR_DEADLINE,
  pendingRecord,
  ticketBoundTerms,
} from "./support/registrationFixtures"

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
/** Fee 0.5, no minimum, both cuts 0.1, no prover tip: SIPA target 0.61, burn 0.81, return 0.01. */
const BURN = dai(0.81)

const terms = (over: Partial<RegistrationTerms> = {}) =>
  saveRegistrationTerms(
    ticketBoundTerms({
      account,
      tag: "alice",
      deadline: Number(FAR_DEADLINE),
      paylinkId: "id:link",
      ...over,
    }),
  )
/** The slice a ticket-funded claim of `note` burns. */
const fund = (note = noteAmount, nowMs?: number) => registrationSlice(deps, note, true, nowMs)

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
    pendingRecord({ account, tag: "alice", l2Address, l1ChainId: 31337, sipaAddress }),
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
    const slice = await fund()
    expect(slice?.l1Recipient.toString().toLowerCase()).toBe(sipaAddress)
    expect(slice?.amount).toBe(BURN)
    expect(slice?.relayerTip).toBe(WITHDRAW_RELAYER_TIP)
    expect(slice?.proverTip).toBe(0n)
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
    expect(await refusal(fund())).toBe("expired")
    // The clock the caller passes decides, not the wall clock alone.
    expect((await fund(noteAmount, lapsed * 1000 - 1))?.amount).toBe(BURN)
    terms()
    await store.upsert(account, { broadcast: false })
    expect(await refusal(fund())).toBe("unpublished")
    expect(h.fundingCut).toHaveBeenCalledOnce()
    // A deadline of zero is a stamp with no reservation behind it, not a lapse.
    await store.upsert(account, { broadcast: true })
    terms({ deadline: 0 })
    expect((await fund())?.amount).toBe(BURN)
  })

  it("funds a signed minimum above the cut once, never on top of the cut", async () => {
    terms({ minDeposit: String(dai(1)) })
    expect((await fund())?.amount).toBe(dai(1.7))
  })

  it("burns less at a zero cut", async () => {
    h.fundingCut.mockResolvedValue(0n)
    expect((await fund())?.amount).toBe(dai(0.61))
  })

  it("burns the prover tip the review committed, and none when it committed nothing", async () => {
    commitRegistrationProverTip(account, "alice", dai(0.4), "faster")
    const tipped = await fund()
    expect(tipped?.proverTip).toBe(dai(0.4))
    expect(tipped?.amount).toBe(BURN + dai(0.4))
    // The SIPA's target does not move: the portal keeps the tip.
    expect(tipped?.target).toBe(dai(0.61))
    commitRegistrationProverTip(account, "alice", 0n, "faster")
    expect((await fund())?.proverTip).toBe(0n)
  })

  it("keeps the committed tip through a renewal", async () => {
    commitRegistrationProverTip(account, "alice", dai(0.4), "faster")
    rememberReissuedClaim(
      { account, tag: "alice", fee: String(dai(0.5)) },
      {
        hold: { deadline: "4102444900" },
        terms: earnedTerms({ minDeposit: "0", ticket: true }),
      },
    )
    expect((await fund())?.proverTip).toBe(dai(0.4))
  })

  it.each([
    ["no tip", 0n],
    ["the committed tip", dai(0.4)],
  ])(
    "refuses a note that only equals the burn with %s, and takes one a wei over it",
    async (_, tip) => {
      commitRegistrationProverTip(account, "alice", tip, "faster")
      expect(await refusal(fund(BURN + tip))).toBe("uncovered")
      expect((await fund(BURN + tip + 1n))?.amount).toBe(BURN + tip)
    },
  )

  it.each([
    ["the cut is unread", () => h.fundingCut.mockRejectedValue(new Error("rpc down")), noteAmount],
    ["the note amount is unknown", () => {}, undefined],
  ])("refuses to price the burn while %s", async (_, arrange, note) => {
    arrange()
    expect(await refusal(registrationSlice(deps, note, true))).toBe("unpriced")
  })

  it("refuses to burn while the portal's withdrawal state is unread", async () => {
    // The sdk's relayer-tip check needs it; a burn without it could not be released.
    h.frozen.mockRejectedValueOnce(new Error("rpc down"))
    const err = await fund().catch((e: Error) => e)
    expect(err).toBeInstanceOf(RegistrationFundingError)
    expect((err as InstanceType<typeof RegistrationFundingError>).reason).toBe("unpriced")
    expect((err as Error).message).toMatch(/withdrawal state/)
  })

  it("refuses a registration with no signed schedule instead of guessing one", async () => {
    terms({ fee: undefined, minDeposit: undefined })
    expect(await refusal(fund())).toBe("no_schedule")
    terms({ fee: "0", minDeposit: "0" })
    expect(await refusal(fund())).toBe("no_schedule")
  })

  it("refuses when no registration waits for the deposit", async () => {
    await store.remove(account)
    expect(await refusal(fund())).toBe("no_registration")
  })

  it("refuses terms no paylink funds, whatever the waiver flag says, before reading anything", async () => {
    terms({ fee: String(dai(10)), minDeposit: String(dai(5)), paylinkFunded: false })
    expect(await refusal(fund())).toBe("not_ticket")
    terms({ paylinkFunded: false })
    expect(await refusal(fund())).toBe("not_ticket")
    localStorage.clear()
    expect(await refusal(fund())).toBe("not_ticket")
    expect(h.fundingCut).not.toHaveBeenCalled()
  })

  it("refuses a binding the last renewal blocked", async () => {
    terms({ paylinkBlocked: true })
    expect(await refusal(fund())).toBe("blocked")
    expect(h.fundingCut).not.toHaveBeenCalled()
  })
})
