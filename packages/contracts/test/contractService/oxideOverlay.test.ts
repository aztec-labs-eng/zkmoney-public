/**
 * ContractService oxide overlay — unit tests.
 *
 * Proves the read-time overlay invariants:
 *   - storage keeps RAW ledger values while reads return overlaid ones
 *     (read-time derivation, nothing persisted)
 *   - getRegistry* pre-overlay accessors expose the comparison anchors
 *   - sandbox (no profile) → no client constructed, reads byte-identical
 *   - resetInstance() disposes the client; a fresh instance overlays again
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, resolve } from "path"
import {
  ContractService,
  NodeContractServiceStorage,
  DEFAULT_CONTRACTS,
  Network,
  OxideTupleUnresolvedError,
} from "../../src"
import type { ContractServiceConfig, FetchFunction, OxideEnvProfile } from "@obsidion/core/types"
import { AztecAddress } from "@aztec/stdlib/aztec-address"

const __dirname = dirname(fileURLToPath(import.meta.url))

const MANIFEST_PATH = resolve(__dirname, "../oxide/fixtures/manifest.v4.json")
const manifestFixture = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"))

// A manifest whose oxide-owned values all differ from the raw source values below, so
// every overlay assertion is a real divergence rather than a coincidence.
const ROLLED_L2_TOKEN = "0x2222222222222222222222222222222222222222222222222222222222222222"
const ROLLED_PORTAL = "0x1111111111111111111111111111111111111111"
const ROLLED_TOKEN = "0x3333333333333333333333333333333333333333"
const rolledManifest = JSON.parse(JSON.stringify(manifestFixture))
const rolledEntry = rolledManifest.deployments.find((d: { label: string }) => d.label === "v1")
rolledEntry.l2Token = ROLLED_L2_TOKEN
rolledEntry.portal = ROLLED_PORTAL
rolledEntry.token = ROLLED_TOKEN
rolledEntry.updatedAt = "2026-06-09T00:00:00.000Z"

const MANIFEST_URL = "https://manifest.invalid/dev.json"

const PROFILE: OxideEnvProfile = { manifestUrl: MANIFEST_URL, portal: ROLLED_PORTAL }

const RAW_ASSERTED = "0x0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const RAW_SPONSOR = "0x0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const manifestOnlyFetch =
  (manifestBody: unknown | Error): FetchFunction =>
  async (url) => {
    if (String(url) !== MANIFEST_URL) throw new Error(`unexpected fetch: ${url}`)
    if (manifestBody instanceof Error) throw manifestBody
    return new Response(JSON.stringify(manifestBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

function makeConfig(overrides: Partial<ContractServiceConfig> = {}): ContractServiceConfig {
  return {
    network: Network.TESTNET,
    configVersion: "0.5.0",
    contracts: {},
    oxide: PROFILE,
    ...overrides,
  }
}

function makeService(opts: {
  network?: Network
  manifest?: unknown | Error
  oxideEnvProfile?: OxideEnvProfile | null
  source?: "profile" | "local-ledger"
  config?: ContractServiceConfig
}) {
  const storage = new NodeContractServiceStorage(opts.network ?? Network.TESTNET)
  const service = ContractService.getInstance(
    storage,
    undefined,
    undefined,
    opts.network ?? Network.TESTNET,
    {
      fetchFunction: manifestOnlyFetch(opts.manifest ?? rolledManifest),
      source: opts.source ?? "local-ledger",
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.oxideEnvProfile !== undefined ? { oxideEnvProfile: opts.oxideEnvProfile } : {}),
    },
  )
  return { service, storage }
}

async function makeSeededLedgerService(opts: {
  manifest?: unknown | Error
  oxideEnvProfile?: OxideEnvProfile | null
}) {
  const built = makeService({ source: "local-ledger", ...opts })
  await built.storage.setContractAddress(
    DEFAULT_CONTRACTS.oxideToken,
    AztecAddress.fromStringUnsafe(RAW_ASSERTED),
  )
  await built.storage.setContractAddress(
    DEFAULT_CONTRACTS.sponsorFPC,
    AztecAddress.fromStringUnsafe(RAW_SPONSOR),
  )
  return built
}

beforeEach(() => {
  ContractService.resetInstance()
})
afterEach(() => {
  ContractService.resetInstance()
})

describe("ContractService oxide overlay", () => {
  it("overlays manifest token/portal in getL1Addresses", async () => {
    const { service } = makeService({ source: "profile", config: makeConfig() })
    const l1 = await service.getL1Addresses()
    expect(l1.token).toBe(ROLLED_TOKEN)
    expect(l1.portal).toBe(ROLLED_PORTAL)
  })

  it("overlays tuple.l2Token for oxideToken; other contracts untouched", async () => {
    const { service } = await makeSeededLedgerService({ oxideEnvProfile: PROFILE })
    const asserted = await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    expect(asserted?.toString()).toBe(ROLLED_L2_TOKEN)

    const sponsorFPC = await service.getContractAddress(DEFAULT_CONTRACTS.sponsorFPC)
    expect(sponsorFPC?.toString()).toBe(RAW_SPONSOR)
  })

  it("storage keeps RAW ledger values while reads return overlaid ones", async () => {
    const { service, storage } = await makeSeededLedgerService({ oxideEnvProfile: PROFILE })
    const read = await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    const stored = await storage.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    expect(read?.toString()).toBe(ROLLED_L2_TOKEN)
    expect(stored?.toString()).toBe(RAW_ASSERTED)
    expect(read?.toString()).not.toBe(stored?.toString())
  })

  it("sandbox (no profile): oxide client never constructed, reads are raw ledger values", async () => {
    const { service, storage } = makeService({ network: Network.SANDBOX, source: "local-ledger" })
    expect(service.getOxideClient()).toBeNull()

    const local = AztecAddress.fromStringUnsafe(ROLLED_L2_TOKEN)
    await storage.setContractAddress(DEFAULT_CONTRACTS.oxideToken, local)
    const read = await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    expect(read?.equals(local)).toBe(true)
  })

  it("deploy mode (local-ledger + oxideEnvProfile null) on testnet: overlay off", async () => {
    const { service, storage } = makeService({ source: "local-ledger", oxideEnvProfile: null })
    expect(service.getOxideClient()).toBeNull()

    const local = AztecAddress.fromStringUnsafe(ROLLED_L2_TOKEN)
    await storage.setContractAddress(DEFAULT_CONTRACTS.oxideToken, local)
    const read = await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    expect(read?.equals(local)).toBe(true)
  })

  it("local-ledger with an explicit profile still overlays: source and overlay are independent", async () => {
    const { service } = await makeSeededLedgerService({ oxideEnvProfile: PROFILE })
    expect(service.getOxideClient()).not.toBeNull()
    const read = await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    expect(read?.toString()).toBe(ROLLED_L2_TOKEN)
  })

  it("explicit oxideEnvProfile: null disables the overlay on testnet", async () => {
    const { service } = await makeSeededLedgerService({ oxideEnvProfile: null })
    expect(service.getOxideClient()).toBeNull()
    const read = await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    expect(read?.toString()).toBe(RAW_ASSERTED)
  })

  it("manifest down with no cache: whole-source fallback to the raw source values", async () => {
    const config = makeConfig()
    config.contracts[DEFAULT_CONTRACTS.oxideToken] = {
      address: RAW_ASSERTED,
      classId: "0x" + "07".repeat(32),
    }
    const { service } = makeService({
      source: "profile",
      config,
      manifest: new Error("manifest unreachable"),
    })
    const l1 = await service.getL1Addresses()
    expect(l1.token).toBe("")
    expect(l1.portal).toBe("")
    const read = await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    expect(read?.toString()).toBe(RAW_ASSERTED)
    // Boot-retry was scheduled (no tuple anywhere); dispose via reset so the
    // timer cannot fire into a dead test context.
    ContractService.resetInstance()
  })

  // Mainnet has no state where the token address is legitimately unknowable, so the profile
  // read fails where the cause is instead of a generic "no address" far downstream.
  it("mainnet profile mode, manifest down, no cache: oxideToken read throws", async () => {
    const { service } = makeService({
      network: Network.MAINNET,
      source: "profile",
      config: makeConfig({ network: Network.MAINNET }),
      manifest: new Error("manifest unreachable"),
    })
    const rejection = await service
      .getContractAddress(DEFAULT_CONTRACTS.oxideToken)
      .then(() => null)
      .catch((e: unknown) => e)
    expect(rejection).toBeInstanceOf(OxideTupleUnresolvedError)
    expect(String(rejection)).toMatch(/mainnet oxideToken is unresolved/)
    // Only the token fails closed — other profile reads keep the soft path.
    await expect(service.getContractAddress(DEFAULT_CONTRACTS.sponsorFPC)).resolves.toBeUndefined()
    ContractService.resetInstance()
  })

  it("mainnet profile mode with a snapshot oxideToken row: the row is honored, no throw", async () => {
    const config = makeConfig({ network: Network.MAINNET })
    config.contracts[DEFAULT_CONTRACTS.oxideToken] = {
      address: RAW_ASSERTED,
      classId: "0x" + "07".repeat(32),
    }
    const { service } = makeService({
      network: Network.MAINNET,
      source: "profile",
      config,
      manifest: new Error("manifest unreachable"),
    })
    const read = await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    expect(read?.toString()).toBe(RAW_ASSERTED)
    ContractService.resetInstance()
  })

  it("off mainnet the same outage degrades softly: oxideToken reads undefined", async () => {
    const { service } = makeService({
      source: "profile",
      config: makeConfig(),
      manifest: new Error("manifest unreachable"),
    })
    await expect(
      service.getContractAddress(DEFAULT_CONTRACTS.oxideToken),
    ).resolves.toBeUndefined()
    ContractService.resetInstance()
  })

  it("resetInstance() disposes the client; a fresh instance overlays again", async () => {
    const { service } = await makeSeededLedgerService({ oxideEnvProfile: PROFILE })
    await service.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    const firstClient = service.getOxideClient()
    expect(firstClient?.getCurrentTuple()).not.toBeNull()

    ContractService.resetInstance()

    // Disposed clients never notify: subscribing post-dispose sees nothing
    // even if a refresh is forced.
    let notified = 0
    firstClient?.subscribe(() => notified++)
    await firstClient?.refresh()
    expect(notified).toBe(0)

    const { service: fresh } = await makeSeededLedgerService({ oxideEnvProfile: PROFILE })
    const read = await fresh.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    expect(read?.toString()).toBe(ROLLED_L2_TOKEN)
    expect(fresh.getOxideClient()).not.toBe(firstClient)
  })
})
