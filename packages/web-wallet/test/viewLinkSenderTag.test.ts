// @vitest-environment node
/** A link read shows the creator's tag only when the name registry puts that tag on the funding transfer's sender. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { L1_CHAIN_ID_BY_NETWORK, Network } from "@obsidion/core/constants"

const CREATOR = "0x" + "0a".repeat(32)
const OTHER = "0x" + "0b".repeat(32)
const MEMO = "lunch"
const TAG = "river"
const CHAIN = L1_CHAIN_ID_BY_NETWORK[Network.SANDBOX]
const ROLLUP_VERSION = 6

const resolved = vi.hoisted(() => ({ senderTag: undefined as string | undefined }))
const resolveTagViaRegistry = vi.fn()

vi.stubGlobal("location", { origin: "https://wallet.test" })
vi.mock("../src/config/env", () => ({
  getConfig: () => ({
    network: Network.SANDBOX,
    l1ChainId: CHAIN,
    profileRollupVersion: String(ROLLUP_VERSION),
  }),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({ getAuthService: () => ({}) }))
vi.mock("../src/features/contacts/registryResolution", () => ({
  resolveTagViaRegistry: (...a: unknown[]) => resolveTagViaRegistry(...a),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  decodePaylinkInline: () => ({
    paylinkType: "direct",
    chainId: CHAIN,
    rollupVersion: ROLLUP_VERSION,
  }),
  PaylinkService: class {
    isPaylinkClaimed = async () => false
    resolveLink = async () => ({
      note: { amount: 5n * 10n ** 18n, tokenAddress: { toString: () => "0xtoken" } },
      commitment: { toString: () => "0x0" },
      memo: MEMO,
      senderTag: resolved.senderTag,
      from: CREATOR,
    })
  },
}))

const { viewLink } = await import("../src/features/paylink/sponsoredPaylink")
const deps = { wallet: {}, contractService: {} } as never

describe("viewLink's sender tag", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolved.senderTag = TAG
  })

  it("keeps a tag the registry resolves to the funding transfer's sender", async () => {
    resolveTagViaRegistry.mockResolvedValue({
      status: "resolved",
      l2Address: CREATOR.toUpperCase(),
    })
    const link = await viewLink(deps, "frag")
    expect(link).toMatchObject({ memo: MEMO, senderTag: TAG })
    expect(resolveTagViaRegistry).toHaveBeenCalledWith(TAG)
  })

  it.each([
    ["resolves to another account", async () => ({ status: "resolved", l2Address: OTHER })],
    ["is not registered", async () => ({ status: "notFound" })],
    ["cannot be checked", async () => Promise.reject(new Error("rpc down"))],
  ])("drops a tag that %s", async (_case, resolution) => {
    resolveTagViaRegistry.mockImplementation(resolution)
    const link = await viewLink(deps, "frag")
    expect(link.memo).toBe(MEMO)
    expect(link.senderTag).toBeUndefined()
  })

  it("reads no registry for a link without a tag", async () => {
    resolved.senderTag = undefined
    const link = await viewLink(deps, "frag")
    expect(link.senderTag).toBeUndefined()
    expect(resolveTagViaRegistry).not.toHaveBeenCalled()
  })
})
