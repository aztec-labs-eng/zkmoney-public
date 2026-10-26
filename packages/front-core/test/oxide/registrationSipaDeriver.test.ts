// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { Fr } from "@aztec/foundation/curves/bn254"
import type { OxideEnvTuple } from "@obsidion/core/types"

const h = vi.hoisted(() => ({
  fetchSipaResolverOperators: vi.fn(),
  readRegistrationSIPAImplementation: vi.fn(
    async () => "0x00000000000000000000000000000000000000b2",
  ),
  predictLegacySIPA: vi.fn(async () => "0x00000000000000000000000000000000000000a1"),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  fetchSipaResolverOperators: h.fetchSipaResolverOperators,
  readRegistrationSIPAImplementation: h.readRegistrationSIPAImplementation,
}))
vi.mock("@oxide/l1-contracts/legacy_sipa.js", () => ({ predictLegacySIPA: h.predictLegacySIPA }))

const { createRegistrationSipaDeriver, NO_NAME_PORTAL_RECIPIENT, oxideEnvFromTuple } = await import(
  "../../src/oxide/oxideRegistrationDeps"
)

const RESOLVER = "0xf902DF6c3d057230ac8c2FbD7a86aD03AFf2F871" as Address
const TUPLE = {
  rollupVersion: "3",
  registry: "0x0000000000000000000000000000000000000001",
  ensDomain: "oxidestaging.eth",
  token: "0x0000000000000000000000000000000000000004",
  portal: "0x0000000000000000000000000000000000000012",
  sipaFactory: "0x0000000000000000000000000000000000000013",
} as unknown as OxideEnvTuple

const env = () =>
  oxideEnvFromTuple(TUPLE, {
    resolverOperator: RESOLVER,
    l1ChainId: 11155111,
    accountFactory: "0x0000000000000000000000000000000000000002",
    namePortalRecipient: NO_NAME_PORTAL_RECIPIENT,
  })
const input = (fee: bigint) => ({
  owner: "0x00000000000000000000000000000000000000c3" as Address,
  nameHash: `0x${"0d".repeat(32)}` as const,
  l2Address: `0x${"0e".repeat(32)}` as const,
  fee,
  beneficiary: "0x00000000000000000000000000000000000000f4" as Address,
  masterSecret: new Fr(7n),
})

describe("createRegistrationSipaDeriver", () => {
  it("records the env's resolver operator in the user record without scanning operator logs", async () => {
    const derive = createRegistrationSipaDeriver({
      publicClient: {} as never,
      env: env(),
      tuple: TUPLE,
    })
    const derived = await derive(input(5n))
    expect(derived.sipaAddress).toBe("0x00000000000000000000000000000000000000a1")
    expect(derived.recordData.toLowerCase()).toContain(RESOLVER.slice(2).toLowerCase())
    expect(h.fetchSipaResolverOperators).not.toHaveBeenCalled()
  })

  it("reads the registration implementation once for every fee it derives at", async () => {
    h.readRegistrationSIPAImplementation.mockClear()
    const derive = createRegistrationSipaDeriver({
      publicClient: {} as never,
      env: env(),
      tuple: TUPLE,
    })
    await Promise.all([0n, 5n, 7n].map((fee) => derive(input(fee))))
    expect(h.readRegistrationSIPAImplementation).toHaveBeenCalledOnce()
  })

  it("keeps no failed implementation read", async () => {
    h.readRegistrationSIPAImplementation.mockClear().mockRejectedValueOnce(new Error("rpc down"))
    const derive = createRegistrationSipaDeriver({
      publicClient: {} as never,
      env: env(),
      tuple: TUPLE,
    })
    await expect(derive(input(5n))).rejects.toThrow("rpc down")
    await expect(derive(input(5n))).resolves.toMatchObject({ sipaAddress: expect.any(String) })
    expect(h.readRegistrationSIPAImplementation).toHaveBeenCalledTimes(2)
  })
})
