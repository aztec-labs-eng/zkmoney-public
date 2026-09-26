/**
 * Whether a link being created can carry a cash-out voucher.
 *
 * The gift is a second transaction out of the creator's own daily allowance, so promising one the
 * allowance cannot cover would fail the whole create — the link would never exist. The read is
 * therefore conservative, and a creator who is not subscribed yet counts as able: their create
 * batch subscribes and the whole allowance opens with it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ network: "sandbox" }),
}))
const { claimSponsorRail } = vi.hoisted(() => ({
  claimSponsorRail: vi.fn(async (_deps: unknown, rail: string) => ({
    sponsor: { fpcAddress: {}, fpcArtifact: {}, railId: rail === "voucher" ? 2 : 1 },
    rail: {},
  })),
}))
vi.mock("../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorRail,
  claimSponsorContext: vi.fn(),
  noteSubscribed: vi.fn(),
}))
const { claimFpcSubscriptionUses, hasClaimFpcSubscription } = vi.hoisted(() => ({
  claimFpcSubscriptionUses: vi.fn(async () => 0),
  hasClaimFpcSubscription: vi.fn(async () => true),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  claimFpcSubscriptionUses,
  hasClaimFpcSubscription,
}))

const { voucherAvailable } = await import("../src/features/paylink/sponsoredPaylink")

const deps = { wallet: {}, account: { getAddress: () => ({}) }, contractService: {} } as never

describe("voucherAvailable", () => {
  beforeEach(() => vi.clearAllMocks())

  it("gifts when the allowance covers the create and the gift both", async () => {
    claimFpcSubscriptionUses.mockResolvedValueOnce(2)
    expect(await voucherAvailable(deps)).toBe(true)
  })

  it("withholds the gift when only the create itself is covered", async () => {
    claimFpcSubscriptionUses.mockResolvedValueOnce(1)
    expect(await voucherAvailable(deps)).toBe(false)
  })

  it("gifts for a creator whose first batch is the one that subscribes them", async () => {
    // A stored 0 is either "no note yet" or "spent today"; only the subscription read separates them.
    claimFpcSubscriptionUses.mockResolvedValueOnce(0)
    hasClaimFpcSubscription.mockResolvedValueOnce(false)
    expect(await voucherAvailable(deps)).toBe(true)
  })

  it("withholds the gift from a subscriber who has spent today's allowance", async () => {
    claimFpcSubscriptionUses.mockResolvedValueOnce(0)
    hasClaimFpcSubscription.mockResolvedValueOnce(true)
    expect(await voucherAvailable(deps)).toBe(false)
  })

  it("withholds the gift where the deployment offers no voucher rail", async () => {
    // `railByName` throws on a name the manifest does not carry — an older deployment.
    claimSponsorRail.mockRejectedValueOnce(new Error("no rail named voucher"))
    expect(await voucherAvailable(deps)).toBe(false)
  })

  it("withholds the gift when the allowance cannot be read", async () => {
    claimFpcSubscriptionUses.mockRejectedValueOnce(new Error("PXE is busy"))
    expect(await voucherAvailable(deps)).toBe(false)
  })
})
