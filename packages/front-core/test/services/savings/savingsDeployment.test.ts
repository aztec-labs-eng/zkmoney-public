import { describe, expect, it, vi } from "vitest"
import { oxideManifestDeployments, pinnedOxideDeployment } from "@obsidion/core/oxide"
import {
  SkyFactoryMismatchError,
  assertSkyFactoryPortals,
  readSkyFactoryPortals,
  resolveSkySavings,
  savingsSourceExecutor,
  skyBridgesOfFactory,
} from "../../../src/core/services/savings/savingsDeployment"

const DAI = "0x00000000000000000000000000000000000000d1"
const SUSDS = "0x00000000000000000000000000000000000000d2"
const MAIN_PORTAL = "0x00000000000000000000000000000000000000aa"
const SAVINGS_PORTAL = "0x00000000000000000000000000000000000000bb"
const FACTORY = "0x00000000000000000000000000000000000000fa"
const SKY_EXECUTOR = "0x00000000000000000000000000000000000000e5"
const l1 = (byte: string) => `0x${byte.repeat(20)}`
const l2 = (byte: string) => `0x${byte.repeat(32)}`

const bridge = (key: string, token: string, portal: string, byte: string) => ({
  key,
  bridgeId: `brg-${key}-sandbox`,
  token,
  underlying: token,
  portal,
  l2Token: l2(byte),
  plainWithdrawalExecutor: l1(`e${byte[1]}`),
  withdrawalSubsidy: l1(`c${byte[1]}`),
})

const SKY_FEATURE = {
  "fea-sky-sandbox": {
    project: "sky",
    bridges: { sUsds: "brg-susds-sandbox", dai: "brg-dai-sandbox" },
    contracts: { skyWithdrawalExecutor: SKY_EXECUTOR, skyEscrowFactory: FACTORY },
  },
}

/** The sandbox's one deployment: sUSDS, then DAI, the fee token. */
function manifest(extra: Record<string, unknown>) {
  return {
    schemaVersion: "5",
    deployments: [
      {
        label: "sandbox",
        deployedAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-20T00:00:00.000Z",
        chainId: "31337",
        rollupVersion: "1",
        enclaveUrl: "http://localhost:5071/rpc",
        feeToken: DAI,
        ...extra,
        bridges: [
          bridge("susds", SUSDS, SAVINGS_PORTAL, "a2"),
          bridge("dai", DAI, MAIN_PORTAL, "a1"),
        ],
      },
    ],
  }
}

/** A schema v4 manifest: each portal a deployment of its own, each publishing the factory. */
function v4Manifest() {
  const entry = (b: ReturnType<typeof bridge>) => ({
    label: `sandbox-${b.key}`,
    deployedAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    chainId: "31337",
    rollupVersion: "1",
    enclaveUrl: "http://localhost:5071/rpc",
    skyEscrowFactory: FACTORY,
    ...b,
  })
  return {
    schemaVersion: "4",
    deployments: [
      entry(bridge("dai", DAI, MAIN_PORTAL, "a1")),
      entry(bridge("susds", SUSDS, SAVINGS_PORTAL, "a2")),
    ],
  }
}

const deploymentOf = (doc: unknown) =>
  pinnedOxideDeployment(doc, { portal: MAIN_PORTAL }).deployment

/** A factory that deposits into the DAI and sUSDS portals; any other read fails the test. */
const factoryClient = () => ({
  readContract: vi.fn(
    async ({ address, functionName }: { address: string; functionName: string }) => {
      expect(address).toBe(FACTORY)
      if (functionName === "DAI_PORTAL") return MAIN_PORTAL
      if (functionName === "SUSDS_PORTAL") return SAVINGS_PORTAL
      throw new Error(`unexpected read ${functionName}`)
    },
  ),
})

describe("resolveSkySavings", () => {
  it("pairs the bridges the Sky feature binds by role, with its factory and executor, and reads nothing", async () => {
    const client = factoryClient()

    const sky = await resolveSkySavings(client, deploymentOf(manifest({ features: SKY_FEATURE })))

    expect(sky?.deployments.main.portal).toBe(MAIN_PORTAL)
    expect(sky?.deployments.savings.portal).toBe(SAVINGS_PORTAL)
    expect(sky?.deployments.skyExecutor).toBe(SKY_EXECUTOR)
    expect(sky?.factory).toEqual({ address: FACTORY, dai: DAI, sUsds: SUSDS })
    expect(client.readContract).not.toHaveBeenCalled()
  })

  it("prefers the feature over a factory published beside the deployment's fields", async () => {
    const doc = manifest({ features: SKY_FEATURE, skyEscrowFactory: l1("0f") })

    const sky = await resolveSkySavings(factoryClient(), deploymentOf(doc))

    expect(sky?.factory.address).toBe(FACTORY)
  })

  it("falls back to the deployment's factory, pairing the bridges of the portals it deposits into", async () => {
    const client = factoryClient()

    const sky = await resolveSkySavings(
      client,
      deploymentOf(manifest({ skyEscrowFactory: FACTORY })),
    )

    expect(sky?.deployments.main.portal).toBe(MAIN_PORTAL)
    expect(sky?.deployments.savings.portal).toBe(SAVINGS_PORTAL)
    expect(sky?.deployments.skyExecutor).toBe(sky?.deployments.savings.plainWithdrawalExecutor)
    expect(sky?.factory).toEqual({ address: FACTORY, dai: DAI, sUsds: SUSDS })
  })

  it("finds no Savings on a deployment that names neither", async () => {
    await expect(
      resolveSkySavings(factoryClient(), deploymentOf(manifest({}))),
    ).resolves.toBeUndefined()
  })

  it("finds no Savings, and says why, on a feature that binds no DAI bridge of the deployment", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const feature = {
      "fea-sky-sandbox": {
        ...SKY_FEATURE["fea-sky-sandbox"],
        bridges: { sUsds: "brg-susds-sandbox" },
      },
    }

    await expect(
      resolveSkySavings(factoryClient(), deploymentOf(manifest({ features: feature }))),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no usable dai bridge/))
    warn.mockRestore()
  })

  it("finds no Savings on a feature that lists no usable executor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const feature = {
      "fea-sky-sandbox": {
        ...SKY_FEATURE["fea-sky-sandbox"],
        contracts: { skyEscrowFactory: FACTORY, skyWithdrawalExecutor: `0x${"0".repeat(40)}` },
      },
    }

    await expect(
      resolveSkySavings(factoryClient(), deploymentOf(manifest({ features: feature }))),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no usable skyWithdrawalExecutor/))
    warn.mockRestore()
  })

  it("finds a schema v4 fallback's Savings bridge in the manifest's other deployments", async () => {
    const doc = v4Manifest()

    const sky = await resolveSkySavings(factoryClient(), deploymentOf(doc), async () =>
      oxideManifestDeployments(doc),
    )

    expect(sky?.deployments.main.portal).toBe(MAIN_PORTAL)
    expect(sky?.deployments.savings.portal).toBe(SAVINGS_PORTAL)
    expect(sky?.factory).toEqual({ address: FACTORY, dai: DAI, sUsds: SUSDS })
  })

  it("finds no Savings where the fallback factory deposits into no listed portal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const client = { readContract: vi.fn(async () => l1("77")) }

    await expect(
      resolveSkySavings(client, deploymentOf(manifest({ skyEscrowFactory: FACTORY }))),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not portals of the manifest/))
    warn.mockRestore()
  })

  it("fails a fallback whose factory cannot be read, so the read is tried again", async () => {
    const client = { readContract: vi.fn(async () => Promise.reject(new Error("rpc down"))) }

    await expect(
      resolveSkySavings(client, deploymentOf(manifest({ skyEscrowFactory: FACTORY }))),
    ).rejects.toThrow("rpc down")
  })
})

describe("savingsSourceExecutor", () => {
  it("is Main's plain executor for a move in and the Sky executor for a move out", async () => {
    const sky = await resolveSkySavings(
      factoryClient(),
      deploymentOf(manifest({ features: SKY_FEATURE })),
    )
    const deployments = sky!.deployments

    expect(savingsSourceExecutor(deployments, "in")).toBe(deployments.main.plainWithdrawalExecutor)
    expect(savingsSourceExecutor(deployments, "out")).toBe(SKY_EXECUTOR)
  })
})

describe("skyBridgesOfFactory", () => {
  it("finds the bridges of the feature that lists a factory, in any case, and reads nothing", async () => {
    const client = factoryClient()
    const deployments = [deploymentOf(manifest({ features: SKY_FEATURE }))]

    const bridges = await skyBridgesOfFactory(
      client,
      deployments,
      FACTORY.toUpperCase().replace("0X", "0x"),
    )

    expect(bridges?.main.portal).toBe(MAIN_PORTAL)
    expect(bridges?.savings.portal).toBe(SAVINGS_PORTAL)
    expect(client.readContract).not.toHaveBeenCalled()
    await expect(skyBridgesOfFactory(client, deployments, l1("0f"))).resolves.toBeUndefined()
  })

  it("finds the bridges of a factory a deployment publishes beside its fields", async () => {
    const deployments = [deploymentOf(manifest({ skyEscrowFactory: FACTORY }))]

    const bridges = await skyBridgesOfFactory(factoryClient(), deployments, FACTORY)

    expect(bridges?.main.portal).toBe(MAIN_PORTAL)
    expect(bridges?.savings.portal).toBe(SAVINGS_PORTAL)
  })

  it("finds a v4 manifest's bridges of a factory across its one-bridge deployments", async () => {
    const deployments = oxideManifestDeployments(v4Manifest())

    const bridges = await skyBridgesOfFactory(factoryClient(), deployments, FACTORY)

    expect(bridges?.main.portal).toBe(MAIN_PORTAL)
    expect(bridges?.savings.portal).toBe(SAVINGS_PORTAL)
  })
})

describe("the Sky escrow factory's portals", () => {
  const portalsClient = (dai: string, sUsds: string) => ({
    readContract: vi.fn(
      async ({ address, functionName }: { address: string; functionName: string }) => {
        expect(address).toBe(FACTORY)
        if (functionName === "DAI_PORTAL") return dai
        if (functionName === "SUSDS_PORTAL") return sUsds
        throw new Error(`unexpected read ${functionName}`)
      },
    ),
  })
  const savingsOf = async () =>
    (await resolveSkySavings(factoryClient(), deploymentOf(manifest({ features: SKY_FEATURE }))))!

  it("pass when the factory moves between the feature's DAI and sUSDS bridges, in any case", async () => {
    const sky = await savingsOf()
    const portals = await readSkyFactoryPortals(
      portalsClient(MAIN_PORTAL.toUpperCase().replace("0X", "0x"), SAVINGS_PORTAL),
      FACTORY,
    )

    expect(() => assertSkyFactoryPortals(portals, sky.deployments, FACTORY)).not.toThrow()
  })

  it("refuse a move when the factory deposits into other portals, or into the two the wrong way round", async () => {
    const sky = await savingsOf()

    for (const [dai, sUsds] of [
      [MAIN_PORTAL, l1("9e")],
      [SAVINGS_PORTAL, MAIN_PORTAL],
    ]) {
      const portals = await readSkyFactoryPortals(portalsClient(dai, sUsds), FACTORY)
      expect(() => assertSkyFactoryPortals(portals, sky.deployments, FACTORY)).toThrow(
        SkyFactoryMismatchError,
      )
    }
  })
})
