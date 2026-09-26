/**
 * NetworkStorage — active-network selection across all three networks.
 *
 * The default entry that is `current` is driven by `config.activeNetwork`, the
 * mainnet entry is gated behind `config.enableMainnet` (R9: off keeps a testnet
 * install mainnet-free), and `isProd()` is "not sandbox" so testnet AND mainnet
 * are production. The node client is mocked so `getNetworkId` never hits a real
 * node; the singleton is reset between cases.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { Network } from "@obsidion/core/constants"
import {
  NetworkStorage,
  NETWORK_STORAGE_KEY,
  type IStorageAdapter,
  type NetworkConfig,
} from "../../src/core/storages/index"
import { setActiveGenerationNode } from "../../src/core/activeGenerationNode"

vi.mock("@aztec/aztec.js/node", () => ({
  createAztecNodeClient: () => ({
    getBlock: async () => ({ hash: async () => ({ toString: () => "0xtestblockhash" }) }),
  }),
}))

class InMemoryStorage implements IStorageAdapter {
  private store = new Map<string, string>()
  async getItem(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
  async removeItem(key: string): Promise<void> {
    this.store.delete(key)
  }
  async clear(): Promise<void> {
    this.store.clear()
  }
  raw(key: string): string | undefined {
    return this.store.get(key)
  }
  seed(key: string, value: string): void {
    this.store.set(key, value)
  }
}

const resetSingleton = () => {
  ;(NetworkStorage as unknown as { instance: NetworkStorage | null }).instance = null
}

describe("NetworkStorage — active-network selection", () => {
  beforeEach(resetSingleton)

  it("mainnet build (flag on): mainnet is current, isProd true, entry carries chain-1 L1 RPC", async () => {
    const adapter = new InMemoryStorage()
    const storage = NetworkStorage.get(adapter, {
      activeNetwork: Network.MAINNET,
      nodeUrl: "http://mainnet-node.test",
      enableMainnet: true,
    })
    const configs = await storage.getAllNetworkConfigs()
    expect(Object.keys(configs).sort()).toEqual(
      [Network.MAINNET, Network.SANDBOX, Network.TESTNET].sort(),
    )
    const mainnet = configs[Network.MAINNET]
    expect(mainnet.type).toBe(Network.MAINNET)
    expect(mainnet.current).toBe(true)
    expect(mainnet.l1RpcUrl).toBe("https://ethereum-rpc.publicnode.com")
    expect((await storage.getNetwork()).type).toBe(Network.MAINNET)
    expect(await storage.isProd()).toBe(true)
  })

  it("testnet build (flag off): testnet current, isProd true, no mainnet row (R9)", async () => {
    const adapter = new InMemoryStorage()
    const storage = NetworkStorage.get(adapter, { activeNetwork: Network.TESTNET })
    const configs = await storage.getAllNetworkConfigs()
    expect(Object.keys(configs).sort()).toEqual([Network.SANDBOX, Network.TESTNET].sort())
    expect(configs[Network.TESTNET].current).toBe(true)
    expect(configs[Network.SANDBOX].current).toBe(false)
    expect(await storage.isProd()).toBe(true)
    // The persisted map must not contain mainnet either.
    const persisted = JSON.parse(adapter.raw(NETWORK_STORAGE_KEY)!) as Record<string, NetworkConfig>
    expect(persisted[Network.MAINNET]).toBeUndefined()
  })

  it("fresh testnet install uses the runtime node and L1 RPC URLs", async () => {
    const adapter = new InMemoryStorage()
    const storage = NetworkStorage.get(adapter, {
      activeNetwork: Network.TESTNET,
      nodeUrl: "http://canonical-testnet-node",
      l1RpcUrl: "http://canonical-testnet-l1",
    })

    const current = await storage.getNetwork()

    expect(current.nodeUrl).toBe("http://canonical-testnet-node")
    expect(current.l1RpcUrl).toBe("http://canonical-testnet-l1")
  })

  it("sandbox build (flag off): sandbox current, isProd false", async () => {
    const adapter = new InMemoryStorage()
    const storage = NetworkStorage.get(adapter, {
      activeNetwork: Network.SANDBOX,
      nodeUrl: "http://localhost:8080",
    })
    const configs = await storage.getAllNetworkConfigs()
    expect(Object.keys(configs).sort()).toEqual([Network.SANDBOX, Network.TESTNET].sort())
    expect(configs[Network.SANDBOX].current).toBe(true)
    expect(configs[Network.TESTNET].current).toBe(false)
    expect(await storage.isProd()).toBe(false)
  })

  it("mainnet flag OFF suppresses the mainnet row even when built as mainnet", async () => {
    const adapter = new InMemoryStorage()
    const storage = NetworkStorage.get(adapter, {
      activeNetwork: Network.MAINNET,
      enableMainnet: false,
    })
    const configs = await storage.getAllNetworkConfigs()
    expect(configs[Network.MAINNET]).toBeUndefined()
  })

  it("syncStoredConfigsWithRuntime patches the ACTIVE network's stored entry", async () => {
    const adapter = new InMemoryStorage()
    // Seed a persisted map with a stale testnet node URL.
    adapter.seed(
      NETWORK_STORAGE_KEY,
      JSON.stringify({
        [Network.TESTNET]: {
          name: Network.TESTNET,
          displayName: Network.TESTNET,
          description: "Official Aztec Testnet",
          id: "0xstale",
          type: Network.TESTNET,
          nodeUrl: "http://old-testnet-node",
          l1RpcUrl: "http://old-l1",
          current: true,
        },
        [Network.SANDBOX]: {
          name: Network.SANDBOX,
          displayName: Network.SANDBOX,
          description: "Localhost Sandbox. PXE is in browser by default.",
          id: "",
          type: Network.SANDBOX,
          nodeUrl: "http://localhost:8080",
          l1RpcUrl: "http://localhost:8545",
          current: false,
        },
      }),
    )
    const storage = NetworkStorage.get(adapter, {
      activeNetwork: Network.TESTNET,
      nodeUrl: "http://fresh-testnet-node",
    })
    const configs = await storage.getAllNetworkConfigs()
    expect(configs[Network.TESTNET].nodeUrl).toBe("http://fresh-testnet-node")
    // node URL change clears the cached chain id
    expect(configs[Network.TESTNET].id).toBe("")
    // the non-active entry keeps its own URLs
    expect(configs[Network.SANDBOX].nodeUrl).toBe("http://localhost:8080")
  })

  it("re-points `current` when a map persisted by another build names a different network", async () => {
    const adapter = new InMemoryStorage()
    // What a sandbox run leaves behind on an origin a testnet build later reuses.
    adapter.seed(
      NETWORK_STORAGE_KEY,
      JSON.stringify({
        [Network.TESTNET]: {
          name: Network.TESTNET,
          displayName: Network.TESTNET,
          description: "Official Aztec Testnet",
          id: "",
          type: Network.TESTNET,
          nodeUrl: "https://testnet-node.test",
          l1RpcUrl: "https://sepolia.test",
          current: false,
        },
        [Network.SANDBOX]: {
          name: Network.SANDBOX,
          displayName: Network.SANDBOX,
          description: "Localhost Sandbox. PXE is in browser by default.",
          id: "0x4ed7c70f",
          type: Network.SANDBOX,
          nodeUrl: "http://localhost:8080",
          l1RpcUrl: "http://localhost:8545",
          current: true,
        },
      }),
    )
    const storage = NetworkStorage.get(adapter, {
      activeNetwork: Network.TESTNET,
      nodeUrl: "https://testnet-node.test",
    })

    const network = await storage.getNetwork()
    expect(network.type).toBe(Network.TESTNET)
    expect(network.nodeUrl).toBe("https://testnet-node.test")

    const configs = await storage.getAllNetworkConfigs()
    expect(configs[Network.SANDBOX].current).toBe(false)
    // and the flip is persisted, not just returned
    expect(JSON.parse(adapter.raw(NETWORK_STORAGE_KEY)!)[Network.SANDBOX].current).toBe(false)
  })
})

// getAllNetworkConfigs fail-soft: malformed persisted configs (e.g. inherited
// from an older install) are treated like missing ones and rebuilt from
// defaults instead of throwing out of boot. getNetworkId fingerprints the
// network from the generation node's getNodeInfo().l1ContractAddresses
// .rollupAddress — publish a fake one.
const fakeNode = {
  getNodeInfo: async () => ({
    l1ContractAddresses: { rollupAddress: { toString: () => "0xrollup" } },
  }),
} as unknown as Parameters<typeof setActiveGenerationNode>[0]

const freshStorage = () => {
  resetSingleton()
  const adapter = new InMemoryStorage()
  const storage = NetworkStorage.get(adapter, { activeNetwork: Network.SANDBOX })
  return { adapter, storage }
}

describe("NetworkStorage.getAllNetworkConfigs", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    setActiveGenerationNode(fakeNode)
  })

  it("malformed persisted JSON → rebuilt defaults, no throw", async () => {
    const { adapter, storage } = freshStorage()
    await adapter.setItem(NETWORK_STORAGE_KEY, "{not json!!")
    const configs = await storage.getAllNetworkConfigs()
    expect(Object.keys(configs).length).toBeGreaterThan(0)
    // the malformed blob was replaced by the rebuilt defaults
    expect(JSON.parse((await adapter.getItem(NETWORK_STORAGE_KEY))!)).toEqual(configs)
  })

  it("valid persisted configs → returned unchanged", async () => {
    const { adapter, storage } = freshStorage()
    const seeded = await storage.getAllNetworkConfigs() // default-init pass
    const before = await adapter.getItem(NETWORK_STORAGE_KEY)
    const configs = await storage.getAllNetworkConfigs()
    expect(configs).toEqual(seeded)
    expect(await adapter.getItem(NETWORK_STORAGE_KEY)).toBe(before)
  })

  it("absent key → default-init (already-guarded branch unchanged)", async () => {
    const { storage } = freshStorage()
    const configs = await storage.getAllNetworkConfigs()
    const current = Object.values(configs).find((c) => c.current)
    expect(current).toBeDefined()
    expect(current!.id).toBe("0xrollup")
  })

  it("back-fills a stored current network whose id never populated", async () => {
    const { adapter, storage } = freshStorage()
    const seeded = await storage.getAllNetworkConfigs()
    // Simulate a pre-fix boot that stored an empty id (fingerprint RPC failed).
    Object.values(seeded).find((c) => c.current)!.id = ""
    await adapter.setItem(NETWORK_STORAGE_KEY, JSON.stringify(seeded))

    const configs = await storage.getAllNetworkConfigs()
    expect(Object.values(configs).find((c) => c.current)!.id).toBe("0xrollup")
  })
})
