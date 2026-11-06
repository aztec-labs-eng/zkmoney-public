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
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ network: "sandbox" }),
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
  setSponsorAccountsResolver,
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
  const { nameClaims } = openTestSession()
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
  return {
    wallet: { pxe: {}, node: {} },
    account: accounts.acting,
    contractService: { getArtifactForContract: vi.fn().mockResolvedValue({}) },
    payerFor: async () => accounts,
  } as never
}

const askedFor = () => hasClaimFpcSubscription.mock.calls.map(([, , , user]) => user.toString())

describe("the payer of a sponsored batch", () => {
  afterEach(() => {
    setSponsorAccountsResolver(undefined)
    closeSession()
  })

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
    const sponsor = await claimSponsorContext(await setup([], { payer, acting }), RAIL_REGISTERED)
    expect(sponsor.payer).toBeUndefined()
    expect(sponsor.subscribe).toBeDefined()
    expect(collectOnboardingKeys).toHaveBeenCalledWith(acting)
  })

  it("comes from the installed resolver when the deps name none", async () => {
    const payer = account("0xpayer5")
    const acting = account("0xacting5")
    const deps = await setup(["0xpayer5"], { payer, acting })
    delete (deps as { payerFor?: unknown }).payerFor
    setSponsorAccountsResolver(async () => ({ payer, acting }))
    expect((await claimSponsorContext(deps, RAIL_REGISTERED)).payer?.toString()).toBe("0xpayer5")

    setSponsorAccountsResolver(undefined)
    hasClaimFpcSubscription.mockResolvedValue(true)
    expect((await claimSponsorContext(deps, RAIL_REGISTERED)).payer).toBeUndefined()
    expect(askedFor()).toEqual(["0xpayer5", "0xacting5"])
  })
})
