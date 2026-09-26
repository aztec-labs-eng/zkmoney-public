import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { ContractArtifact } from "@aztec/stdlib/abi"
import { Network } from "@obsidion/core/constants"
import type { ContractName, ILocalLedgerStorage } from "@obsidion/core/types"

/**
 * In-memory storage for `source: "local-ledger"` — deploy tooling and the sdk/backend test
 * harnesses, which write their own deployments and read them back within one process. Nothing
 * here is persisted: a run records what it deployed, and the next run starts empty.
 */
export class NodeContractServiceStorage implements ILocalLedgerStorage {
  private contractAddressMap = new Map<Network, Map<ContractName, AztecAddress>>()
  private artifactCache = new Map<Network, Map<ContractName, Promise<ContractArtifact>>>()

  constructor(private network: Network = Network.TESTNET) {}

  private ensureArtifactCache(): Map<ContractName, Promise<ContractArtifact>> {
    if (!this.artifactCache.has(this.network)) {
      this.artifactCache.set(this.network, new Map())
    }
    return this.artifactCache.get(this.network)!
  }

  private ensureAddressMap(): Map<ContractName, AztecAddress> {
    if (!this.contractAddressMap.has(this.network)) {
      this.contractAddressMap.set(this.network, new Map())
    }
    return this.contractAddressMap.get(this.network)!
  }

  getArtifactCache(): Map<ContractName, Promise<ContractArtifact>> {
    return this.ensureArtifactCache()
  }
  setArtifactCache(name: ContractName, artifactPromise: Promise<ContractArtifact>): void {
    this.ensureArtifactCache().set(name, artifactPromise)
  }

  async getContractAddressMap(): Promise<Map<ContractName, AztecAddress>> {
    return this.ensureAddressMap()
  }
  async getContractAddress(name: ContractName): Promise<AztecAddress | null> {
    return this.ensureAddressMap().get(name) ?? null
  }
  async setContractAddress(name: ContractName, address: AztecAddress): Promise<void> {
    this.ensureAddressMap().set(name, address)
  }
}
