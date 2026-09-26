import { resolveInstanceArtifact } from "./classArtifactCatalog.js"
//purpose of this class is to get all of the artifacts when they are needed within the app.

import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { AztecNode } from "@aztec/aztec.js/node"
import { ContractBase, Contract } from "@aztec/aztec.js/contracts"
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet"
import {
  CompleteAddress,
  computePartialAddress,
  getContractClassFromArtifact,
  ContractInstanceWithAddress,
  ContractInstancePreimageWithAddress,
} from "@aztec/stdlib/contract"
import { deriveKeys } from "@aztec/stdlib/keys"
import { ContractArtifact } from "@aztec/stdlib/abi"
import { DEFAULT_CONTRACTS, Network } from "@obsidion/core/constants"
import type {
  ContractServiceConfig,
  ContractServiceOptions,
  ContractName,
  IContractServiceStorage,
  ILocalLedgerStorage,
  FetchFunction,
  OxideEnvProfile,
  OxideEnvTuple,
} from "@obsidion/core/types"
import { pinnedEntryPolicy, requireNonZeroL1Address } from "@obsidion/core/oxide"
import { getHardcodedArtifact, registerContractInPXE } from "./utils.js"
import { OxideEnvRegistryClient } from "./OxideEnvRegistryClient.js"
import type { PXE } from "@aztec/pxe/client/lazy"

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

/** `meta` must be JSON data (a profile round-trips it) — name the contract, not a bare serializer error. */
function cloneMeta(contract: string, meta: Record<string, unknown>): Record<string, unknown> {
  try {
    return deepFreeze(JSON.parse(JSON.stringify(meta)) as Record<string, unknown>)
  } catch (error) {
    throw new Error(
      `Config snapshot: ${contract}.meta must be JSON data (${(error as Error).message})`,
    )
  }
}

/**
 * A mainnet read needed the oxide tuple and none resolved — an outage or configuration fault
 * that must surface, distinct from "contract not deployed" (which callers may swallow).
 */
export class OxideTupleUnresolvedError extends Error {}

/**
 * Simplified service for managing contract artifacts and instances
 */
export class ContractService {
  /** Test-injected artifact substitutions (overrideArtifact); consulted on every resolution path. */
  private artifactOverrides = new Map<ContractName, ContractArtifact>()
  private node: AztecNode
  private pxe: PXE
  private network: Network
  private storage: IContractServiceStorage
  private options: ContractServiceOptions
  private fetch: FetchFunction
  /** Where addresses come from: a config snapshot, or the caller's ledger. */
  private readonly source: "profile" | "local-ledger"
  // Profile mode's truth, fixed at construction. `config` and its derived address map are set
  // together and never replaced, so a read that awaits cannot observe them disagreeing.
  private config: ContractServiceConfig | null = null
  private readonly configAddresses: ReadonlyMap<ContractName, AztecAddress> = new Map()
  // Oxide env-registry overlay: profile resolved at construction; client is
  // lazy (construction never fetches) and owns the applied tuple. Oxide-owned
  // values are overlaid at READ TIME, never folded into the snapshot.
  private oxideProfile: OxideEnvProfile | null = null
  private oxideClient: OxideEnvRegistryClient | null = null
  // Singleton instance
  private static instance: ContractService | null = null
  /** One registration per account at a time: a second caller for the same address awaits the first. */
  private readonly accountRegistrations = new Map<string, Promise<void>>()

  /**
   * Get or create the singleton instance.
   *
   * @param storage - Storage implementation (required)
   * @param node - Aztec node instance
   * @param pxe - PXE instance
   * @param network - Network (testnet, sandbox, mainnet)
   * @param options - Contract service options; `source` picks where addresses come from
   *
   * Callers that never touch L2 contracts can omit `storage`, `node`, and `pxe` — methods that
   * need them throw at call time.
   *
   * @example
   * // Profile mode (both wallets, backend services)
   * const service = ContractService.getInstance(storage, node, pxe, network, {
   *   source: "profile",
   *   config: snapshot,
   * })
   *
   * @example
   * // Local-ledger mode (deploy tooling, test harnesses)
   * const service = ContractService.getInstance(storage, node, pxe, network, {
   *   source: "local-ledger",
   * })
   */
  public static getInstance(
    storage?: IContractServiceStorage,
    node?: AztecNode,
    pxe?: PXE,
    network?: Network,
    options?: ContractServiceOptions,
  ): ContractService {
    if (ContractService.instance) {
      return ContractService.instance
    }

    // First call creates the singleton — callers that never touch L2 contracts
    // can omit storage/node/pxe. Full L2 callers must provide all three.
    if (!storage && !network) {
      throw new Error("First call to getInstance requires at least storage or network parameter")
    }

    ContractService.instance = new ContractService(storage, node, pxe, network, options)
    console.log("ContractService instance created")
    return ContractService.instance
  }

  /**
   * Reset the singleton instance (primarily for testing).
   * Disposes the outgoing instance's oxide client so no retry timer or
   * subscription outlives its instance (the relayer's boot does a
   * build-read-reset-rebuild dance; tests reset constantly).
   */
  public static resetInstance(): void {
    ContractService.instance?.oxideClient?.dispose()
    ContractService.instance = null
  }

  /**
   * Adopt an externally-built instance as the singleton. The generation seam:
   * on a v4-canonical device the platform builds the v4 ContractService (from
   * the frozen v4 sdk, with v4 artifacts + node/PXE) and installs it here, so
   * every `getInstance()` caller in the current stack — TokenService /
   * ServiceBase registration, useAsset, etc. — operates on v4 data instead of
   * loading v5 artifacts against a v4 node (which fails the bb VK size check).
   * Idempotent-ish: a later `getInstance(...)` with args won't recreate while
   * this is set.
   */
  public static adoptInstance(instance: ContractService): void {
    ContractService.instance = instance
  }

  private constructor(
    storage: IContractServiceStorage | undefined,
    node: AztecNode | undefined,
    pxe: PXE | undefined,
    network: Network = Network.TESTNET,
    options?: ContractServiceOptions,
  ) {
    this.storage = storage!
    this.node = node!
    this.pxe = pxe!
    this.network = network
    // A runtime guard for JS callers — the type already requires `source`.
    if (options?.source !== "profile" && options?.source !== "local-ledger") {
      throw new Error(
        'ContractServiceOptions.source is required: "profile" (a config snapshot supplies ' +
          'addresses) or "local-ledger" (the caller writes them into storage).',
      )
    }
    this.options = options
    // Use provided fetch function or default to global fetch
    this.fetch = this.options.fetchFunction || globalThis.fetch?.bind(globalThis) || fetch
    this.source = this.options.source

    if (this.source === "profile") {
      const config = this.options.config
      if (!config) {
        throw new Error('source: "profile" requires a config snapshot')
      }
      this.requireMatchingNetwork(config)
      this.config = ContractService.snapshotOf(config)
      this.configAddresses = ContractService.addressesOf(this.config)
    }

    this.oxideProfile = this.oxideOverride(this.config) ?? null
  }

  /** An explicit option wins outright (`null` included); else the config snapshot decides. */
  private oxideOverride(config: ContractServiceConfig | null): OxideEnvProfile | null | undefined {
    if (this.options.oxideEnvProfile !== undefined) return this.options.oxideEnvProfile
    return config ? config.oxide : undefined
  }

  /** The positional network gates mainnet strictness — a wrong-chain snapshot must never install silently. */
  private requireMatchingNetwork(config: ContractServiceConfig): void {
    if (config.network !== this.network) {
      throw new Error(
        `Config snapshot is for network "${config.network}" but this ContractService is on ` +
          `"${this.network}"`,
      )
    }
  }

  /**
   * A private copy of the caller's snapshot — later mutations through the caller's reference
   * must not desync `config` from `configAddresses`. `meta` is deep-frozen AND copied: ClaimFPC's
   * policy cache keys on the manifest object's identity, and getRegistryContractMetadata hands
   * the internal object out, so either mutation path would leave that cache serving a stale
   * policy.
   */
  private static snapshotOf(config: ContractServiceConfig): ContractServiceConfig {
    const contracts: ContractServiceConfig["contracts"] = {}
    for (const [name, entry] of Object.entries(config.contracts)) {
      if (!entry) continue
      contracts[name as ContractName] = {
        ...entry,
        ...(entry.meta === undefined ? {} : { meta: cloneMeta(name, entry.meta) }),
      }
    }
    return { ...config, contracts, oxide: config.oxide && { ...config.oxide } }
  }

  private static addressesOf(
    config: ContractServiceConfig,
  ): ReadonlyMap<ContractName, AztecAddress> {
    const addresses = new Map<ContractName, AztecAddress>()
    for (const [name, entry] of Object.entries(config.contracts)) {
      if (entry?.address) {
        addresses.set(name as ContractName, AztecAddress.fromStringUnsafe(entry.address))
      }
    }
    return addresses
  }

  /** Snapshot ∪ oxide overlay; every address read goes through this one map. */
  private async configAddressMap(): Promise<ReadonlyMap<ContractName, AztecAddress>> {
    const addresses = this.configAddresses
    const tuple = await this.resolveOxideTuple()
    if (!tuple) return addresses
    const overlaid = new Map(addresses)
    overlaid.set(DEFAULT_CONTRACTS.oxideToken, AztecAddress.fromStringUnsafe(tuple.l2Token))
    return overlaid
  }

  /**
   * Address and metadata as one record, so a consumer cannot compose them itself and pair a
   * policy with another deployment's address. The snapshot is immutable, so both reads observe
   * the same one however long the await between them takes.
   */
  public async getContractRecord(contract: ContractName): Promise<{
    address: AztecAddress | undefined
    meta: Record<string, unknown> | undefined
  }> {
    const meta = await this.getRegistryContractMetadata(contract)
    const address = await this.getContractAddress(contract)
    return { address, meta }
  }

  /**
   * The address surface exists only in `local-ledger` mode. `source` is a required option with a
   * constructor check, so this narrows rather than validates — but JS callers can still get here.
   */
  private localLedger(): ILocalLedgerStorage {
    if (this.source !== "local-ledger") {
      throw new Error("Contract addresses come from the config snapshot in profile mode")
    }
    return this.storage as ILocalLedgerStorage
  }

  /** Addresses in profile mode have one writer; anything else is a caller bug worth surfacing. */
  private requireMutableAddresses(operation: string): void {
    if (this.config) {
      throw new Error(
        `${operation} is unavailable in profile mode — addresses come from the config ` +
          "snapshot, which is fixed at construction.",
      )
    }
  }

  /**
   * The oxide env-registry client for this instance, or null when no profile
   * applies (sandbox, deploy mode, explicit opt-out). Construction is lazy and
   * never fetches — consumers drive the lifecycle via initialize() (front-core
   * provider, relayer boot) and refresh() (failure / foreground / interval
   * triggers). Direct tuple consumers (TEE connect paths) must take enclaveUrl
   * AND portal from ONE getCurrentTuple() snapshot. The client extracts under
   * the shared pinned-entry policy: on mainnet the strict prod manifest schema
   * + the fatal same-sha gitSha, so a wrong manifest fails closed rather than
   * degrading to empty address rows with real funds.
   */
  public getOxideClient(): OxideEnvRegistryClient | null {
    if (!this.oxideProfile) return null
    if (!this.oxideClient) {
      this.oxideClient = new OxideEnvRegistryClient({
        profile: this.oxideProfile,
        fetchFunction: this.fetch,
        extractOptions: pinnedEntryPolicy({
          network: this.network,
          expectedGitSha: this.oxideProfile.expectedGitSha,
        }),
      })
    }
    return this.oxideClient
  }

  /**
   * Resolve the currently applicable oxide tuple for read-time overlays.
   * Ensures the client lifecycle has started (idempotent, never throws) so
   * boot-time readers that never call initialize() themselves — ens-gateway,
   * the oidc-jwk-cron — still inherit manifest values per process
   * start. No profile → null without constructing anything (sandbox path
   * stays byte-for-byte identical to pre-overlay behavior).
   */
  private async resolveOxideTuple(): Promise<OxideEnvTuple | null> {
    if (!this.oxideProfile) return null
    const client = this.getOxideClient()!
    await client.initialize()
    return client.getCurrentTuple()
  }

  /** Overlay value for a contract name, or undefined when none applies. */
  private async oxideOverlayAddress(contract: ContractName): Promise<AztecAddress | undefined> {
    if (contract !== DEFAULT_CONTRACTS.oxideToken) {
      return undefined
    }
    const tuple = await this.resolveOxideTuple()
    return tuple ? AztecAddress.fromStringUnsafe(tuple.l2Token) : undefined
  }

  public getNetwork(): Network {
    return this.network
  }

  /** The profile version behind these contracts; undefined for a local ledger, which names none. */
  public getConfigVersion(): string | undefined {
    return this.config?.configVersion
  }

  /**
   * L1 contract addresses for the current network. `token`/`portal` are oxide-owned and come from
   * the resolved manifest tuple; the account factory is oxide-owned too and read from the tuple
   * directly by its consumers. A local ledger states no L1 addresses. With no tuple the pair reads
   * as absent — except on mainnet, which fails closed rather than hand back empty addresses for
   * real funds.
   */
  public async getL1Addresses(): Promise<{
    token: string
    portal: string
  }> {
    if (!this.config) {
      throw new Error(
        `No L1 addresses found for network "${this.network}" — a local ledger states none`,
      )
    }
    const tuple = await this.resolveOxideTuple()

    if (!tuple) {
      // A profile never carried token/portal, so nothing supplies them without a tuple. On mainnet
      // that is not a soft state — refuse rather than hand back empty addresses for real funds.
      if (this.network === Network.MAINNET) {
        requireNonZeroL1Address("", "mainnet L1 token/portal")
      }
      return { token: "", portal: "" }
    }

    return { token: tuple.token, portal: tuple.portal }
  }

  /**
   * Public, versioned metadata on a contract record (e.g. ClaimFPC's policy manifest), served
   * from the config snapshot (a local ledger states none). A narrow escape hatch: higher layers
   * parse contract-specific immutable data without contracts depending on sdk types.
   */
  private async getRegistryContractMetadata(
    contract: ContractName,
  ): Promise<Record<string, unknown> | undefined> {
    return this.config?.contracts[contract]?.meta
  }

  /**
   * The served class id, or undefined outside profile mode. A missing row fails closed —
   * undefined would read as "nothing to check".
   */
  public getConfiguredClassId(contract: ContractName): string | undefined {
    if (!this.config) return undefined
    const classId = this.config.contracts[contract]?.classId
    if (!classId) {
      throw new Error(
        `The config profile for network "${this.config.network}" states no class id for ` +
          `"${contract}" — the deployment it describes does not carry that contract.`,
      )
    }
    return classId
  }

  /**
   * Register a local contract address directly in the contract map
   * This is useful during tests when contracts are deployed on-the-fly
   * and need to be immediately available to other services
   */
  public async setContractAddress(name: ContractName, address: AztecAddress): Promise<void> {
    this.requireMutableAddresses("setContractAddress")
    // Store in the contract address map
    await this.localLedger().setContractAddress(name, address)
  }

  public async getContractAddress(contract: ContractName): Promise<AztecAddress | undefined> {
    if (this.config) {
      const address = (await this.configAddressMap()).get(contract)
      // Mainnet has no state where the token is legitimately unknowable — fail at the cause;
      // other networks degrade softly, and reverse lookup stays soft everywhere.
      if (
        address === undefined &&
        contract === DEFAULT_CONTRACTS.oxideToken &&
        this.network === Network.MAINNET
      ) {
        throw new OxideTupleUnresolvedError(
          "mainnet oxideToken is unresolved: no oxide tuple (manifest unreachable or " +
            "incompatible, or no pointer configured)",
        )
      }
      return address
    }

    // Local ledger. Oxide-owned contracts (oxideToken → manifest l2Token) are still overlaid at
    // read time, so a live manifest outranks whatever this run wrote; with no tuple the ledger's
    // own value answers.
    const overlay = await this.oxideOverlayAddress(contract)
    if (overlay) {
      return overlay
    }

    // A local ledger holds exactly what the caller wrote — a miss has nothing to refetch.
    return (await this.localLedger().getContractAddress(contract)) ?? undefined
  }

  public async getContract(contract: ContractName, account: BaseWallet): Promise<ContractBase> {
    try {
      // Get the contract address
      const contractAddress = await this.getContractAddress(contract)

      if (!contractAddress) {
        throw new Error(`No address found for contract ${contract}`)
      }

      // Get the artifact, anchored on the address just resolved so the pair is one generation's.
      const artifact = await this.getArtifactForContract(contract, contractAddress)

      // Create the contract instance
      return Contract.at(contractAddress, artifact, account) as unknown as ContractBase
    } catch (error) {
      console.error(`Error getting contract ${contract}:`, error)
      throw error
    }
  }

  public async getContractWithArtifactAndAddress(
    contractAddress: AztecAddress,
    account: BaseWallet,
    artifact: ContractArtifact,
  ): Promise<any> {
    return Contract.at(contractAddress, artifact, account) as unknown as ContractBase
  }

  public async getContractInstance(contract: ContractName): Promise<ContractInstanceWithAddress> {
    const address = await this.getContractAddress(contract)
    if (!address) {
      throw new Error(`Could not get contract address for contract ${contract}`)
    }

    return await this.getContractInstanceWithAddress(address)
  }

  private async getContractInstanceWithAddress(
    address: AztecAddress,
  ): Promise<ContractInstanceWithAddress> {
    try {
      // First try to get from PXE (which has its own caching). PXE stores the
      // address preimage only; the wallet's contracts are never upgraded, so
      // the original class id is also the current one.
      const pxeInstance = await this.getContractInstanceFromPXE(address)
      if (pxeInstance) {
        return { ...pxeInstance, currentContractClassId: pxeInstance.originalContractClassId }
      }

      // Fallback to node
      const nodeInstance = await this.getContractInstanceFromNode(address)
      if (!nodeInstance) {
        throw new Error(`Could not get contract instance for contract at ${address.toString()}`)
      }

      return nodeInstance
    } catch (error) {
      console.error(`Error getting contract instance for contract ${address.toString()}:`, error)
      throw error
    }
  }

  private async getContractInstanceFromPXE(
    address: AztecAddress,
  ): Promise<ContractInstancePreimageWithAddress | undefined> {
    try {
      const contractInstance = await this.pxe.getContractInstance(address)
      if (contractInstance) {
        return contractInstance
      }
    } catch (error) {
      console.error(`Error getting contract instance for contract ${address.toString()}:`, error)
      throw error
    }
  }

  private async getContractInstanceFromNode(
    address: AztecAddress,
  ): Promise<ContractInstanceWithAddress | undefined> {
    try {
      const contractInstance = await this.node.getContract(address)
      if (contractInstance) {
        return contractInstance
      }
    } catch (error) {
      console.error(`Error getting contract instance for contract ${address.toString()}:`, error)
      throw error
    }
    return undefined
  }

  /**
   * The class an instance runs today. The node answers for published instances and tracks
   * upgrades; a privately deployed instance (a user account) exists only in the PXE, which
   * stores the original class — the wallet never upgrades those.
   */
  private async instanceClassId(address: AztecAddress): Promise<string | undefined> {
    const published = await this.getContractInstanceFromNode(address)
    if (published) return published.currentContractClassId.toString()
    if (!this.pxe) return undefined
    const local = await this.getContractInstanceFromPXE(address)
    return local?.originalContractClassId.toString()
  }

  /**
   * Look the artifact up in the PXE cache. Both lookups answer `undefined` when
   * the entry is simply absent, so anything thrown is a real failure — a dead
   * store or an undecodable buffer — and propagates rather than being reported
   * as a miss.
   */
  private async tryGetArtifactFromPXE(
    address: AztecAddress,
  ): Promise<ContractArtifact | undefined> {
    // No PXE reads as "PXE does not know the instance".
    if (!this.pxe) return undefined
    const contractInstance = await this.getContractInstanceFromPXE(address)
    if (!contractInstance) return undefined
    return this.pxe.getContractArtifact(contractInstance.originalContractClassId)
  }

  /**
   * Core artifact resolution - handles both name-based and address-based lookups.
   * Priority: overrides, then — with an explicit address — the PXE probe at that address, then the
   * bundled artifact for the resolved name. An address that maps to no contract name has only the
   * PXE probe, so a miss there is fatal.
   */
  private async fetchArtifact(options: {
    contractName?: ContractName
    address?: AztecAddress
  }): Promise<ContractArtifact> {
    const { contractName, address } = options

    // 1. Try to resolve contract name from address (if not provided)
    let resolvedName = contractName
    if (!resolvedName && address) {
      const contractAddressMap = this.config
        ? await this.configAddressMap()
        : await this.localLedger().getContractAddressMap()
      for (const [name, addr] of contractAddressMap.entries()) {
        if (addr.equals(address)) {
          resolvedName = name
          break
        }
      }
    }

    // 2. An explicit override outranks every source — it exists to substitute the artifact.
    if (resolvedName) {
      const override = this.artifactOverrides.get(resolvedName)
      if (override) return override
    }

    // 3. An explicit address asks for the INSTANCE's artifact, so the PXE probe outranks the
    //    bundle — mid-transition the bundle is already the incoming class.
    if (address && !this.options.resolveClassArtifact) {
      const pxeArtifact = await this.tryGetArtifactFromPXE(address)
      if (pxeArtifact) return pxeArtifact
    }

    if (this.options.resolveClassArtifact) {
      const instanceClassId = address ? await this.instanceClassId(address) : undefined
      if (address && !instanceClassId) throw new Error("Historical contract instance is missing")
      const classId =
        instanceClassId ??
        (resolvedName ? this.config?.contracts[resolvedName]?.classId : undefined)
      if (!classId) throw new Error("Historical artifact lookup requires a pinned contract class")
      if (address) {
        const cached = await this.tryGetArtifactFromPXE(address)
        if (cached && (await getContractClassFromArtifact(cached)).id.toString() === classId)
          return cached
      }
      return this.artifactForClass(classId, resolvedName)
    }

    // 4. The bundled artifact, which every name resolves against — throws when none is bundled.
    if (resolvedName) {
      return getHardcodedArtifact(resolvedName, this.options)
    }

    throw new Error(
      `Cannot resolve artifact for address ${address?.toString() ?? "(none provided)"}: ` +
        `it maps to no known contract name, so no bundled artifact applies, and it is not in the ` +
        `PXE cache. Pass a contract name, or register the contract first.`,
    )
  }

  /**
   * The artifact of a contract class: the bundled artifact `contractName` names when it compiles to
   * that class, else the reviewed historical artifact for it. Needs no instance anywhere, so it is
   * what a registration resolves against — a private account exists nowhere until the PXE holds it.
   */
  private async artifactForClass(
    classId: string,
    contractName?: ContractName,
  ): Promise<ContractArtifact> {
    if (contractName) {
      const bundled = await getHardcodedArtifact(contractName, this.options)
      if ((await getContractClassFromArtifact(bundled)).id.toString() === classId) return bundled
    }
    if (!this.options.resolveClassArtifact) {
      throw new Error(`No artifact for contract class ${classId}`)
    }
    const artifact = await this.options.resolveClassArtifact(classId)
    if ((await getContractClassFromArtifact(artifact)).id.toString() !== classId)
      throw new Error(`Historical artifact differs from class ${classId}`)
    return artifact
  }

  /**
   * `knownAddress` anchors the fetch so the caller's (name, address) pair stays one generation's;
   * an anchored fetch bypasses the shared cache in BOTH directions.
   */
  public getArtifactForInstance(
    address: AztecAddress,
    fallback: () => Promise<ContractArtifact>,
  ): Promise<ContractArtifact> {
    return resolveInstanceArtifact(this.node, address, fallback, this.options.resolveClassArtifact)
  }

  public async getArtifactForContract(
    contract: ContractName,
    knownAddress?: AztecAddress,
  ): Promise<ContractArtifact> {
    if (knownAddress) {
      return this.fetchArtifact({ contractName: contract, address: knownAddress })
    }

    // Check if already cached
    const cached = this.storage.getArtifactCache().get(contract)
    if (cached) return cached

    // Create and cache promise immediately to prevent duplicate fetches
    const promise = this.fetchArtifact({ contractName: contract })
    this.storage.setArtifactCache(contract, promise)

    // Clear only if the entry is still this promise — a late rejection must not evict a successor.
    promise.catch(() => {
      const cache = this.storage.getArtifactCache()
      if (cache.get(contract) === promise) cache.delete(contract)
    })

    return promise
  }

  /**
   * Override the cached artifact for a contract. Useful in tests after
   * patching and recompiling a contract with hardcoded addresses.
   */
  public overrideArtifact(contract: ContractName, artifact: ContractArtifact): void {
    this.artifactOverrides.set(contract, artifact)
    this.storage.setArtifactCache(contract, Promise.resolve(artifact))
  }

  /**
   * Register a contract with PXE
   */
  public async registerContractWithName(contract: ContractName): Promise<void> {
    try {
      // Get contract address
      const contractAddress = await this.getContractAddress(contract)
      // console.log("contractAddress: ", contractAddress)
      if (!contractAddress) {
        return
      }

      await this.registerContractWithAddress(contractAddress, contract)
    } catch (error) {
      console.error(`Error registering contract ${contract}:`, error)
      throw error
    }
  }

  public async registerContractWithAddress(
    contractAddress: AztecAddress,
    contractName?: ContractName,
  ): Promise<void> {
    try {
      // Check if already registered
      const contractInstanceFromPXE = await this.getContractInstanceFromPXE(contractAddress)
      if (contractInstanceFromPXE) {
        const artifact = await this.pxe.getContractArtifact(
          contractInstanceFromPXE.originalContractClassId,
        )
        if (artifact) {
          return
        }
      }

      // Get contract instance
      const contractInstanceFromNode = await this.getContractInstanceFromNode(contractAddress)
      if (!contractInstanceFromNode) {
        throw new Error(`Contract instance not found for contract at ${contractAddress.toString()}`)
      }

      // Get artifact using unified fetchArtifact
      const artifact = await this.fetchArtifact({
        contractName,
        address: contractAddress,
      })

      await registerContractInPXE(this.pxe, contractInstanceFromNode, artifact)

      console.log(
        `Successfully registered contract at ${contractAddress.toString().slice(0, 6)}...`,
      )
    } catch (error) {
      console.error(`Error registering contract at ${contractAddress.toString()}:`, error)
      throw error
    }
  }

  /**
   * Register a user account contract
   */
  public registerUserAccount(
    instance: ContractInstanceWithAddress,
    secretKey: Fr,
    contractName?: ContractName,
  ): Promise<void> {
    const key = instance.address.toString()
    const inFlight = this.accountRegistrations.get(key)
    if (inFlight) return inFlight
    const run = this.doRegisterUserAccount(instance, secretKey, contractName).finally(() => {
      if (this.accountRegistrations.get(key) === run) this.accountRegistrations.delete(key)
    })
    this.accountRegistrations.set(key, run)
    return run
  }

  private async doRegisterUserAccount(
    instance: ContractInstanceWithAddress,
    secretKey: Fr,
    contractName?: ContractName,
  ): Promise<void> {
    console.log("registerUserAccount...")
    try {
      const address = instance.address

      // Check if contract instance is already registered in PXE
      const existingInstance = await this.getContractInstanceFromPXE(address)

      if (!existingInstance) {
        // The instance in hand is the anchor. A user account is deployed privately, so the node
        // never holds it, and the PXE holds it only once this writes it.
        const artifact = await this.artifactForClass(
          instance.currentContractClassId.toString(),
          contractName ?? DEFAULT_CONTRACTS.obsidionAccountAlpha,
        )

        await registerContractInPXE(this.pxe, instance, artifact)

        console.log(
          `Successfully registered obsidion account contract at ${address
            .toString()
            .slice(0, 6)}...`,
        )
      }

      const registeredAccounts = await this.pxe.getRegisteredAccounts()
      if (!registeredAccounts.some((acc: CompleteAddress) => acc.address.equals(address))) {
        // Register the account with the private key
        const partialAddress = await computePartialAddress(instance)
        const compAddress = await CompleteAddress.fromSecretKeyAndPartialAddress(
          secretKey,
          partialAddress,
        )

        if (!compAddress.address.equals(address)) {
          throw new Error(
            `Registered account address ${compAddress.toString()} does not match expected address ${address.toString()}`,
          )
        }

        const keys = await deriveKeys(secretKey)
        await this.pxe.registerAccount(
          {
            masterNullifierHidingSecretKey: keys.masterNullifierHidingSecretKey,
            masterIncomingViewingSecretKey: keys.masterIncomingViewingSecretKey,
            masterOutgoingViewingSecretKey: keys.masterOutgoingViewingSecretKey,
            masterTaggingSecretKey: keys.masterTaggingSecretKey,
            masterMessageSigningPublicKey: keys.masterMessageSigningPublicKey,
            masterFallbackPublicKey: keys.masterFallbackPublicKey,
          },
          partialAddress,
        )
        console.log(`Successfully registered user account at ${address.toString().slice(0, 6)}...`)
      }
    } catch (error) {
      console.error(`Error registering user account:`, error)
      throw error
    }
  }
}
