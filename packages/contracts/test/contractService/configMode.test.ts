import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, resolve } from "path"
import {
  ContractService,
  NodeContractServiceStorage,
  DEFAULT_CONTRACTS,
  Network,
} from "../../src"
import type { ContractServiceConfig, FetchFunction, OxideEnvProfile } from "@obsidion/core/types"
import type { PXE } from "@aztec/pxe/client/lazy"
import { AztecAddress } from "@aztec/stdlib/aztec-address"

const __dirname = dirname(fileURLToPath(import.meta.url))

const MANIFEST_URL = "https://manifest.invalid/dev.json"
const manifestFixture = JSON.parse(
  readFileSync(resolve(__dirname, "../oxide/fixtures/manifest.v4.json"), "utf-8"),
)
const PINNED = manifestFixture.deployments.find((d: { label: string }) => d.label === "v1")
const MANIFEST_L2_TOKEN = PINNED.l2Token as string
const OXIDE: OxideEnvProfile = { manifestUrl: MANIFEST_URL, portal: PINNED.portal }

const hex = (n: number, bytes: number) => "0x" + n.toString(16).padStart(bytes * 2, "0")
const l2 = (n: number) => hex(n, 32)
const l1 = (n: number) => hex(n, 20)

const SPONSOR = l2(0x51)
const CLAIM = l2(0x52)
const POLICY = { maxFeeBps: 30 }

const manifestFetch: FetchFunction = async (url) => {
  if (String(url) !== MANIFEST_URL) throw new Error(`unexpected fetch: ${url}`)
  return new Response(JSON.stringify(manifestFixture), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

const noFetch: FetchFunction = async (url) => {
  throw new Error(`profile mode must not fetch (${url})`)
}

function makeConfig(overrides: Partial<ContractServiceConfig> = {}): ContractServiceConfig {
  return {
    network: Network.TESTNET,
    configVersion: "0.5.0",
    contracts: {
      [DEFAULT_CONTRACTS.sponsorFPC]: { address: SPONSOR, classId: l2(1) },
      [DEFAULT_CONTRACTS.claimFpc]: {
        // Fresh per call: a test that mutates its snapshot must not reach into another's.
        address: CLAIM,
        classId: l2(2),
        meta: { policyManifest: { ...POLICY } },
      },
      [DEFAULT_CONTRACTS.paylinkDirect]: { classId: l2(3) },
    },
    oxide: null,
    ...overrides,
  }
}

/** A PXE that has never heard of any address — enough to reach the terminal artifact errors. */
const emptyPxe = { getContractInstance: async () => undefined } as unknown as PXE

function makeService(
  config: ContractServiceConfig,
  opts: {
    fetchFunction?: FetchFunction
    storage?: NodeContractServiceStorage
    pxe?: PXE
  } = {},
) {
  const storage =
    opts.storage ?? new NodeContractServiceStorage(config.network)
  const service = ContractService.getInstance(storage, undefined, opts.pxe, config.network, {
    fetchFunction: opts.fetchFunction ?? noFetch,
    source: "profile",
    config,
  })
  return { service, storage }
}

beforeEach(() => ContractService.resetInstance())
afterEach(() => ContractService.resetInstance())

describe("ContractService profile mode — reads", () => {
  it("answers addresses and L1 from the snapshot without touching the network", async () => {
    const { service } = makeService(makeConfig())

    expect((await service.getContractAddress(DEFAULT_CONTRACTS.sponsorFPC))?.toString()).toBe(
      SPONSOR,
    )
  })

  it("leaves a class-only contract addressless rather than inventing one", async () => {
    const { service } = makeService(makeConfig())
    expect(await service.getContractAddress(DEFAULT_CONTRACTS.paylinkDirect)).toBeUndefined()
  })

  it("names the version its snapshot was resolved from", () => {
    const { service } = makeService(makeConfig({ configVersion: "1.2.3" }))
    expect(service.getConfigVersion()).toBe("1.2.3")
  })

  it("serves per-contract metadata from the snapshot, paired with its address", async () => {
    const { service } = makeService(makeConfig())
    const record = await service.getContractRecord(DEFAULT_CONTRACTS.claimFpc)
    expect(record.meta?.policyManifest).toEqual(POLICY)
    expect(record.address?.toString()).toBe(CLAIM)
    expect((await service.getContractRecord(DEFAULT_CONTRACTS.sponsorFPC)).meta).toBeUndefined()
  })

  // The caller's (name, address) pair must travel together: re-deriving the address inside the
  // artifact fetch would pair the name with whatever generation's map is current by then.
  it("anchors the PXE probe on the caller's address, never a re-derived one", async () => {
    const probed: string[] = []
    const recordingPxe = {
      getContractInstance: async (addr: AztecAddress) => {
        probed.push(addr.toString())
        return undefined
      },
    } as unknown as PXE
    const config = makeConfig()
    const storage = new NodeContractServiceStorage(config.network)
    const service = ContractService.getInstance(storage, undefined, recordingPxe, config.network, {
      fetchFunction: noFetch,
      source: "profile",
      config,
    })

    const callerAddress = AztecAddress.fromStringUnsafe(l2(0xcafe))
    await service.getArtifactForContract(DEFAULT_CONTRACTS.sponsorFPC, callerAddress)

    expect(probed).toEqual([callerAddress.toString()])
  })

  // The anchor must still engage where the bundle could have answered: the instance's artifact
  // outranks the bundle, which mid-transition is already the incoming class.
  it("an anchored fetch prefers the PXE instance's artifact over the bundle", async () => {
    const artifactAt = (addr: string) => ({ name: `artifact-at-${addr}` })
    const pxe = {
      getContractInstance: async (addr: AztecAddress) => ({
        originalContractClassId: { addr: addr.toString() },
      }),
      getContractArtifact: async (classId: { addr: string }) => artifactAt(classId.addr),
    } as unknown as PXE
    const config = makeConfig()
    const storage = new NodeContractServiceStorage(config.network)
    const service = ContractService.getInstance(storage, undefined, pxe, config.network, {
      fetchFunction: noFetch,
      source: "profile",
      config,
    })

    const anchored = await service.getArtifactForContract(
      DEFAULT_CONTRACTS.sponsorFPC,
      AztecAddress.fromStringUnsafe(SPONSOR),
    )
    expect(anchored.name).toBe(`artifact-at-${SPONSOR}`)

    const named = await service.getArtifactForContract(DEFAULT_CONTRACTS.sponsorFPC)
    expect(named.name).not.toBe(`artifact-at-${SPONSOR}`)
  })


})

describe("ContractService profile mode — the snapshot has one writer", () => {
  it("rejects the address mutator", async () => {
    const { service } = makeService(makeConfig())
    const address = AztecAddress.fromStringUnsafe(l2(9))

    await expect(service.setContractAddress(DEFAULT_CONTRACTS.sponsorFPC, address)).rejects.toThrow(
      /profile mode/,
    )
  })

  it("serves an overridden artifact but keeps answering addresses", async () => {
    const { service } = makeService(makeConfig())
    await service.getArtifactForContract(DEFAULT_CONTRACTS.sponsorFPC)

    const substituted = { name: "substituted" } as Awaited<
      ReturnType<typeof service.getArtifactForContract>
    >
    service.overrideArtifact(DEFAULT_CONTRACTS.sponsorFPC, substituted)
    expect((await service.getArtifactForContract(DEFAULT_CONTRACTS.sponsorFPC)).name).toBe(
      "substituted",
    )
    expect((await service.getContractAddress(DEFAULT_CONTRACTS.sponsorFPC))?.toString()).toBe(
      SPONSOR,
    )
  })
})

describe("ContractService.getConfiguredClassId", () => {
  it("states the snapshot's class id, addressed or not", () => {
    const { service } = makeService(makeConfig())

    expect(service.getConfiguredClassId(DEFAULT_CONTRACTS.sponsorFPC)).toBe(l2(1))
    expect(service.getConfiguredClassId(DEFAULT_CONTRACTS.paylinkDirect)).toBe(l2(3))
  })

  it("fails closed when the version states no class for the contract", () => {
    const { service } = makeService(makeConfig())

    expect(() => service.getConfiguredClassId(DEFAULT_CONTRACTS.paylinkEmail)).toThrow(
      /states no class id/,
    )
  })

  it("states nothing in local-ledger mode, where no document states a class", () => {
    const storage = new NodeContractServiceStorage(Network.TESTNET)
    const service = ContractService.getInstance(storage, undefined, undefined, Network.TESTNET, {
      fetchFunction: noFetch,
      source: "local-ledger",
    })

    expect(service.getConfiguredClassId(DEFAULT_CONTRACTS.paylinkDirect)).toBeUndefined()
  })

  it("names no version in local-ledger mode", () => {
    const storage = new NodeContractServiceStorage(Network.TESTNET)
    const service = ContractService.getInstance(storage, undefined, undefined, Network.TESTNET, {
      fetchFunction: noFetch,
      source: "local-ledger",
    })

    expect(service.getConfigVersion()).toBeUndefined()
  })
})

describe("ContractService profile mode — construction guards", () => {
  it('rejects source: "profile" without a snapshot', () => {
    expect(() =>
      ContractService.getInstance(
        new NodeContractServiceStorage(Network.TESTNET),
        undefined,
        undefined,
        Network.TESTNET,
        { source: "profile" },
      ),
    ).toThrow(/requires a config snapshot/)
  })

  it("rejects a snapshot for a different network than the positional one", () => {
    expect(() =>
      ContractService.getInstance(
        new NodeContractServiceStorage(Network.TESTNET),
        undefined,
        undefined,
        Network.TESTNET,
        {
          source: "profile",
          config: makeConfig({ network: Network.MAINNET }),
        },
      ),
    ).toThrow(/network "mainnet"/)
  })

  it("rejects construction without a source, naming both", () => {
    // JS callers get the runtime guard; TS callers already fail to compile.
    expect(() =>
      ContractService.getInstance(
        new NodeContractServiceStorage(Network.TESTNET),
        undefined,
        undefined,
        Network.TESTNET,
        {} as never,
      ),
    ).toThrow(/"profile".*"local-ledger"/s)
  })

  it("answers a local-ledger address miss with undefined and no fetch", async () => {
    const storage = new NodeContractServiceStorage(Network.TESTNET)
    const service = ContractService.getInstance(storage, undefined, undefined, Network.TESTNET, {
      fetchFunction: noFetch,
      source: "local-ledger",
      oxideEnvProfile: null,
    })

    expect(await service.getContractAddress(DEFAULT_CONTRACTS.sponsorFPC)).toBeUndefined()
  })
})

describe("ContractService profile mode — oxide overlay", () => {
  it("applies the snapshot's oxide pointer across all three address views", async () => {
    // The snapshot carries no oxideToken row at all — the manifest owns it.
    const { service } = makeService(makeConfig({ oxide: OXIDE }), {
      fetchFunction: manifestFetch,
    })

    const byName = await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    expect(byName?.toString()).toBe(MANIFEST_L2_TOKEN)

  })

  it("builds no client at all when the snapshot has no oxide pointer", async () => {
    const { service } = makeService(makeConfig())
    expect(service.getOxideClient()).toBeNull()
  })

  it("fails a mainnet boot closed when nothing supplies the L1 token and portal", async () => {
    const { service } = makeService(makeConfig({ network: Network.MAINNET, oxide: null }))
    await expect(service.getL1Addresses()).rejects.toThrow(/mainnet L1 token\/portal/)
  })
})
