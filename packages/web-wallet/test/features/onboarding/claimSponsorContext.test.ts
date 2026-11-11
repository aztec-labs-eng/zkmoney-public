// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeReads } from "../../support/fakeReads"

const { loadClaimFpcPolicy, loadClaimFpcPolicyAt, registerSponsorFpc, hasClaimFpcSubscription } =
  vi.hoisted(() => ({
    loadClaimFpcPolicy: vi.fn(),
    loadClaimFpcPolicyAt: vi.fn(),
    registerSponsorFpc: vi.fn(),
    hasClaimFpcSubscription: vi.fn(),
  }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  claimFpcPolicySponsorsAnyCall: () => true,
  loadClaimFpcPolicy,
  loadClaimFpcPolicyAt,
  registerSponsorFpc,
  hasClaimFpcSubscription,
}))
const { registrationGateWitness } = vi.hoisted(() => ({ registrationGateWitness: vi.fn() }))
vi.mock("../../../src/features/registration/registrationRail", () => ({ registrationGateWitness }))
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
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  deriveBootstrapKey: () => ({ address: "0x" + "11".repeat(20) }),
  resolveOxideIdentity: async () =>
    unverifiedAccounts
      ? { kind: "unverified", accounts: unverifiedAccounts }
      : {
          kind: "verified",
          identity: {
            account: "0x" + "22".repeat(20),
            nameHash: "0x" + "33".repeat(32),
            generations: [
              currentFpc,
              "0x00000000000000000000000000000000000000000000000000000000000001f4",
            ].map((fpcAddress) => ({ fpcAddress, namePortal: "0x" + "44".repeat(20) })),
          },
        },
}))

vi.mock("../../../src/features/registration/oxideGenerations", () => ({
  loadOxideGenerations: async () => ({}),
}))
let currentFpc = ""
/** The L1 accounts the name's record names instead of the session's; the identity verifies without them. */
let unverifiedAccounts: string[] | undefined

import { WalletError } from "@obsidion/core/errors"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { UnverifiedOxideIdentityError } from "@obsidion/front-core"
import { railByName } from "@obsidion/sdk"
import { errorMessage } from "../../../src/errors/catalog"
import { claimSponsorContext } from "../../../src/features/registration/claimSponsorship"
import {
  RAIL_REGISTRATION_BROADCAST,
  RAIL_REGISTERED,
} from "../../../src/features/registration/rails"
import { closeSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"
import { seedDeviceKeys } from "../../support/page"
import { selfPayingSession } from "../../support/sponsors"

const tuple = (version: string, fpcBeneficiary: string) =>
  ({ version, fpcBeneficiary, l2Token: "0x" + "01".repeat(32) } as unknown as OxideEnvTuple)
const CURRENT_TUPLE = tuple("v7", `0x${"a2".repeat(32)}`)
const HISTORIC_TUPLE = tuple("v6", `0x${"a1".repeat(32)}`)
const POLICY = { root: "0xpolicy" }
const BUNDLED = { name: "ClaimFPC:bundled" }
const REGISTERED = { name: "ClaimFPC:registered" }
/** The deployment's second rail: what the wallet's declared name resolves to. */
const SPONSORED_RAIL = { railId: 1, name: RAIL_REGISTERED, gate: "nameClaim", policy: POLICY }

const address = (s: string) => ({ toString: () => s } as never)

const session = selfPayingSession(fakeReads({ oxideTuple: async () => CURRENT_TUPLE }))
function deps(fpc: string, account: string) {
  loadClaimFpcPolicy.mockResolvedValue({ rail: SPONSORED_RAIL, fpcAddress: address(fpc) })
  return {
    session,
    wallet: { pxe: {}, node: {} },
    account: { getAddress: () => address(account) },
    contractService: { getArtifactForContract: vi.fn().mockResolvedValue(BUNDLED) },
  } as never
}

describe("claimSponsorContext", () => {
  it("registers the FPC before reading its subscription utility", async () => {
    const order: string[] = []
    registerSponsorFpc.mockImplementation(async () => {
      order.push("register")
      return REGISTERED
    })
    hasClaimFpcSubscription.mockImplementation(async () => {
      order.push("read")
      return true
    })

    const sponsor = await claimSponsorContext(
      deps("0x00000000000000000000000000000000000000000000000000000000000001f5", "0xacc1"),
      RAIL_REGISTERED,
    )

    // A read against an unregistered FPC throws, which would fail every sponsored batch on a device
    // whose PXE never held the FPC.
    expect(order).toEqual(["register", "read"])
    // The read runs against the registered artifact, not the bundled one it was built from.
    expect(hasClaimFpcSubscription.mock.calls[0][2]).toBe(REGISTERED)
    expect(sponsor.fpcArtifact).toBe(REGISTERED)
    expect(sponsor.subscribe).toBeUndefined()
  })

  it("registers on every sponsored op, including one riding the memoized answer", async () => {
    registerSponsorFpc.mockReset()
    hasClaimFpcSubscription.mockReset()
    registerSponsorFpc.mockResolvedValue(REGISTERED)
    hasClaimFpcSubscription.mockResolvedValue(true)

    await claimSponsorContext(
      deps("0x00000000000000000000000000000000000000000000000000000000000001f7", "0xacc2"),
      RAIL_REGISTERED,
    )
    await claimSponsorContext(
      deps("0x00000000000000000000000000000000000000000000000000000000000001f7", "0xacc2"),
      RAIL_REGISTERED,
    )

    // The FPC's entrypoint needs the instance in the PXE whichever leg the batch rides, so
    // registration is per op; only the chain answer is memoized.
    expect(registerSponsorFpc).toHaveBeenCalledTimes(2)
    expect(hasClaimFpcSubscription).toHaveBeenCalledTimes(1)
  })
})

const STRICT_POLICY = { root: "0xstrict" }
/** The shipped deployment: the one-shot broadcast rail first, then the refilling product rail. */
const DEPLOYED_RAILS = [
  { railId: 0, name: RAIL_REGISTRATION_BROADCAST, gate: "nameClaim", policy: STRICT_POLICY },
  { railId: 1, name: RAIL_REGISTERED, gate: "registration", policy: POLICY },
]

const NAME_CLAIM = { nameHash: new Uint8Array(32) }
const REGISTRATION_GATE = { kind: "registration", keyWitness: "0x1", leafIndex: "0x9" }

afterEach(closeSession)

async function manifestDeps(fpc: string, account: string) {
  vi.clearAllMocks()
  currentFpc = fpc
  unverifiedAccounts = undefined
  loadClaimFpcPolicy.mockImplementation(async (_service: unknown, name: string) => ({
    rail: railByName(DEPLOYED_RAILS as never, name),
    fpcAddress: address(fpc),
  }))
  registerSponsorFpc.mockResolvedValue(REGISTERED)
  hasClaimFpcSubscription.mockResolvedValue(false)
  await seedDeviceKeys({ storageId: "a1" })
  const session = openTestSession({ primed: { tuple: CURRENT_TUPLE } })
  await session.nameClaims.put({
    address: account,
    handle: "taga",
    signature: "0xsig",
    nonce: "1",
    deadline: "2",
    nameHash: "0xnode",
  })
  collectOnboardingKeys.mockResolvedValue({ secretKey: "0xmsk", pubkeyHex: "0xpub" })
  buildClaimSubscribeWitness.mockResolvedValue(NAME_CLAIM)
  registrationGateWitness.mockResolvedValue({ gate: REGISTRATION_GATE })
  return {
    session,
    wallet: { pxe: {}, node: {} },
    account: { getAddress: () => address(account) },
    contractService: { getArtifactForContract: vi.fn().mockResolvedValue(BUNDLED) },
  } as never
}

describe("the rail a flow declares decides what its subscribe leg carries", () => {
  it("mints a NameClaim witness on the broadcast rail, and nothing else", async () => {
    const sponsor = await claimSponsorContext(
      await manifestDeps(
        "0x00000000000000000000000000000000000000000000000000000000000001f8",
        "0xacc4",
      ),
      RAIL_REGISTRATION_BROADCAST,
    )

    expect(sponsor.railId).toBe(0)
    expect(sponsor.policy).toBe(STRICT_POLICY)
    // The subscribe leg is the gate witness alone: the batch carries no account call.
    expect(sponsor.subscribe).toEqual({ gate: { kind: "nameClaim", ...NAME_CLAIM } })
    expect(registrationGateWitness).not.toHaveBeenCalled()
  })

  it("builds the registration witness for the acting account, not the session's", async () => {
    const deps = (await manifestDeps(
      "0x00000000000000000000000000000000000000000000000000000000000001fb",
      "0xacc8",
    )) as Record<string, unknown>
    const acting = { getAddress: () => address("0xacc9") }
    const own = deps.session as { page: { sponsors: object } }
    const payers = { ...own.page.sponsors, accounts: async () => ({ payer: deps.account, acting }) }
    const session = Object.assign(Object.create(own), { page: { ...own.page, sponsors: payers } })
    const sponsor = await claimSponsorContext({ ...deps, session } as never, RAIL_REGISTERED)
    expect(sponsor.subscribe).toEqual({ gate: REGISTRATION_GATE })
    expect(collectOnboardingKeys).toHaveBeenCalledWith(session, acting)
  })

  it("fails on the sponsored rail when the subscription read fails, before the identity check", async () => {
    const deps = await manifestDeps(
      "0x00000000000000000000000000000000000000000000000000000000000001fc",
      "0xacc10",
    )
    hasClaimFpcSubscription.mockRejectedValue(new Error("node timeout"))
    await expect(claimSponsorContext(deps, RAIL_REGISTERED)).rejects.toMatchObject({
      code: "sponsorship.unconfirmed",
    })
    expect(collectOnboardingKeys).not.toHaveBeenCalled()
    expect(registrationGateWitness).not.toHaveBeenCalled()
  })
})

describe("an account the name's record has moved past", () => {
  it("fails the sponsored action with the outdated-account words, the identity error as its cause", async () => {
    const deps = await manifestDeps(
      "0x00000000000000000000000000000000000000000000000000000000000001fb",
      "0xacc8",
    )
    unverifiedAccounts = [`0x${"55".repeat(20)}`]

    const failed = await claimSponsorContext(deps, RAIL_REGISTERED).then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(failed).toBeInstanceOf(WalletError)
    expect(failed).toMatchObject({ code: "account.outdated" })
    expect((failed as WalletError).cause).toBeInstanceOf(UnverifiedOxideIdentityError)
    expect(errorMessage(failed)).toBe(
      "This page is running an outdated account for your wallet. Refresh the page to continue.",
    )
  })
})

describe("the deployment generation a flow names decides which ClaimFPC it rides", () => {
  it("selects the named generation's FPC and hands its tuple to the gate", async () => {
    const deps = await manifestDeps(
      "0x00000000000000000000000000000000000000000000000000000000000001fb",
      "0xacc8",
    )
    loadClaimFpcPolicyAt.mockResolvedValue({
      rail: railByName(DEPLOYED_RAILS as never, RAIL_REGISTERED),
      fpcAddress: address("0x00000000000000000000000000000000000000000000000000000000000001f4"),
    })

    const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED, { tuple: HISTORIC_TUPLE })

    expect(loadClaimFpcPolicyAt.mock.calls[0][2]).toBe(HISTORIC_TUPLE.fpcBeneficiary)
    expect(sponsor.fpcAddress.toString()).toBe(
      "0x00000000000000000000000000000000000000000000000000000000000001f4",
    )
    expect(registrationGateWitness.mock.calls[0][0].generation.fpcAddress).toBe(
      sponsor.fpcAddress.toString(),
    )
  })

  it("hands the current tuple to the gate when no generation is named", async () => {
    await claimSponsorContext(
      await manifestDeps(
        "0x00000000000000000000000000000000000000000000000000000000000001fc",
        "0xacc9",
      ),
      RAIL_REGISTERED,
    )

    expect(loadClaimFpcPolicyAt).not.toHaveBeenCalled()
    expect(registrationGateWitness.mock.calls[0][0].generation.fpcAddress).toBe(currentFpc)
  })

  it("refuses a generation whose manifest entry names no ClaimFPC", async () => {
    const nameless = { version: "v6" } as unknown as OxideEnvTuple
    await expect(
      claimSponsorContext(
        await manifestDeps(
          "0x00000000000000000000000000000000000000000000000000000000000001fd",
          "0xacc11",
        ),
        RAIL_REGISTERED,
        { tuple: nameless },
      ),
    ).rejects.toThrow(/lacks fpcBeneficiary/)
    expect(loadClaimFpcPolicyAt).not.toHaveBeenCalled()
  })

  it("refuses a retired rail whose gate this wallet can only satisfy on the current deployment", async () => {
    const deps = await manifestDeps(
      "0x00000000000000000000000000000000000000000000000000000000000001fb",
      "0xacc10",
    )
    loadClaimFpcPolicyAt.mockResolvedValue({
      rail: railByName(DEPLOYED_RAILS as never, RAIL_REGISTRATION_BROADCAST),
      fpcAddress: address("0x00000000000000000000000000000000000000000000000000000000000001f4"),
    })

    await expect(
      claimSponsorContext(deps, RAIL_REGISTRATION_BROADCAST, { tuple: HISTORIC_TUPLE }),
    ).rejects.toThrow(/gates on nameClaim/)
  })
})
