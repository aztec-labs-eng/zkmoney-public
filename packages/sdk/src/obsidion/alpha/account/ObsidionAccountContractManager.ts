import {
  CompleteAddress,
  ContractInstanceWithAddress,
  getContractInstanceFromInstantiationParams,
} from "@aztec/stdlib/contract"
import {
  computeAddressSecret,
  deriveKeys,
  deriveMasterIncomingViewingSecretKey,
} from "@aztec/stdlib/keys"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { ContractArtifact } from "@aztec/stdlib/abi"
import { ContractService, ContractName } from "@obsidion/contracts"
import type {
  DepositSpendMetadata,
  DepositSpendMetadataResolver,
  SpendMetadata,
  SpendMetadataResolver,
} from "@oxide/oxide-client/token_operations_collector.js"
import { alphaKeyCommitment } from "./alphaKeyCommitment.js"

export const DEFAULT_ACCOUNT_SALT = new Fr(1n)

export interface AlphaContractManagerOptions {
  artifact: ContractArtifact
  contractName: ContractName
}

/**
 * Contract manager for ObsidionAccountAlpha.
 * Accepts an injected ContractArtifact and contractName, enabling the same
 * class to serve both production (WebAuthn) and test (K256) variants.
 * Uses ContractService for PXE registration.
 *
 * The address is a function of the master secret key and the signing key: the key's commitment
 * is the instance's `immutables_hash`, so an account is bound to one key for its whole life.
 */
export class ObsidionAccountContractManager {
  private contractService: ContractService = ContractService.getInstance()
  private contractRegistration: Promise<void> | null = null
  private instance: ContractInstanceWithAddress | null = null
  private completeAddress: CompleteAddress | null = null
  private readonly secretKey: Fr
  private readonly pubkeyHex: string
  private readonly artifact: ContractArtifact
  private readonly contractName: ContractName

  public static async create(
    secretKey: Fr,
    pubkeyHex: string,
    options: AlphaContractManagerOptions,
    register: boolean = false,
  ) {
    const manager = new ObsidionAccountContractManager(secretKey, pubkeyHex, options)
    await manager.getContractInstance()

    if (register) {
      manager.contractRegistration = manager.registerAccount().catch((error) => {
        console.error("Error during account registration:", error)
      })
    }

    return manager
  }

  /**
   * Restore from a stored complete address. The complete address is re-derived from the secret
   * and the key and must equal the stored one: a stored address the current derivation does not
   * reproduce is an account this wallet cannot run, and it must not be registered or used. The
   * derived preimage is what the manager keeps, so a stored copy with stale public keys behind a
   * matching address never reaches encryption or spend metadata.
   */
  public static async createFromCompleteAddress(
    secretKey: Fr,
    pubkeyHex: string,
    completeAddress: CompleteAddress,
    options: AlphaContractManagerOptions,
    register: boolean = false,
  ) {
    const manager = new ObsidionAccountContractManager(secretKey, pubkeyHex, options)
    const derived = await manager.getCompleteAddress()
    if (!derived.equals(completeAddress)) {
      throw new Error(
        `stored account ${completeAddress.address.toString()} is not the account this secret and ` +
          `key derive (${derived.address.toString()}); this wallet needs re-onboarding`,
      )
    }

    if (register) {
      manager.contractRegistration = manager.registerAccount().catch((error) => {
        console.error("Error during account registration:", error)
      })
    }

    return manager
  }

  private constructor(secretKey: Fr, pubkeyHex: string, options: AlphaContractManagerOptions) {
    this.secretKey = secretKey
    this.pubkeyHex = pubkeyHex
    this.artifact = options.artifact
    this.contractName = options.contractName
  }

  get address(): AztecAddress {
    if (!this.instance) {
      throw new Error("Instance not yet computed. Call getContractInstance() first.")
    }
    return this.instance.address
  }

  getContractArtifact(): ContractArtifact {
    return this.artifact
  }

  async getContractInstance(): Promise<ContractInstanceWithAddress> {
    if (this.instance) return this.instance

    this.instance = await getContractInstanceFromInstantiationParams(this.artifact, {
      salt: DEFAULT_ACCOUNT_SALT,
      publicKeys: (await deriveKeys(this.secretKey)).publicKeys,
      immutablesHash: await alphaKeyCommitment(this.pubkeyHex),
    })
    return this.instance
  }

  async getCompleteAddress(): Promise<CompleteAddress> {
    if (this.completeAddress) return this.completeAddress

    const instance = await this.getContractInstance()
    this.completeAddress = await CompleteAddress.fromSecretKeyAndInstance(this.secretKey, instance)
    return this.completeAddress
  }

  public async ensureContractRegistered(): Promise<void> {
    if (this.contractRegistration) {
      await this.contractRegistration
    }
  }

  public async getEncryptionSecret() {
    return computeAddressSecret(
      await (await this.getCompleteAddress()).getPreaddress(),
      deriveMasterIncomingViewingSecretKey(this.secretKey),
    )
  }

  /**
   * Raw master tagging public key point. v5 `PublicKeys` carries only the
   * domain-separated hash, so consumers that need the point (tag attestation)
   * re-derive it from the account secret here.
   */
  public async getMasterTaggingPublicKey() {
    return (await deriveKeys(this.secretKey)).masterTaggingPublicKey
  }

  /** Register the account and its contract in the PXE; a failure is the caller's, not logged away. */
  public async registerAccount(): Promise<void> {
    const instance = await this.getContractInstance()
    await this.contractService.registerUserAccount(instance, this.secretKey, this.contractName)
  }

  /**
   * Build a {@link SpendMetadataResolver} bound to THIS account.
   *
   * The TEE signer's spend validation needs the owner's `ownerAddressPreimage`
   * (CompleteAddress) plus the `masterNullifierHidingKey` for each nullified
   * note. Oxide's upstream `buildSpendMetadata` helper hardcodes
   * `SchnorrAccountContract`, so it can't compute the right preimage for an
   * obsidion-account owner — the contract instance (and hence address) would
   * be derived from the wrong artifact.
   *
   * This helper closes over the account's `secretKey` privately. Callers
   * (TokenService.sendToken / TokenService.exitToL1Private) receive the
   * resolver closure but never the underlying secret. The closure asserts
   * that each nullified note's `owner` equals this account's deployed
   * address — guards against accidentally wiring the wrong account.
   */
  public async makeSpendMetadataResolver(): Promise<SpendMetadataResolver> {
    const completeAddress = await this.getCompleteAddress()
    const keys = await deriveKeys(this.secretKey)
    const ownerAddress = completeAddress.address
    return async (nullified): Promise<SpendMetadata> => {
      if (!nullified.owner.equals(ownerAddress)) {
        throw new Error(
          `[ObsidionAccountContractManager.makeSpendMetadataResolver] Owner mismatch: nullified note owner ${nullified.owner} != account address ${ownerAddress}`,
        )
      }
      return {
        creationTxHash: nullified.creationTxHash,
        ownerAddressPreimage: completeAddress,
        masterNullifierHidingKey: keys.masterNullifierHidingSecretKey,
      }
    }
  }

  /**
   * Resolves a spent deposit's recipient into the metadata the
   * TEE needs to key the deposit-message nullifier. Same guard shape as
   * {@link makeSpendMetadataResolver}: the closure asserts the claim's
   * recipient is this account.
   */
  public async makeDepositSpendMetadataResolver(): Promise<DepositSpendMetadataResolver> {
    const completeAddress = await this.getCompleteAddress()
    const keys = await deriveKeys(this.secretKey)
    const ownerAddress = completeAddress.address
    return async (recipient): Promise<DepositSpendMetadata> => {
      if (!recipient.equals(ownerAddress)) {
        throw new Error(
          `[ObsidionAccountContractManager.makeDepositSpendMetadataResolver] Recipient mismatch: deposit claim recipient ${recipient} != account address ${ownerAddress}`,
        )
      }
      return {
        ownerAddressPreimage: completeAddress,
        masterNullifierHidingKey: keys.masterNullifierHidingSecretKey,
      }
    }
  }
}
