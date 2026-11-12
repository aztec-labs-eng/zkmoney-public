// @vitest-environment node
/**
 * Which ClaimFPC pays for an account the session does not own: a rotated wallet's previous account
 * moving its funds. It cannot mint, so it rides a note it already holds, on the current instance or
 * on one the profile has since retired.
 */
import { describe, expect, it, vi } from "vitest"

const { loadClaimFpcPolicy, loadClaimFpcPolicyAt, registerSponsorFpc, hasClaimFpcSubscription } =
  vi.hoisted(() => ({
    loadClaimFpcPolicy: vi.fn(),
    loadClaimFpcPolicyAt: vi.fn(),
    registerSponsorFpc: vi.fn(),
    hasClaimFpcSubscription: vi.fn(),
  }))
async function sdkMock(importOriginal: () => Promise<typeof import("@obsidion/sdk")>) {
  return {
    ...(await importOriginal()),
    loadClaimFpcPolicy,
    loadClaimFpcPolicyAt,
    registerSponsorFpc,
    hasClaimFpcSubscription,
  }
}
vi.mock("@obsidion/sdk", sdkMock) // debt-check-ignore: claimSponsorship takes no ClaimFPC seam; as claimSponsorContext.test.ts

import { Fr } from "@aztec-labs/aztec.js/fields"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { KIND_BY_ANY } from "@obsidion/sdk"
import { claimSponsorContext } from "../../../src/features/registration/claimSponsorship"
import { RAIL_REGISTERED } from "../../../src/features/registration/rails"
import { SessionChangedError } from "../../../src/platform/auth/sessionErrors"
import { fakeReads } from "../../support/fakeReads"
import { selfPayingSession } from "../../support/sponsors"

const TUPLE = { version: "v7", l2Token: `0x${"01".repeat(32)}` } as unknown as OxideEnvTuple
const CURRENT = `0x${"00".repeat(31)}a1`
const RETIRED = `0x${"00".repeat(31)}a2`
const OLDER = `0x${"00".repeat(31)}a3`
const ACTING = "0xacting"

/** A rail that pays for any call. */
const OPEN = { witnesses: [{ entry: { kind: KIND_BY_ANY } }] }
/** A rail that pays for no call on this deployment. */
const CLOSED = { witnesses: [] }
const rail = (policy: unknown) => ({
  railId: 1,
  name: RAIL_REGISTERED,
  gate: "registration",
  policy,
})

const address = (s: string) => ({ toString: () => s })
/** Where the identity path starts once the session's keys are in hand. */
const IDENTITY_PATH = new Error("identity path")
const sessionProvider = { getPubkeys: async () => Promise.reject(IDENTITY_PATH) }
const otherProvider = {}

interface Case {
  /** The accounts holding the rail's note, per instance. */
  notes: Record<string, string[]>
  retired?: { address: string; policy?: unknown }[]
  /** Whether the session's keys sign for the acting account. */
  owned?: boolean
}

/** One session per case: a held answer is memoized per (account, instance, rail). */
function setup({ notes, retired = [], owned = false }: Case) {
  vi.clearAllMocks()
  const policies = new Map<string, unknown>([
    [CURRENT, OPEN],
    ...retired.map(({ address, policy }) => [address, policy ?? OPEN] as const),
  ])
  loadClaimFpcPolicy.mockResolvedValue({ rail: rail(OPEN), fpcAddress: address(CURRENT) })
  loadClaimFpcPolicyAt.mockImplementation(async (_service, _name, at: string) => ({
    rail: rail(policies.get(at.toLowerCase())),
    fpcAddress: address(at),
  }))
  registerSponsorFpc.mockResolvedValue({ name: "ClaimFPC:registered" })
  hasClaimFpcSubscription.mockImplementation(
    async (_wallet, fpc: { toString(): string }, _artifact, user: { toString(): string }) =>
      (notes[fpc.toString().toLowerCase()] ?? []).includes(user.toString()),
  )
  const getContractRecord = vi.fn(async () => ({
    address: address(CURRENT),
    meta: { retired: retired.map(({ address }) => ({ address, policyManifest: {} })) },
  }))
  const session = {
    ...selfPayingSession(fakeReads({ oxideTuple: async () => TUPLE })),
    auth: { sessionKeys: async () => ({ secretKey: new Fr(1n), authProvider: sessionProvider }) },
  }
  const account = {
    getAddress: () => address(ACTING),
    getAuthProvider: () => (owned ? sessionProvider : otherProvider),
  }
  const contractService = {
    getArtifactForContract: vi.fn().mockResolvedValue({}),
    getContractRecord,
  }
  return {
    deps: { session, wallet: { pxe: {}, node: {} }, account, contractService } as never,
    getContractRecord,
  }
}

const lower = (value: unknown) => String(value).toLowerCase()

/** The instances asked whether an account holds the note, in order. */
const asked = () => hasClaimFpcSubscription.mock.calls.map(([, fpc]) => lower(fpc))

describe("an account the session does not own", () => {
  it("rides the retired instance on which it holds the note", async () => {
    const { deps } = setup({ notes: { [RETIRED]: [ACTING] }, retired: [{ address: RETIRED }] })

    const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)

    expect(sponsor.fpcAddress.toString()).toBe(RETIRED)
    expect(sponsor.subscribe).toBeUndefined()
    expect(sponsor.payer).toBeUndefined()
    expect(asked()).toEqual([CURRENT, RETIRED])
    // The batch's entrypoint needs the instance it rides in the PXE.
    expect(registerSponsorFpc.mock.calls.map(([, { fpcAddress }]) => lower(fpcAddress))).toContain(
      RETIRED,
    )
  })

  it("rides the current instance without reading the profile's record when its note is there", async () => {
    const { deps, getContractRecord } = setup({
      notes: { [CURRENT]: [ACTING] },
      retired: [{ address: RETIRED }],
    })

    const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)

    expect(sponsor.fpcAddress.toString()).toBe(CURRENT)
    expect(asked()).toEqual([CURRENT])
    expect(getContractRecord).not.toHaveBeenCalled()
  })

  it("fails as a changed session when no published instance holds its note", async () => {
    const { deps } = setup({ notes: {}, retired: [{ address: RETIRED }] })

    await expect(claimSponsorContext(deps, RAIL_REGISTERED)).rejects.toBeInstanceOf(
      SessionChangedError,
    )
    expect(asked()).toEqual([CURRENT, RETIRED])
  })

  it("rides the first published retired instance when more than one holds its note", async () => {
    const { deps } = setup({
      notes: { [RETIRED]: [ACTING], [OLDER]: [ACTING] },
      retired: [{ address: RETIRED }, { address: OLDER }],
    })

    const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)

    expect(sponsor.fpcAddress.toString()).toBe(RETIRED)
    expect(asked()).toEqual([CURRENT, RETIRED])
  })

  it("skips a retired instance whose rail pays for no call on this deployment", async () => {
    const { deps } = setup({
      notes: { [RETIRED]: [ACTING], [OLDER]: [ACTING] },
      retired: [{ address: RETIRED, policy: CLOSED }, { address: OLDER }],
    })

    const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)

    expect(sponsor.fpcAddress.toString()).toBe(OLDER)
    expect(asked()).toEqual([CURRENT, OLDER])
  })

  it("asks only the pinned instance of a batch on a named deployment", async () => {
    const { deps, getContractRecord } = setup({
      notes: { [RETIRED]: [ACTING] },
      retired: [{ address: RETIRED }],
    })
    const pinned = { ...TUPLE, fpcBeneficiary: CURRENT } as OxideEnvTuple

    await expect(
      claimSponsorContext(deps, RAIL_REGISTERED, { tuple: pinned }),
    ).rejects.toBeInstanceOf(SessionChangedError)
    expect(asked()).toEqual([CURRENT])
    expect(getContractRecord).not.toHaveBeenCalled()
  })

  it("fails the batch when a retired instance's note cannot be read", async () => {
    const { deps } = setup({ notes: {}, retired: [{ address: RETIRED }] })
    hasClaimFpcSubscription.mockImplementation(async (_wallet, fpc: { toString(): string }) => {
      if (fpc.toString().toLowerCase() === RETIRED) throw new Error("node timeout")
      return false
    })

    await expect(claimSponsorContext(deps, RAIL_REGISTERED)).rejects.toMatchObject({
      code: "sponsorship.unconfirmed",
    })
  })
})

describe("an account the session owns", () => {
  it("takes the identity path without reading the profile's record", async () => {
    const { deps, getContractRecord } = setup({
      notes: { [RETIRED]: [ACTING] },
      retired: [{ address: RETIRED }],
      owned: true,
    })

    await expect(claimSponsorContext(deps, RAIL_REGISTERED)).rejects.toBe(IDENTITY_PATH)
    expect(asked()).toEqual([CURRENT])
    expect(getContractRecord).not.toHaveBeenCalled()
  })
})
