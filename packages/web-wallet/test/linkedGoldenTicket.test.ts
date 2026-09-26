import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  CLAIM_STASH_KEY,
  peekTicketSignup,
  stashClaimLink,
  stashTicketSignup,
} from "../src/features/paylink/claimStash"
import type { WebWalletConfig } from "../src/config/env"

const h = vi.hoisted(() => ({
  redeem: vi.fn(),
  fundingCut: vi.fn(async () => 0n),
}))

vi.mock("../src/features/onboarding/goldenTicket", () => ({
  redeemGoldenTicketForLink: h.redeem,
}))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ portal: "0x00000000000000000000000000000000000000f0" }),
  l1PublicClient: () => ({}),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readFpcFundingCut: h.fundingCut,
}))
vi.mock("../src/features/fees/fpcFundingCut", () => ({
  currentFpcFundingCut: () => h.fundingCut(),
}))

const { redeemLinkedGoldenTicket } = await import("../src/features/onboarding/oxideOnboarding")

const keys = {
  account: { getAddress: () => ({ toString: () => "0x1" }) },
  secretKey: { toString: () => "0x11" },
  authProvider: {},
  pubkeyHex: "0x22",
} as never

const config = { accountServiceUrl: "http://127.0.0.1:5060" } as WebWalletConfig
const wallet = { wallet: true } as never
const DAI = 10n ** 18n
const ticket = () =>
  stashTicketSignup({
    fragment: "paylink-frag",
    threshold: (2n * DAI).toString(),
    schedule: { fee: (DAI / 2n).toString(), minDeposit: "0" },
  })

describe("redeemLinkedGoldenTicket", () => {
  beforeEach(() => {
    h.redeem.mockReset()
    sessionStorage.clear()
  })

  it("no-ops without a ticket handed in", async () => {
    await expect(redeemLinkedGoldenTicket(keys, config, undefined, null)).resolves.toBe("none")
    expect(h.redeem).not.toHaveBeenCalled()
  })

  it("leaves a link stashed for an ordinary claim on Home alone", async () => {
    stashClaimLink("paylink-frag")
    await expect(redeemLinkedGoldenTicket(keys, config, wallet, peekTicketSignup())).resolves.toBe(
      "none",
    )
    expect(h.redeem).not.toHaveBeenCalled()
  })

  it("never reads a marker the hosting wizard did not hand in", async () => {
    ticket()
    await expect(redeemLinkedGoldenTicket(keys, config, wallet, null)).resolves.toBe("none")
    expect(h.redeem).not.toHaveBeenCalled()
  })

  it("throws when the ticket signup's PXE wallet is not ready", async () => {
    ticket()
    await expect(
      redeemLinkedGoldenTicket(keys, config, undefined, peekTicketSignup()),
    ).rejects.toThrow(/wallet is still starting/)
    expect(h.redeem).not.toHaveBeenCalled()
  })

  it("reports a network that paused tickets, leaving the stash for the wizard to settle", async () => {
    ticket()
    h.redeem.mockResolvedValueOnce({ status: "unavailable", amount: 20n * DAI })
    await expect(redeemLinkedGoldenTicket(keys, config, wallet, peekTicketSignup())).resolves.toBe(
      "unavailable",
    )
    expect(peekTicketSignup()).toMatchObject({
      fragment: "paylink-frag",
      amount: (20n * DAI).toString(),
    })
  })

  it("throws when the ticket cannot be redeemed, naming the reason", async () => {
    ticket()
    const redeem = () => redeemLinkedGoldenTicket(keys, config, wallet, peekTicketSignup())
    h.redeem.mockResolvedValueOnce({ status: "below_threshold", amount: DAI })
    await expect(redeem()).rejects.toThrow(/below the amount that waives/)
    h.redeem.mockResolvedValueOnce({ status: "cannot_cover", amount: DAI })
    await expect(redeem()).rejects.toThrow(/cannot cover the account deposit/)
  })

  it("prices the burn from the advertised schedule at the live cut before the ticket is spent, and keeps the amount", async () => {
    ticket()
    h.fundingCut.mockResolvedValue(DAI / 10n)
    h.redeem.mockImplementationOnce(
      async (args: {
        covers: (amount: bigint, advertised?: { fee: bigint; min: bigint }) => Promise<boolean>
      }) => {
        const advertised = { fee: DAI / 2n, min: 0n }
        // Burn at a 0.1 cut on each leg: 0.5 fee + 0.1 return cut + 0.01 remainder, then 0.1
        // withdrawal cut + 0.1 relayer + 1 prover = 1.81 DAI.
        expect(await args.covers((181n * DAI) / 100n, advertised)).toBe(false)
        expect(await args.covers((181n * DAI) / 100n + 1n, advertised)).toBe(true)
        // An unadvertised schedule prices nothing, so nothing is spent on it.
        expect(await args.covers(20n * DAI, undefined)).toBe(false)
        return { status: "created", amount: 20n * DAI }
      },
    )
    await expect(redeemLinkedGoldenTicket(keys, config, wallet, peekTicketSignup())).resolves.toBe(
      "redeemed",
    )
    expect(peekTicketSignup()?.amount).toBe((20n * DAI).toString())
    expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
  })
})
