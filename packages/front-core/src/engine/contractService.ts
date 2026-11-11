import {
  ContractService,
  DEFAULT_CONTRACTS,
  type ContractServiceFactory,
  type ContractServiceOptions,
  type IContractServiceStorage,
  Network,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { logger } from "../utils/logger"
import { WalletError } from "./errors"
import { service, type Backoff, type Service } from "./service"

const RETRY: Backoff = { baseMs: 4_000, maxMs: 60_000 }

export interface ContractServiceDeps {
  network: Network
  storage: IContractServiceStorage
  options: ContractServiceOptions
}

/** Builds a wallet's contract service; a snapshot for another network fails it. */
export function contractServiceFactory({
  network,
  storage,
  options,
}: ContractServiceDeps): ContractServiceFactory {
  return (node, pxe) => {
    logger.log("initializing contract service: ", network)
    if (options.source === "profile") {
      if (!options.config)
        throw new WalletError("invariant", 'contract service: source "profile" without a snapshot')
      if (options.config.network !== network)
        throw new WalletError(
          "invariant",
          `Config snapshot is for network "${options.config.network}" but the wallet is on ` +
            `"${network}"`,
        )
    }
    const service = new ContractService(storage, node, pxe, network, options)
    logger.log("contract service created: ", service.getNetwork())
    return service
  }
}

export interface OpenContractServiceDeps {
  wallet: Service<ObsidionWallet>
  options: Pick<ContractServiceOptions, "onL1AddressesLoaded">
  /** Registers the sponsor FPC with the PXE. A host that pays no fee through it skips the work, which
   *  otherwise queues on the PXE ahead of the host's first reads. */
  registerSponsorFpc?: boolean
}

/** The page's contract service: the wallet's, built once the wallet is. The wallet owns it. */
export function openContractService(deps: OpenContractServiceDeps): Service<ContractService> {
  return service("contractService", { from: [deps.wallet], retry: RETRY }, async ([wallet]) => {
    const contracts = wallet.contractService
    void prepare(contracts, deps)
    return contracts
  })
}

/**
 * Fails once the contract service's manifest client refuses a mainnet manifest (wrong schema,
 * missing field or gitSha mismatch), so the wallet never runs on empty registry rows. A failed
 * fetch is not fatal: the client retries it.
 */
export function manifestGate(contractService: Service<ContractService>): Service<true> {
  return service(
    "manifestGate",
    { from: [contractService], retry: "manual" },
    async ([cs]): Promise<true> => {
      const client = cs.getOxideClient()
      if (!client) return true
      await client.initialize()
      if (
        cs.getNetwork() === Network.MAINNET &&
        !client.getCurrentTuple() &&
        client.getResolutionState().failureMode === "manifest-incompatible"
      )
        throw new WalletError(
          "config.invalid",
          "Mainnet oxide manifest is incompatible (wrong schema, missing required field, or " +
            "gitSha mismatch). Refusing to boot against empty registry rows.",
        )
      return true
    },
  )
}

async function prepare(service: ContractService, deps: OpenContractServiceDeps) {
  if (deps.registerSponsorFpc ?? true) await initFPC(service)
  try {
    const l1Addresses = await service.getL1Addresses()
    deps.options.onL1AddressesLoaded?.(l1Addresses)
  } catch (err) {
    logger.warn("Failed to load L1 addresses:", err)
  }
}

/** The sponsor FPC is optional fee infra: a missing or failed registration never fails the service. */
async function initFPC(service: ContractService) {
  try {
    const sponsoredFPCAddress = await service.getContractAddress(DEFAULT_CONTRACTS.sponsorFPC)
    if (!sponsoredFPCAddress) {
      logger.warn("Sponsored FPC address not found in registry — skipping sponsor FPC")
    } else {
      // Guarded: no-op when the PXE already has the instance + artifact.
      await service.registerContractWithName(DEFAULT_CONTRACTS.sponsorFPC)
      logger.log("Sponsor FPC registered at:", sponsoredFPCAddress.toString())
    }
  } catch (e) {
    console.warn("Failed to register sponsor FPC:", e)
  }
}
