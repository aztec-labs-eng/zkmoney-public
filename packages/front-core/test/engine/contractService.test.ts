// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ContractService,
  DEFAULT_CONTRACTS,
  Network,
  ObsidionWallet,
  type ContractServiceFactory,
} from "@obsidion/sdk"
import {
  contractServiceFactory,
  openContractService,
  type OpenContractServiceDeps,
} from "../../src/engine/contractService"
import { fixed, service as buildService, valueOf } from "../../src/engine/service"

const flush = () => vi.advanceTimersByTimeAsync(0)

const profileOptions = (network: Network) =>
  ({ source: "profile", config: { network, contracts: {} } } as never)

const walletOver = (contractService: ContractServiceFactory) =>
  new ObsidionWallet({ id: "a" } as never, { id: "b" } as never, "0xrollup", { contractService })

/** A built service's reads: its L1 addresses and the sponsor FPC's registration. */
function fakeService() {
  return {
    getNetwork: () => Network.TESTNET,
    getL1Addresses: vi.fn(async () => ({ token: "0xtok", portal: "0xportal" })),
    registerContractWithName: vi.fn(async () => {}),
    getContractAddress: async () => ({ toString: () => "0xfpc" }),
  }
}

let service: ReturnType<typeof fakeService>

function build(o: Partial<OpenContractServiceDeps> = {}) {
  return openContractService({
    wallet: fixed(
      "wallet",
      walletOver(() => service as never),
    ),
    options: {},
    ...o,
  })
}

describe("openContractService", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    service = fakeService()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("takes the wallet's service once a late wallet arrives", async () => {
    let ready!: (w: ObsidionWallet) => void
    const late = buildService(
      "wallet",
      { from: [], retry: "manual" },
      () => new Promise<ObsidionWallet>((r) => (ready = r)),
    )
    const built = build({ wallet: late })
    await flush()
    expect(built.get().status).toBe("pending")
    ready(walletOver(() => service as never))
    await flush()
    expect(valueOf(built)).toBe(service)
  })

  it("builds the wallet's service from the snapshot", async () => {
    const factory = contractServiceFactory({
      network: Network.TESTNET,
      storage: {} as never,
      options: profileOptions(Network.TESTNET),
    })
    const over = vi.fn(factory)
    const wallet = walletOver(over)
    const built = build({ wallet: fixed("wallet", wallet) })
    await flush()
    expect(over.mock.calls[0]?.[0]).toBe(wallet.node)
    expect(over.mock.calls[0]?.[1]).toBe(wallet.pxe)
    expect(valueOf(built)).toBeInstanceOf(ContractService)
    expect(valueOf(built)).toBe(wallet.contractService)
    expect(valueOf(built)?.getNetwork()).toBe(Network.TESTNET)
  })

  it("loads L1 addresses from the built service", async () => {
    const onL1AddressesLoaded = vi.fn()
    build({ options: { onL1AddressesLoaded } })
    await flush()
    expect(onL1AddressesLoaded).toHaveBeenCalledWith(
      expect.objectContaining({ portal: "0xportal" }),
    )
  })

  it("registers the sponsor FPC, unless the host pays no fee through it", async () => {
    build()
    await flush()
    expect(service.registerContractWithName).toHaveBeenCalledWith(DEFAULT_CONTRACTS.sponsorFPC)
    service = fakeService()
    const skipped = build({ registerSponsorFpc: false })
    await flush()
    expect(valueOf(skipped)).toBe(service)
    expect(service.registerContractWithName).not.toHaveBeenCalled()
  })

  it("fails on a snapshot for another network, and retries with a backoff", async () => {
    const factory = contractServiceFactory({
      network: Network.TESTNET,
      storage: {} as never,
      options: profileOptions(Network.SANDBOX),
    })
    const built = build({ wallet: fixed("wallet", walletOver(factory)) })
    await flush()
    expect(built.get()).toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "invariant" }),
    })
  })
})
