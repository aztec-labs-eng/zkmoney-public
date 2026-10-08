// @vitest-environment node
import { Fr } from "@aztec/aztec.js/fields"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CandidateProbe, ResolvedMsk } from "@obsidion/front-core"
import type { Hex } from "viem"
import type { PrivateKeyAccount } from "viem/accounts"

const h = vi.hoisted(() => ({
  tuple: {
    registry: "0x00000000000000000000000000000000000000e4",
    accountFactory: "0x00000000000000000000000000000000000000e5",
  } as Record<string, string>,
}))

vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: vi.fn(async () => h.tuple),
  l1PublicClient: () => ({ readContract: vi.fn() }),
  requireTupleField: (tuple: Record<string, string>, key: string) => {
    const value = tuple[key]
    if (!value) throw new Error(`missing ${key}`)
    return value
  },
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  resolveOxideAccountFactory: () => h.tuple.accountFactory,
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ accountServiceUrl: "https://as.test.invalid" }),
}))

const {
  campaignSlotProbe,
  anchorTiers,
  boundGrantCandidateProbe,
  enterTiers,
  requireResolved,
  reservationCandidateProbe,
  reservedNameHashes,
} = await import("../src/features/onboarding/recoveryProbes")
const {
  AccountServiceTimeoutError,
  BOOTSTRAP_SIGNATURE_HEADER,
  DOMAIN_RESERVATION_PREIMAGE,
  deriveBootstrapKey,
  resolveRecoveredMsk,
} = await import("@obsidion/front-core")
const { recoverAddress } = await import("viem")
const { sha256 } = await import("@aztec/foundation/crypto/sha256")

const GENERATIONS = {} as never

describe("anchorTiers", () => {
  const live = { accountServiceTestMode: false } as never
  const campaign = {
    candidates: { first: Fr.random(), second: Fr.random() },
    slot: "second" as const,
  }

  it("is the Registry, then the campaign's word when its material names a slot, then the claim ledger", async () => {
    expect(anchorTiers(live, GENERATIONS, campaign).map((t) => t.name)).toEqual([
      "registry",
      "campaign",
      "reservation",
    ])
  })

  it("asks no campaign for keys a ceremony produced", async () => {
    const tiers = anchorTiers(live, GENERATIONS)
    expect(tiers.map((t) => t.name)).toEqual(["registry", "reservation"])
    expect(tiers[0]!.probes).toHaveLength(1)
  })

  it("leaves the claim ledger out in account-service test mode", async () => {
    const testMode = { accountServiceTestMode: true } as never
    expect(anchorTiers(testMode, GENERATIONS, campaign).map((t) => t.name)).toEqual([
      "registry",
      "campaign",
    ])
    expect(anchorTiers(testMode, GENERATIONS).map((t) => t.name)).toEqual(["registry"])
  })
})

describe("enterTiers", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("is the outside records with no campaign among them", async () => {
    expect(
      enterTiers({ accountServiceTestMode: false } as never, GENERATIONS).map((t) => t.name),
    ).toEqual(["registry", "reservation"])
    expect(
      enterTiers({ accountServiceTestMode: true } as never, GENERATIONS).map((t) => t.name),
    ).toEqual(["registry"])
    expect(
      enterTiers({ accountServiceTestMode: false } as never, GENERATIONS, {
        nameHash: `0x${"ab".repeat(32)}`,
        token: "grant-token",
      }).map((t) => t.name),
    ).toEqual(["registry", "name-grant", "reservation"])
  })

  it("sends nothing while the tiers are built", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await enterTiers({ campaignUrl: "", accountServiceTestMode: false } as never, GENERATIONS)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("boundGrantCandidateProbe", () => {
  it("anchors only the bootstrap key that owns the bound grant", async () => {
    const nameHash = `0x${"ab".repeat(32)}` as Hex
    const owner = Fr.random()
    const other = Fr.random()
    const address = deriveBootstrapKey(owner).address
    const lookup = vi.fn(
      async (_hash: Hex, _token: string, bootstrap: PrivateKeyAccount) =>
        bootstrap.address === address,
    )
    const probe = boundGrantCandidateProbe(nameHash, "grant-token", lookup)

    expect(await probe(owner, "0xignored")).toBe("anchored")
    expect(await probe(other, "0xignored")).toBe("absent")
    expect(lookup).toHaveBeenCalledWith(
      nameHash,
      "grant-token",
      expect.objectContaining({ address }),
    )
    expect(
      await resolveRecoveredMsk(
        { candidates: { first: other, second: owner }, preferredSlot: "first" } as never,
        async (msk) => msk.toString(),
        [
          { name: "registry", probes: [async () => "absent"] },
          { name: "name-grant", probes: [probe] },
          { name: "reservation", probes: [async () => "absent"] },
        ],
      ),
    ).toMatchObject({ kind: "resolved", slot: "second", tier: "name-grant" })
  })
})

describe("reservationCandidateProbe", () => {
  const H = `0x${"ab".repeat(32)}` as Hex

  it("a key holding any claim anchors its candidate; asked with that candidate's own key", async () => {
    const lookup = vi.fn(async (_bootstrap: PrivateKeyAccount) => [H])
    const msk = Fr.random()
    expect(await reservationCandidateProbe(lookup)(msk, "0xignored")).toBe("anchored")
    expect(lookup.mock.calls[0]![0].address).toBe(deriveBootstrapKey(msk).address)
  })

  it("a key with no claims is absent", async () => {
    const probe = reservationCandidateProbe(async () => [])
    expect(await probe(Fr.random(), "0xignored")).toBe("absent")
  })

  it("a lookup that cannot answer aborts instead of reading as absent", async () => {
    const probe = reservationCandidateProbe(async () => {
      throw new AccountServiceTimeoutError("/domain/reservation", 15_000)
    })
    await expect(probe(Fr.random(), "0xignored")).rejects.toBeInstanceOf(AccountServiceTimeoutError)
  })

  it("names the one candidate with claims once the Registry and campaign named no one", async () => {
    const first = Fr.random()
    const second = Fr.random()
    const holder = deriveBootstrapKey(second).address
    const lookup = vi.fn(async (bootstrap: PrivateKeyAccount) =>
      bootstrap.address === holder ? [H] : [],
    )
    const absent: CandidateProbe = async () => "absent"
    const tiers = [
      { name: "registry", probes: [absent] },
      { name: "campaign", probes: [absent] },
      { name: "reservation", probes: [reservationCandidateProbe(lookup)] },
    ]
    const recovered = { candidates: { first, second }, preferredSlot: "first" } as never
    const result = await resolveRecoveredMsk(recovered, async (m) => m.toString(), tiers)
    expect(result).toMatchObject({ kind: "resolved", slot: "second", tier: "reservation" })

    const both = reservationCandidateProbe(async () => [H])
    const ambiguous = await resolveRecoveredMsk(recovered, async (m) => m.toString(), [
      ...tiers.slice(0, 2),
      { name: "reservation", probes: [both] },
    ])
    expect(ambiguous).toEqual({ kind: "ambiguous", tier: "reservation" })
  })

  it("is never asked when an earlier tier names the account, even with account-service down", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("account-service down")
    })
    const first = Fr.random()
    const anchoredFirst: CandidateProbe = async (m) =>
      m.toString() === first.toString() ? "anchored" : "absent"
    const recovered = {
      candidates: { first, second: Fr.random() },
      preferredSlot: "first",
    } as never
    const result = await resolveRecoveredMsk(recovered, async (m) => m.toString(), [
      { name: "registry", probes: [anchoredFirst] },
      { name: "reservation", probes: [reservationCandidateProbe(lookup)] },
    ])
    expect(result).toMatchObject({ kind: "resolved", tier: "registry" })
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe("reservedNameHashes", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("asks the configured account-service, signed by the key it asks about", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ nameHashes: [`0x${"cd".repeat(32)}`] }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const bootstrap = deriveBootstrapKey(Fr.random())

    expect(await reservedNameHashes(bootstrap)).toEqual([`0x${"cd".repeat(32)}`])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://as.test.invalid/domain/reservation")
    const body = JSON.parse(init.body as string) as { keyId: string; timestamp: number }
    expect(body.keyId).toBe(bootstrap.address.toLowerCase())
    const signer = await recoverAddress({
      hash: `0x${Buffer.from(
        sha256(Buffer.from(DOMAIN_RESERVATION_PREIMAGE(body.keyId, body.timestamp), "utf-8")),
      ).toString("hex")}`,
      signature: (init.headers as Record<string, string>)[BOOTSTRAP_SIGNATURE_HEADER] as Hex,
    })
    expect(signer).toBe(bootstrap.address)
  })
})

describe("campaignSlotProbe", () => {
  const first = Fr.random()
  const second = Fr.random()

  it("anchors the candidate at the slot the campaign named and no other, with nothing sent", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const probe = campaignSlotProbe({ candidates: { first, second }, slot: "second" })
    expect(await probe(second, "0xignored")).toBe("anchored")
    expect(await probe(first, "0xignored")).toBe("absent")
    expect(await probe(Fr.random(), "0xignored")).toBe("absent")
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("names no one when the material never evaluated the slot it claims", async () => {
    const probe = campaignSlotProbe({ candidates: { first }, slot: "second" })
    expect(await probe(first, "0xignored")).toBe("absent")
  })
})

describe("requireResolved", () => {
  const resolved: ResolvedMsk = { kind: "resolved", msk: {} as never, slot: "first", tier: "x" }

  it("passes a resolved candidate through", () => {
    expect(requireResolved(resolved)).toBe(resolved)
  })

  it("maps unknown and ambiguous to the screens' refusals", () => {
    expect(() => requireResolved({ kind: "unknown" })).toThrow(
      expect.objectContaining({ name: "NoWalletForPasskeyError" }),
    )
    expect(() => requireResolved({ kind: "ambiguous", tier: "registry" })).toThrow(
      expect.objectContaining({ name: "AmbiguousPasskeyError" }),
    )
  })
})
