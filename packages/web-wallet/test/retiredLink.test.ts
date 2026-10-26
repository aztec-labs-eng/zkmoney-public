// @vitest-environment node
/** A link made on an earlier rollup of this chain reads as retired, without a status read that would refuse it. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { L1_CHAIN_ID, L1_CHAIN_ID_BY_NETWORK, Network } from "@obsidion/core/constants"

const CHAIN = L1_CHAIN_ID_BY_NETWORK[Network.SANDBOX]
const OTHER_CHAIN = L1_CHAIN_ID.MAINNET
const ROLLUP_VERSION = 6
const EARLIER_ROLLUP_VERSION = ROLLUP_VERSION - 1

const params = vi.hoisted(() => ({ chainId: 0, rollupVersion: 0 }))
const isPaylinkClaimed = vi.fn(async () => true)

vi.stubGlobal("location", { origin: "https://wallet.test" })
vi.mock("../src/config/env", () => ({
  getConfig: () => ({
    network: Network.SANDBOX,
    l1ChainId: CHAIN,
    profileRollupVersion: String(ROLLUP_VERSION),
  }),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({ getAuthService: () => ({}) }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  decodePaylinkInline: () => ({ paylinkType: "direct", ...params }),
  PaylinkService: class {
    isPaylinkClaimed = isPaylinkClaimed
  },
}))

const { decodeLink, viewLink } = await import("../src/features/paylink/sponsoredPaylink")
const deps = { wallet: {}, contractService: {} } as never

describe("a link from an earlier rollup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(params, { chainId: CHAIN, rollupVersion: EARLIER_ROLLUP_VERSION })
  })

  it("decodes as retired", () => {
    expect(decodeLink("frag").status).toBe("retired")
  })

  it("reads as retired without asking the chain", async () => {
    expect((await viewLink(deps, "frag")).status).toBe("retired")
    expect(isPaylinkClaimed).not.toHaveBeenCalled()
  })

  it("is not retired on this rollup", async () => {
    params.rollupVersion = ROLLUP_VERSION
    expect(decodeLink("frag").status).toBe("unclaimed")
    expect((await viewLink(deps, "frag")).status).toBe("claimed")
  })

  it("is not retired for another L1 chain, which the status read refuses", () => {
    params.chainId = OTHER_CHAIN
    expect(decodeLink("frag").status).toBe("unclaimed")
  })
})
