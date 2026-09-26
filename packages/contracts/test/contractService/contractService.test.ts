/**
 * ContractService — unit tests.
 *
 * Scope & rationale
 * -----------------
 * `ContractService` has two meaningful responsibilities:
 *
 *   1. Answer address and metadata reads from its source — a config snapshot
 *      (`source: "profile"`, covered in configMode.test.ts) or caller-written storage
 *      (`source: "local-ledger"`, covered here).
 *   2. Resolve contract artifacts from the bundled JSON, or from the PXE cache when only an
 *      address is known. Resolution is local only; exhausting both throws
 *      (`getArtifactForContract`).
 *
 * Only `registerContractWithName` / `registerContractWithAddress` touch PXE + node.
 * Those paths are already exercised end-to-end by every downstream integration test
 * that uses ContractService — the oidc-jwk-cron, fpc_deployer, fee_juice_bridging,
 * alpha_account, paylink/*. If `registerContractWithName` ever regresses the
 * breakage is loud and immediate in those suites. We don't duplicate that here.
 *
 * What we DO test (this file):
 *   - local-ledger reads answer from storage alone: seeded rows come back, misses are
 *     undefined, nothing ever fetches (every service takes an exploding fetchFunction).
 *   - metadata and L1 addresses: a local ledger states none (undefined / throw).
 *   - bundled-artifact resolution is network-free, and a name carrying none throws.
 *   - the mainnet L1 fail-closed guard, and that a valid oxide tuple satisfies it.
 *
 * Runs in ~tens of milliseconds. Belongs in every CI run, not just ci-sandbox.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { ContractService, NodeContractServiceStorage, DEFAULT_CONTRACTS, Network } from "../../src"
import type { ContractName, ContractServiceConfig, FetchFunction } from "@obsidion/core/types"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec/stdlib/abi"
import { Fr } from "@aztec/aztec.js/fields"
import {
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from "@aztec/stdlib/contract"
import { deriveKeys } from "@aztec/stdlib/keys"

const explodingFetch: FetchFunction = async (url) => {
  throw new Error(`Unexpected network call (${url}): test expected zero HTTP traffic`)
}

const SPONSOR_ADDR = "0x00" + "51".repeat(31)

function buildService(opts: {
  network?: Network
  pxe?: unknown
  node?: unknown
  resolveClassArtifact?: (classId: string) => Promise<ContractArtifact>
}) {
  const storage = new NodeContractServiceStorage(opts.network ?? Network.TESTNET)
  const service = ContractService.getInstance(
    storage,
    opts.node as never,
    opts.pxe as never,
    opts.network ?? Network.TESTNET,
    {
      fetchFunction: explodingFetch,
      source: "local-ledger",
      oxideEnvProfile: null,
      ...(opts.resolveClassArtifact ? { resolveClassArtifact: opts.resolveClassArtifact } : {}),
    },
  )
  return { service, storage }
}

describe("ContractService", () => {
  beforeEach(() => {
    ContractService.resetInstance()
  })

  afterAll(() => {
    ContractService.resetInstance()
  })

  describe("local-ledger reads", () => {
    it("answers a seeded address from storage without touching the network", async () => {
      const { service, storage } = buildService({})
      await storage.setContractAddress(
        DEFAULT_CONTRACTS.sponsorFPC,
        AztecAddress.fromStringUnsafe(SPONSOR_ADDR),
      )

      const actual = await service.getContractAddress(DEFAULT_CONTRACTS.sponsorFPC)
      expect(actual?.toString()).toBe(SPONSOR_ADDR)
    })

    it("answers a miss with undefined — there is nothing to refetch", async () => {
      const { service } = buildService({})
      expect(await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)).toBeUndefined()
    })

    it("states no contract metadata — only a profile document carries it", async () => {
      const { service } = buildService({})
      expect((await service.getContractRecord(DEFAULT_CONTRACTS.claimFpc)).meta).toBeUndefined()
    })

    it("throws on an L1 address read — a local ledger states none", async () => {
      const { service } = buildService({})
      await expect(service.getL1Addresses()).rejects.toThrow(/No L1 addresses found/)
    })

    it("pairs the stored address with undefined metadata in getContractRecord", async () => {
      const { service, storage } = buildService({})
      await storage.setContractAddress(
        DEFAULT_CONTRACTS.claimFpc,
        AztecAddress.fromStringUnsafe(SPONSOR_ADDR),
      )

      const record = await service.getContractRecord(DEFAULT_CONTRACTS.claimFpc)
      expect(record.address?.toString()).toBe(SPONSOR_ADDR)
      expect(record.meta).toBeUndefined()
    })
  })

  it("resolves a hardcoded artifact without any network call", async () => {
    const { service } = buildService({})

    const artifact = await service.getArtifactForContract(DEFAULT_CONTRACTS.sponsorFPC)
    expect(artifact).toBeDefined()
    expect(artifact.name).toBe("SponsorFPC")
    expect(artifact.functions.length).toBeGreaterThan(0)
  })

  // Mainnet reads token/portal from the oxide manifest tuple. Without a tuple, the raw
  // pre-overlay values (empty in a profile snapshot) must fail closed rather than boot
  // flows against "". configMode.test.ts pins the no-tuple throw; this pins the guard
  // NOT false-tripping when a valid tuple overlays.
  it("overlays token/portal from a valid oxide tuple on mainnet (guard does not false-trip)", async () => {
    const PROD_SHA = "3e22bc848458039c94b406de93075581e00177e5"
    const PROD_PORTAL = "0xe9431B5A348CF701f10a707c10F71d3A3b8fDB70"
    const prodEntry = {
      schemaVersion: "1",
      label: "v4",
      gitSha: PROD_SHA,
      deployedAt: "2026-06-30T14:36:14.825Z",
      updatedAt: "2026-06-30T14:36:14.825Z",
      portal: PROD_PORTAL,
      l2Token: "0x095dbd2ca68a79e98182f7fd9103d361361044df646999f20ca6523437fde0c3",
      enclaveUrl: "https://enclave.example/rpc",
      rollupVersion: "4127419662",
      chainId: "1",
      plainWithdrawalExecutor: "0x1111111111111111111111111111111111111111",
      l2Broadcaster: `0x${"22".repeat(32)}`,
      token: "0x4cf7d9ef6ea6cbd3b008c9eb50bbe63b107b2d2e",
      nameRegistry: "0x239474855dff1eb58dca3ee877d599e3c6bd0bd2",
      accountFactory: "0xb22f566d8dc7b00d26fe4269e671a4afddce4999",
      entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
      ensDomain: "oxide.eth",
      resolverGatewayUrl: "https://resolver.oxide.example/gateway",
    }
    const prodManifest = { schemaVersion: "4", deployments: [prodEntry] }
    const oxideUrl = "https://oxide.invalid/prod.v4.json"
    const manifestFetch: FetchFunction = async (url) => {
      if (String(url) !== oxideUrl) throw new Error(`unexpected fetch: ${url}`)
      return new Response(JSON.stringify(prodManifest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    const config: ContractServiceConfig = {
      network: Network.MAINNET,
      configVersion: "1.0.0",
      contracts: {},
      oxide: { manifestUrl: oxideUrl, portal: PROD_PORTAL, expectedGitSha: PROD_SHA },
    }
    const storage = new NodeContractServiceStorage(Network.MAINNET)
    const service = ContractService.getInstance(storage, undefined, undefined, Network.MAINNET, {
      fetchFunction: manifestFetch,
      source: "profile",
      config,
    })
    const l1 = await service.getL1Addresses()
    expect(l1.token).toBe(prodEntry.token)
    expect(l1.portal).toBe(prodEntry.portal)
    service.getOxideClient()?.dispose()
  })

  describe("local resolution is exhaustive — there is no remote fallback", () => {
    it("names the contract when the name resolved but no artifact is bundled for it", async () => {
      const { service } = buildService({ network: Network.SANDBOX })

      // Every current ContractName has a bundled artifact, so the only way to reach this
      // guard is a name outside the union — which is exactly what it protects against: a
      // ContractName added without its entry in the lazy-import table.
      await expect(
        service.getArtifactForContract("unbundledContract" as ContractName),
      ).rejects.toThrow(/No hardcoded artifact for contract "unbundledContract"/)
    })

    it("propagates a failing instance lookup instead of reporting it as a cache miss", async () => {
      const pxe = {
        getContractInstance: async () => {
          throw new Error("PXE RPC unavailable")
        },
      }
      const { service } = buildService({ pxe })

      await expect(
        service.getArtifactForContract(DEFAULT_CONTRACTS.sponsorFPC, await AztecAddress.random()),
      ).rejects.toThrow(/PXE RPC unavailable/)
    })

    it("propagates a failing artifact lookup for a known instance", async () => {
      // Both PXE lookups answer undefined when an entry is merely absent, so a
      // throw here means a dead store or an undecodable buffer — never a miss.
      const pxe = {
        getContractInstance: async () => ({ originalContractClassId: "0xabc" }),
        getContractArtifact: async () => {
          throw new Error("artifact buffer corrupt")
        },
      }
      const { service } = buildService({ pxe })

      await expect(
        service.getArtifactForContract(DEFAULT_CONTRACTS.sponsorFPC, await AztecAddress.random()),
      ).rejects.toThrow(/artifact buffer corrupt/)
    })
  })

  describe("historical artifact resolution (resolveClassArtifact set)", () => {
    const unusedResolver = async (classId: string): Promise<ContractArtifact> => {
      throw new Error(`resolver must not run for a bundled class (${classId})`)
    }

    it("resolves an unpublished instance the PXE holds — a user account — by its class", async () => {
      const { service: bundledOnly } = buildService({})
      const bundled = await bundledOnly.getArtifactForContract(
        DEFAULT_CONTRACTS.obsidionAccountAlpha,
      )
      const classId = (await getContractClassFromArtifact(bundled)).id
      ContractService.resetInstance()

      const node = { getContract: async () => undefined }
      const pxe = {
        getContractInstance: async () => ({ originalContractClassId: classId }),
        getContractArtifact: async () => undefined,
      }
      const { service } = buildService({ node, pxe, resolveClassArtifact: unusedResolver })

      const artifact = await service.getArtifactForContract(
        DEFAULT_CONTRACTS.obsidionAccountAlpha,
        await AztecAddress.random(),
      )
      expect(artifact.name).toBe(bundled.name)
    })

    it("an address-anchored lookup throws when neither the node nor the PXE knows the instance", async () => {
      const node = { getContract: async () => undefined }
      const pxe = {
        getContractInstance: async () => undefined,
        getContractArtifact: async () => undefined,
      }
      const { service } = buildService({ node, pxe, resolveClassArtifact: unusedResolver })

      await expect(
        service.getArtifactForContract(
          DEFAULT_CONTRACTS.obsidionAccountAlpha,
          await AztecAddress.random(),
        ),
      ).rejects.toThrow(/Historical contract instance is missing/)
    })
  })

  describe("registerUserAccount runs one registration per account at a time", () => {
    /** A PXE that knows nothing yet and counts what gets registered. */
    function emptyPxe(opts: { failFirstAccountRegistration?: boolean } = {}) {
      const calls = { registerContract: 0, registerAccount: 0, classes: [] as string[] }
      const pxe = {
        getContractArtifact: async () => undefined,
        getContractInstance: async () => undefined,
        registerContractClass: async (artifact: ContractArtifact) => {
          calls.classes.push(artifact.name)
        },
        registerContract: async () => {
          calls.registerContract++
        },
        getRegisteredAccounts: async () => [],
        registerAccount: async () => {
          calls.registerAccount++
          if (opts.failFirstAccountRegistration && calls.registerAccount === 1) {
            throw new Error("keystore unavailable")
          }
        },
      }
      return { pxe, calls }
    }

    async function alphaInstance(service: ContractService, secretKey: Fr) {
      const artifact = await service.getArtifactForContract(DEFAULT_CONTRACTS.obsidionAccountAlpha)
      return getContractInstanceFromInstantiationParams(artifact, {
        salt: new Fr(1n),
        publicKeys: (await deriveKeys(secretKey)).publicKeys,
      })
    }

    it("two concurrent calls for one address register it once", async () => {
      const { pxe, calls } = emptyPxe()
      const { service } = buildService({ pxe })
      const secretKey = Fr.random()
      const instance = await alphaInstance(service, secretKey)

      await Promise.all([
        service.registerUserAccount(instance, secretKey),
        service.registerUserAccount(instance, secretKey),
      ])

      expect(calls.registerContract).toBe(1)
      expect(calls.registerAccount).toBe(1)
    })

    it("a failed registration lets a later call try again", async () => {
      const { pxe, calls } = emptyPxe({ failFirstAccountRegistration: true })
      const { service } = buildService({ pxe })
      const secretKey = Fr.random()
      const instance = await alphaInstance(service, secretKey)

      await expect(service.registerUserAccount(instance, secretKey)).rejects.toThrow(
        /keystore unavailable/,
      )
      await service.registerUserAccount(instance, secretKey)

      expect(calls.registerAccount).toBe(2)
    })

    it("on a catalog build, an empty PXE takes the account from the bundled class, asking neither node nor resolver", async () => {
      const { pxe, calls } = emptyPxe()
      const node = { getContract: vi.fn(async () => undefined) }
      const { service: bundledOnly } = buildService({})
      const bundled = await bundledOnly.getArtifactForContract(
        DEFAULT_CONTRACTS.obsidionAccountAlpha,
      )
      const secretKey = Fr.random()
      const instance = await alphaInstance(bundledOnly, secretKey)
      ContractService.resetInstance()
      const resolver = vi.fn(async (classId: string): Promise<ContractArtifact> => {
        throw new Error(`resolver must not run for a bundled class (${classId})`)
      })
      const { service } = buildService({ pxe, node, resolveClassArtifact: resolver })

      await service.registerUserAccount(instance, secretKey)

      expect(calls.classes).toEqual([bundled.name])
      expect(calls.registerAccount).toBe(1)
      expect(node.getContract).not.toHaveBeenCalled()
      expect(resolver).not.toHaveBeenCalled()
    })

    it("on a catalog build, an account of a class the bundle no longer ships is taken from the resolver", async () => {
      const { pxe, calls } = emptyPxe()
      const node = { getContract: vi.fn(async () => undefined) }
      const { service: bundledOnly } = buildService({})
      const historical = await bundledOnly.getArtifactForContract(
        DEFAULT_CONTRACTS.obsidionAccountAlphaTest,
      )
      const historicalClass = (await getContractClassFromArtifact(historical)).id.toString()
      ContractService.resetInstance()
      const resolver = vi.fn(async (classId: string): Promise<ContractArtifact> => {
        if (classId !== historicalClass) throw new Error(`unexpected class ${classId}`)
        return historical
      })
      const { service } = buildService({ pxe, node, resolveClassArtifact: resolver })
      const secretKey = Fr.random()
      const instance = await getContractInstanceFromInstantiationParams(historical, {
        salt: new Fr(1n),
        publicKeys: (await deriveKeys(secretKey)).publicKeys,
      })

      await service.registerUserAccount(instance, secretKey)

      expect(resolver).toHaveBeenCalledWith(historicalClass)
      expect(calls.classes).toEqual([historical.name])
      expect(node.getContract).not.toHaveBeenCalled()
    })

    it("a reset singleton over another PXE keeps its own in-flight set", async () => {
      // The first instance's registration never settles; the reset one must not wait on it.
      const stuck = emptyPxe()
      stuck.pxe.getContractInstance = () => new Promise(() => {})
      const first = buildService({ pxe: stuck.pxe })
      const secretKey = Fr.random()
      const instance = await alphaInstance(first.service, secretKey)
      void first.service.registerUserAccount(instance, secretKey)

      ContractService.resetInstance()
      const fresh = emptyPxe()
      const second = buildService({ pxe: fresh.pxe })
      await second.service.registerUserAccount(instance, secretKey)

      expect(fresh.calls.registerContract).toBe(1)
      expect(fresh.calls.registerAccount).toBe(1)
      expect(stuck.calls.registerContract).toBe(0)
    })
  })
})
