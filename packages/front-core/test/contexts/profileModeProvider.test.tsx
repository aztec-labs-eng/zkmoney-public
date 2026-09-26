/**
 * Hermetic: ContractService, its oxide client, the storages and the aztec/storage contexts are
 * fakes. The fetch function throws, so any registry read fails the test that provokes it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import React from "react"
import { render, waitFor, act } from "@testing-library/react"

const {
  ADDR,
  refs,
  env,
  oxideClient,
  storageContextValue,
  storageStore,
  getItemMock,
  setItemMock,
  getInstanceMock,
  registerContractMock,
  getL1AddressesMock,
  fetchMock,
} = vi.hoisted(() => {
  // Leading zero nibble keeps every fixture below the BN254 field modulus.
  const address = (nibble: string) => `0x0${nibble.repeat(63)}`
  const ADDR = {
    sponsorFPC: address("3"),
    paylinkDirect: address("4"),
    oidcKeyRegistry: address("6"),
  }

  // Assigned once the module's imports have evaluated — vi.hoisted runs before them.
  const refs = { toAddress: null as null | ((hex: string) => any) }

  const oxideClient = {
    tuple: null as any,
    failureMode: null as string | null,
    getCurrentTuple() {
      return this.tuple
    },
    async initialize() {},
    getResolutionState() {
      return { failureMode: this.failureMode }
    },
    reset() {
      this.tuple = null
      this.failureMode = null
    },
  }

  const registerContractMock = vi.fn(async () => {})
  const getL1AddressesMock = vi.fn(async () => ({
    token: "0xtok",
    portal: "0xportal",
  }))
  const fetchMock = vi.fn(async (_url: string) => new Response("{}"))

  const env = {
    network: "testnet" as string,
    client: null as any,
    /** Preinstalled singleton — the v4 exit path's adoptInstance. */
    adopted: null as any,
    singleton: null as any,
    constructionArgs: [] as unknown[][],
  }

  const overlaidToken = () => (env.client?.getCurrentTuple()?.l2Token as string | undefined) ?? null

  /** Mirrors ContractService: the snapshot unioned with the oxide overlay. */
  const makeService = (options: any) => {
    const snapshot: Record<string, string> = {}
    for (const [name, entry] of Object.entries((options?.config?.contracts ?? {}) as any)) {
      const address = (entry as any)?.address
      if (address) snapshot[name] = address
    }
    return {
      getOxideClient: () => env.client,
      getNetwork: () => env.network,
      getL1Addresses: getL1AddressesMock,
      registerContractWithName: registerContractMock,
      getContractAddress: async (contract: string) => {
        const address =
          contract === "oxideToken" ? overlaidToken() ?? snapshot[contract] : snapshot[contract]
        return address ? refs.toAddress!(address) : undefined
      },
    }
  }

  const getInstanceMock = vi.fn((...args: unknown[]) => {
    if (args.length === 0) {
      if (!env.singleton) throw new Error("First call to getInstance requires storage or network")
      return env.singleton
    }
    env.constructionArgs.push(args)
    env.singleton = makeService(args[4])
    return env.singleton
  })

  const storageStore = new Map<string, string>()
  const getItemMock = vi.fn(async (key: string) => storageStore.get(key) ?? null)
  const setItemMock = vi.fn(async (key: string, value: string) => {
    storageStore.set(key, value)
  })
  // Stable across renders: a fresh context value each render would restart the provider's effects.
  const storageContextValue = {
    storageAdapter: {
      getItem: getItemMock,
      setItem: setItemMock,
      removeItem: vi.fn(async () => {}),
    },
  }

  return {
    ADDR,
    refs,
    env,
    oxideClient,
    storageContextValue,
    storageStore,
    getItemMock,
    setItemMock,
    getInstanceMock,
    registerContractMock,
    getL1AddressesMock,
    fetchMock,
  }
})

vi.mock("@obsidion/sdk", async () => {
  const actual = await vi.importActual<typeof import("@obsidion/sdk")>("@obsidion/sdk")
  return {
    ...actual,
    ContractService: { getInstance: getInstanceMock, resetInstance: vi.fn() },
  }
})

vi.mock("src/core", async () => {
  const actual = await vi.importActual<typeof import("src/core")>("src/core")
  return {
    ...actual,
    NetworkStorage: { get: () => ({ getNetwork: async () => ({ type: env.network }) }) },
  }
})

vi.mock("../../src/core/migration/generationRegistry", async () => {
  const actual = await vi.importActual<typeof import("../../src/core/migration/generationRegistry")>(
    "../../src/core/migration/generationRegistry",
  )
  return actual
})

vi.mock("../../src/contexts/useAztecContext", () => {
  const value = {
    obsidionWallet: { _id: "wallet", node: { _id: "node" }, pxe: { _id: "pxe" } },
    currentNetwork: "testnet",
  }
  return { useAztecContext: () => value }
})

vi.mock("../../src/contexts/useStorageContext", () => ({
  useStorageContext: () => storageContextValue,
}))

import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { DEFAULT_CONTRACTS, Network } from "@obsidion/sdk"
import {
  ContractServiceProvider,
  useContractServiceContext,
} from "../../src/contexts/useContractServiceContext"

refs.toAddress = (hex: string) => AztecAddress.fromStringUnsafe(hex)

const RECORD_KEY = "@obsidion/profile-addresses/last-seen/testnet"

const profileOptions = (
  contracts: Partial<Record<string, string>>,
  overrides: Record<string, unknown> = {},
) => ({
  source: "profile",
  config: {
    network: env.network,
    configVersion: "0.5.0",
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([name, address]) => [name, { address, classId: "0x01" }]),
    ),
    oxide: env.client ? { manifestUrl: "https://oxide.invalid/env.json", version: "v4" } : null,
  },
  ...overrides,
})

/** The snapshot most tests use: three snapshot-owned contracts, the token left to the manifest. */
const snapshotContracts = (overrides: Record<string, string> = {}) => ({
  [DEFAULT_CONTRACTS.sponsorFPC]: ADDR.sponsorFPC,
  [DEFAULT_CONTRACTS.paylinkDirect]: ADDR.paylinkDirect,
  [DEFAULT_CONTRACTS.oidcKeyRegistry]: ADDR.oidcKeyRegistry,
  ...overrides,
})

const recordWrites = () => setItemMock.mock.calls.filter(([key]) => key === RECORD_KEY)
const recordReads = () => getItemMock.mock.calls.filter(([key]) => key === RECORD_KEY)

class Boundary extends React.Component<
  { children: React.ReactNode; onError: (e: Error) => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: Error) {
    this.props.onError(e)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** The artifact memo the provider hands through; this test never resolves an artifact. */
const contractStorage = {
  getArtifactCache: () => new Map(),
  setArtifactCache: () => {},
}

function boot(options: Record<string, unknown>, { strict = false } = {}) {
  // A boot starts from whatever instance is already installed — normally none.
  env.singleton = env.adopted
  const probe: { current: ReturnType<typeof useContractServiceContext> | null } = { current: null }
  const errors: Error[] = []
  const Probe = () => {
    probe.current = useContractServiceContext()
    return null
  }
  const tree = (
    <Boundary onError={(e) => errors.push(e)}>
      <ContractServiceProvider storage={contractStorage as any} options={options as any}>
        <Probe />
      </ContractServiceProvider>
    </Boundary>
  )
  const utils = render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
  const current = probe as { current: ReturnType<typeof useContractServiceContext> }
  return { probe: current, errors, ...utils }
}

const settle = async (ms = 50) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  oxideClient.reset()
  storageStore.clear()
  env.network = "testnet"
  env.client = null
  env.adopted = null
  env.singleton = null
  env.constructionArgs = []
  fetchMock.mockImplementation(async () => {
    throw new Error("no network in these tests")
  })
})

describe("profile mode construction", () => {
  it("constructs from the snapshot with no registry URL, and never fetches", async () => {
    const { probe } = boot(profileOptions(snapshotContracts()))

    await waitFor(() => expect(probe.current.contractService).not.toBeNull())
    expect(env.constructionArgs).toHaveLength(1)
    // storage, node, pxe, network, options — and deliberately no positional registry URL.
    expect(env.constructionArgs[0]).toHaveLength(5)
    expect((env.constructionArgs[0][4] as any).source).toBe("profile")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("loads L1 addresses from the snapshot-backed service", async () => {
    const onL1AddressesLoaded = vi.fn()
    boot(profileOptions(snapshotContracts(), { onL1AddressesLoaded }))

    await waitFor(() =>
      expect(onL1AddressesLoaded).toHaveBeenCalledWith(
        expect.objectContaining({ portal: "0xportal" }),
      ),
    )
  })

  it("registers the sponsor FPC from the snapshot (initFPC is unchanged)", async () => {
    boot(profileOptions(snapshotContracts()))

    await waitFor(() =>
      expect(registerContractMock).toHaveBeenCalledWith(DEFAULT_CONTRACTS.sponsorFPC),
    )
  })

  it("a snapshot for another network surfaces through the error boundary", async () => {
    const options = profileOptions(snapshotContracts())
    ;(options.config as any).network = Network.SANDBOX

    const { errors } = boot(options)

    await waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0].message).toMatch(/snapshot is for network "sandbox".*wallet is on "testnet"/)
    expect(recordWrites()).toHaveLength(0)
  })

  it("a mainnet manifest incompatibility is still fatal in profile mode", async () => {
    env.network = Network.MAINNET
    env.client = oxideClient
    oxideClient.failureMode = "manifest-incompatible"

    const { errors } = boot(profileOptions(snapshotContracts()))

    await waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0].message).toMatch(/Mainnet oxide manifest is incompatible/)
  })
  it("an adopted instance is used as-is, whatever the props say", async () => {
    env.adopted = {
      getOxideClient: () => null,
      getNetwork: () => env.network,
      getContractAddress: async () => refs.toAddress!(ADDR.sponsorFPC),
      registerContractWithName: registerContractMock,
    }

    const { probe } = boot(profileOptions(snapshotContracts()))

    await waitFor(() => expect(probe.current.contractService).not.toBeNull())
    await settle()
    expect(registerContractMock).toHaveBeenCalledWith(DEFAULT_CONTRACTS.sponsorFPC)
    expect(env.constructionArgs).toHaveLength(0)
    expect(recordReads()).toHaveLength(0)
    expect(recordWrites()).toHaveLength(0)
  })

})
