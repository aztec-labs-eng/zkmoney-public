/** The Across feature's own rules and its `exit` role. Mock addresses throughout. */
import { describe, expect, it } from "vitest"
import type { OxideDeployment } from "@obsidion/core/oxide"
import {
  acrossEscrowFactory,
  acrossExit,
  acrossFeature,
  parseFeaturesDocument,
  parseServedFeatures,
  resolveFeatureRoles,
} from "../../src/index.js"

const MOCK_TOKEN = `0x${"a1".repeat(20)}`
const MOCK_SPOKE_POOL = `0x${"a2".repeat(20)}`
const MOCK_FACTORY = `0x${"a3".repeat(20)}`

type Doc = Record<string, any>

function doc(): Doc {
  return {
    schemaVersion: "1",
    profileId: "mock-v1",
    network: "testnet",
    features: {
      across: {
        apiUrl: "https://across.mock.example",
        oxide: { exit: "mock-across-feature" },
        chains: [
          {
            chainId: 1001,
            name: "Mock chain",
            etaMinutes: 2,
            rpcUrl: "https://rpc.mock.example",
            contracts: [MOCK_SPOKE_POOL],
            in: [
              { symbol: "USDC", address: MOCK_TOKEN },
              { symbol: "ETH", native: true },
            ],
            out: [{ symbol: "USDC", address: MOCK_TOKEN }],
          },
        ],
      },
    },
  }
}

function changed(edit: (d: Doc) => void): Doc {
  const d = doc()
  edit(d)
  return d
}

describe("the across feature", () => {
  it("reads its chains, tokens and exit role", () => {
    const { across } = parseFeaturesDocument(doc()).features
    expect(across?.oxide.exit).toBe("mock-across-feature")
    expect(across?.chains[0]?.out?.[0]?.symbol).toBe("USDC")
  })

  it.each<[string, (d: Doc) => void, RegExp]>([
    [
      "the L1 as a bridge chain",
      (d) => (d.features.across.chains[0].chainId = 11155111),
      /L1 chain/,
    ],
    [
      "a chain twice",
      (d) => d.features.across.chains.push(structuredClone(d.features.across.chains[0])),
      /chain 1001 twice/,
    ],
    [
      "a token twice",
      (d) => d.features.across.chains[0].in.push({ symbol: "ETH", native: true }),
      /ETH twice/,
    ],
    [
      "an exit the escrow cannot swap to",
      (d) => (d.features.across.chains[0].out[0].symbol = "DAI"),
      /out/,
    ],
    [
      "native ETH out",
      (d) => (d.features.across.chains[0].out = [{ symbol: "ETH", native: true }]),
      /out/,
    ],
    ["an empty contracts list", (d) => (d.features.across.chains[0].contracts = []), /contracts/],
    [
      "a token naming both address and native",
      (d) => (d.features.across.chains[0].in[0].native = true),
      /exactly one of address and native/,
    ],
    [
      "a token naming neither address nor native",
      (d) => delete d.features.across.chains[0].in[0].address,
      /exactly one of address and native/,
    ],
    [
      "a key this build does not know on a token",
      (d) => (d.features.across.chains[0].in[0].mockAddedLater = 1),
      /mockAddedLater/,
    ],
  ])("refuses %s", (_, edit, message) => {
    expect(() => parseFeaturesDocument(changed(edit))).toThrow(message)
  })

  it.each<[string, number]>([
    ["an ERC-20", 0],
    ["the gas token", 1],
  ])("stays on when a served document adds a key to %s", (_, index) => {
    const d = changed((d) => (d.features.across.chains[0].in[index].mockAddedLater = 1))
    const served = parseServedFeatures(d, {
      expected: { profileId: "mock-v1", network: "testnet" },
    })
    expect(served.rejected).toEqual([])
    expect(served.features.across?.chains[0]?.in[index]).not.toHaveProperty("mockAddedLater")
  })
})

describe("what the across feature names on chains", () => {
  it("is its L1 handler, and each chain's contracts and tokens both ways, without native ETH", () => {
    const d = changed((d) => (d.features.across.multicallHandler = MOCK_FACTORY))
    const across = parseFeaturesDocument(d).features.across!
    expect(acrossFeature.onChain!(across)).toEqual({
      l1Contracts: [{ path: ["multicallHandler"], address: MOCK_FACTORY }],
      chains: [
        {
          path: ["chains", 0],
          chainId: 1001,
          rpcUrl: "https://rpc.mock.example",
          contracts: [{ path: ["chains", 0, "contracts", 0], address: MOCK_SPOKE_POOL }],
          tokens: [
            { path: ["chains", 0, "in", 0], address: MOCK_TOKEN, symbol: "USDC" },
            { path: ["chains", 0, "out", 0], address: MOCK_TOKEN, symbol: "USDC" },
          ],
        },
      ],
    })
  })
})

describe("the across exit role", () => {
  const deployment = (feature: object): OxideDeployment => ({
    label: "mock",
    rollupVersion: "1",
    bridges: [
      {
        id: "mock-dai-bridge",
        underlying: "0x01",
        token: "0x01",
        portal: "0x02",
        l2Token: "0x03",
        tuple: {} as OxideDeployment["bridges"][number]["tuple"],
      },
    ],
    features: [
      {
        id: "mock-across-feature",
        project: "across",
        contracts: { acrossBridgeEscrowFactory: MOCK_FACTORY },
        bridges: { dai: "mock-dai-bridge" },
        variables: {},
        ...feature,
      },
    ],
  })
  const exitOf = (feature: object) =>
    resolveFeatureRoles(parseFeaturesDocument(doc()).features, deployment(feature))

  it.each<[string, object, string | undefined]>([
    ["binds an escrow factory and the dai bridge", {}, undefined],
    ["names no escrow factory", { contracts: {} }, "role.missingContract"],
    ["binds no dai bridge", { bridges: {} }, "role.missingBridge"],
    ["comes from another project", { project: "cctp" }, "role.wrongProject"],
  ])("resolves an Oxide feature that %s", (_, feature, problem) => {
    const { features, problems } = exitOf(feature)
    expect(features.across?.oxide.exit?.id).toBe(problem ? undefined : "mock-across-feature")
    expect(problems.map((p) => p.code)).toEqual(problem ? [problem] : [])
  })
})

describe("acrossExit and acrossEscrowFactory", () => {
  const RETIRED_FACTORY = `0x${"a4".repeat(20)}`
  const pinned: OxideDeployment = {
    label: "mock",
    rollupVersion: "1",
    bridges: ["mock-dai-bridge", "mock-other-bridge"].map((id) => ({
      id,
      underlying: "0x01",
      token: "0x01",
      portal: "0x02",
      l2Token: "0x03",
      tuple: {} as OxideDeployment["bridges"][number]["tuple"],
    })),
    features: [
      {
        id: "mock-across-feature",
        project: "across",
        contracts: { acrossBridgeEscrowFactory: MOCK_FACTORY },
        bridges: { dai: "mock-dai-bridge" },
        variables: {},
      },
    ],
  }
  const across = (exit?: string) =>
    parseFeaturesDocument(changed((d) => (d.features.across.oxide = exit ? { exit } : {}))).features
      .across!

  it.each<[string, string | undefined, boolean]>([
    ["binds an Oxide feature of the deployment", "mock-across-feature", true],
    ["is unbound", undefined, false],
    ["names a feature the deployment lacks", "mock-gone", false],
  ])("resolves the exit only when the role %s", (_, exit, resolved) => {
    expect(acrossExit(across(exit), pinned)?.feature.id).toBe(
      resolved ? "mock-across-feature" : undefined,
    )
  })

  const exit = acrossExit(across("mock-across-feature"), pinned)
  it.each<
    [
      string,
      ReturnType<typeof acrossExit>,
      { bridgeId?: string; acrossBridgeEscrowFactory?: string },
      string | undefined,
    ]
  >([
    [
      "the pinned bridge exit binds, through exit's escrow",
      exit,
      { bridgeId: "mock-dai-bridge" },
      MOCK_FACTORY,
    ],
    ["nothing with no exit", undefined, { bridgeId: "mock-dai-bridge" }, undefined],
    [
      "nothing from a pinned bridge exit does not bind",
      exit,
      { bridgeId: "mock-other-bridge" },
      undefined,
    ],
    [
      "a retired deployment's bridge, through its own escrow",
      exit,
      { bridgeId: "mock-retired-bridge", acrossBridgeEscrowFactory: RETIRED_FACTORY },
      RETIRED_FACTORY,
    ],
    [
      "nothing from a retired deployment without an escrow",
      exit,
      { bridgeId: "mock-retired-bridge" },
      undefined,
    ],
  ])("bridges out %s", (_, binding, tuple, factory) => {
    expect(acrossEscrowFactory(binding, tuple)).toBe(factory)
  })
})
