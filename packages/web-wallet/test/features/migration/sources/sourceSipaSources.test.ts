// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import {
  composeWireNameHash,
  deriveStealthKey,
  directDepositKey,
  registrationCommitments,
} from "@obsidion/front-core"

const h = vi.hoisted(() => ({
  keys: vi.fn(async () => [] as unknown[]),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchHistoricalSipaResolverOperators: async () => [],
  fetchHistoricalResolverKeys: h.keys,
}))
const { sourceSipaSources } = await import("../../../../src/features/migration/sourceSipaSources")

beforeEach(() => {
  h.keys.mockReset().mockResolvedValue([])
})

const SECRET = new Fr(7n)
const ACCOUNT = `0x${"0e".repeat(32)}` as const
const TUPLE = {
  portal: "0xabc",
  deployedAtBlock: "1",
  accountMetadataRegistry: "0x" + "0a".repeat(20),
  registrationSIPAImplementation: "0x" + "0b".repeat(20),
  ensDomain: "zkmoney.eth",
}
const RESOLVER_KEY = deriveStealthKey(new Fr(9n)).publicKey

const scan = (announced: unknown[]) => {
  const sipaSources = vi.fn(async () => announced)
  return {
    sipaSources,
    params: {
      page: {
        config: { network: "sandbox" },
      } as never,
      chain: { kind: "generation", session: { address: ACCOUNT, sipaSources } } as never,
      tuple: TUPLE as never,
      publicClient: {} as never,
      masterSecret: SECRET,
      scanHead: 42n,
      handle: undefined as string | undefined,
    },
  }
}

describe("sourceSipaSources", () => {
  it("finds no SIPAs on a deployment without SIPA implementations", async () => {
    const { sipaSources, params } = scan([])
    await expect(
      sourceSipaSources({ ...params, tuple: { portal: "0xabc" } as never }),
    ).resolves.toEqual([])
    expect(sipaSources).not.toHaveBeenCalled()
  })

  it("finds a registration address no SIPA event announced by its commitment, under every salt", async () => {
    h.keys.mockResolvedValue([{ owner: "0x" + "0c".repeat(20), resolverPublicKey: RESOLVER_KEY }])
    const { params } = scan([])

    const sources = await sourceSipaSources({ ...params, handle: "phil" })

    const expected = await registrationCommitments(
      SECRET,
      composeWireNameHash("phil", TUPLE.ensDomain),
      ACCOUNT,
      [RESOLVER_KEY],
    )
    expect(expected).toHaveLength(2)
    expect(sources).toEqual(
      expected.map(({ salt, commitment }) => ({
        sipaAddress: directDepositKey(commitment),
        recipientL2Address: ACCOUNT,
        messageSecret: salt,
        recipientCommitment: commitment,
        direct: true,
      })),
    )
  })

  it("refuses a registration scan on a deployment with no resolver registry", async () => {
    const { params } = scan([])
    const tuple = { ...TUPLE, accountMetadataRegistry: undefined } as never
    await expect(sourceSipaSources({ ...params, tuple, handle: "phil" })).rejects.toMatchObject({
      code: "migration.noResolverRegistry",
    })
  })

  it("adds no registration source for an account with no handle", async () => {
    const { params } = scan([])
    expect(await sourceSipaSources(params)).toEqual([])
  })
})
