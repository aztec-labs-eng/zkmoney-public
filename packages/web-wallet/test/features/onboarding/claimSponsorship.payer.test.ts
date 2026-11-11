// @vitest-environment node
/**
 * Which account a sponsored batch names as its payer: the one the resolver returns when it holds
 * the rail's note, else the acting account on its own note, else the acting account subscribing.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

const { loadClaimFpcPolicy, registerSponsorFpc, hasClaimFpcSubscription } = vi.hoisted(() => ({
  loadClaimFpcPolicy: vi.fn(),
  registerSponsorFpc: vi.fn(),
  hasClaimFpcSubscription: vi.fn(),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  claimFpcPolicySponsorsAnyCall: () => true,
  loadClaimFpcPolicy,
  registerSponsorFpc,
  hasClaimFpcSubscription,
}))
const { collectOnboardingKeys, buildClaimSubscribeWitness } = vi.hoisted(() => ({
  collectOnboardingKeys: vi.fn(),
  buildClaimSubscribeWitness: vi.fn(),
}))
vi.mock("../../../src/session/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/session/account")>()),
  collectOnboardingKeys,
}))
vi.mock("../../../src/features/registration/registrationDeps", () => ({
  buildClaimSubscribeWitness,
}))

import {
  claimSponsorContext,
  noteSubscribed,
  type SponsorAccounts,
} from "../../../src/features/registration/claimSponsorship"
import { RAIL_REGISTERED } from "../../../src/features/registration/rails"
import { closeSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"
import { seedDeviceKeys } from "../../support/page"

const RAIL = { railId: 1, name: RAIL_REGISTERED, gate: "nameClaim", policy: { root: "0xp" } }
const REGISTERED = { name: "ClaimFPC:registered" }

const address = (s: string) => ({ toString: () => s })
const account = (at: string) => ({ getAddress: () => address(at) } as never)
let fpcSerial = 0

/** One instance per case: a subscribed answer is memoized per (account, instance, rail). */
async function setup(subscribed: string[], accounts: SponsorAccounts) {
  vi.clearAllMocks()
  const fpc = `0x${(0x1000 + ++fpcSerial).toString(16).padStart(64, "0")}`
  loadClaimFpcPolicy.mockResolvedValue({ rail: RAIL, fpcAddress: address(fpc) })
  registerSponsorFpc.mockResolvedValue(REGISTERED)
  hasClaimFpcSubscription.mockImplementation(async (_w, _f, _a, user: { toString(): string }) =>
    subscribed.includes(user.toString()),
  )
  await seedDeviceKeys({ storageId: "a1" })
  const session = openTestSession()
  const { nameClaims } = session
  for (const { getAddress } of [accounts.payer, accounts.acting] as never as {
    getAddress: () => { toString(): string }
  }[])
    await nameClaims.put({
      address: getAddress().toString(),
      handle: "tag",
      signature: "0xs",
      nonce: "1",
      deadline: "2",
    })
  collectOnboardingKeys.mockResolvedValue({ secretKey: "0xmsk", pubkeyHex: "0xpub" })
  buildClaimSubscribeWitness.mockResolvedValue({ nameHash: new Uint8Array(32) })
  const sponsors = { ...session.page.sponsors, accounts: async () => accounts }
  return {
    session: Object.assign(Object.create(session), { page: { ...session.page, sponsors } }),
    wallet: { pxe: {}, node: {} },
    account: accounts.acting,
    contractService: { getArtifactForContract: vi.fn().mockResolvedValue({}) },
  } as never
}

const askedFor = () => hasClaimFpcSubscription.mock.calls.map(([, , , user]) => user.toString())

describe("the payer of a sponsored batch", () => {
  afterEach(() => closeSession())

  it("is the acting account on its own note when the payer's is gone", async () => {
    const payer = account("0xpayer2")
    const acting = account("0xacting2")
    const sponsor = await claimSponsorContext(
      await setup(["0xacting2"], { payer, acting }),
      RAIL_REGISTERED,
    )
    expect(sponsor.payer).toBeUndefined()
    expect(sponsor.subscribe).toBeUndefined()
    expect(askedFor()).toEqual(["0xpayer2", "0xacting2"])
  })

  it("is the acting account subscribing itself when neither holds a note", async () => {
    const payer = account("0xpayer3")
    const acting = account("0xacting3")
    const deps = await setup([], { payer, acting })
    const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)
    expect(sponsor.payer).toBeUndefined()
    expect(sponsor.subscribe).toBeDefined()
    expect(collectOnboardingKeys).toHaveBeenCalledWith(
      (deps as { session: unknown }).session,
      acting,
    )
  })
})

/**
 * After a rotation, a subscribe by the one-key account fails its identity check: the L1 record names
 * the two-key account.
 */
describe("a failed subscription read", () => {
  afterEach(() => closeSession())

  it("fails the batch instead of subscribing, and is read again next time", async () => {
    const payer = account("0xpayer7")
    const acting = account("0xacting7")
    const deps = await setup(["0xpayer7"], { payer, acting })
    hasClaimFpcSubscription.mockRejectedValueOnce(new Error("node timeout"))
    await expect(claimSponsorContext(deps, RAIL_REGISTERED)).rejects.toMatchObject({
      code: "sponsorship.unconfirmed",
    })
    expect(collectOnboardingKeys).not.toHaveBeenCalled()
    expect((await claimSponsorContext(deps, RAIL_REGISTERED)).payer?.toString()).toBe("0xpayer7")
  })

  it("keeps a subscribe noted while it was being read", async () => {
    const payer = account("0xpayer8")
    const acting = account("0xacting8")
    const deps = await setup([], { payer, acting })
    const { session } = deps as { session: never }
    hasClaimFpcSubscription.mockImplementationOnce(async (_wallet, fpcAddress) => {
      await Promise.resolve() // the read is in flight
      noteSubscribed({ session, account: payer }, fpcAddress, RAIL.railId)
      throw new Error("node timeout")
    })
    await expect(claimSponsorContext(deps, RAIL_REGISTERED)).rejects.toMatchObject({
      code: "sponsorship.unconfirmed",
    })

    hasClaimFpcSubscription.mockClear()
    expect((await claimSponsorContext(deps, RAIL_REGISTERED)).payer?.toString()).toBe("0xpayer8")
    expect(askedFor()).toEqual([])
  })
})
