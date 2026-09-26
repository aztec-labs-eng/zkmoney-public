import {
  SchnorrAccountContract,
  SchnorrInitializerlessAccountContract,
  SchnorrInitializerlessAccountContractArtifact,
} from "@aztec/accounts/schnorr"
import { EcdsaKAccountContract, EcdsaRAccountContract } from "@aztec/accounts/ecdsa"
import { ObsidionAccount } from "./alpha/account/ObsidionAccount.js"
import { AccountManager, SendOptions } from "@aztec/aztec.js/wallet"
import { Account, type AccountContract, type Salt } from "@aztec/aztec.js/account"
import { Fr, Fq } from "@aztec/aztec.js/fields"
import { deriveMasterIncomingViewingSecretKey } from "@aztec/stdlib/keys"
import {
  ExecutionPayload,
  OffchainEffect,
  ProvingStats,
  Tx,
  TxHash,
  TxReceipt,
} from "@aztec/stdlib/tx"
// import { NoteDao, NotesFilter } from "@aztec/stdlib/note"
import {
  type AlphaAccountType,
  FeePaymentOptions,
  ObsidionWallet,
  type ObsidionWalletOptions,
} from "./ObsidionWallet.js"
import { proveTxWithProgress } from "./proving-progress-helpers.js"
import { AztecNode, waitForTx } from "@aztec/aztec.js/node"
import { NO_WAIT, NoWait, SendInteractionOptions, WaitOpts } from "@aztec/aztec.js/contracts"
import { ContractFunctionInteraction } from "@aztec/aztec.js/contracts"
import { createPXE, getPXEConfig, PXE, PXEConfig, PXECreationOptions } from "@aztec/pxe/server"
// import { PXE, PXECreationOptions, PXEConfig, getPXEConfig } from "@aztec/pxe/client/lazy"
import { getSponsoredFeePaymentMethod } from "../feePaymentMethod/sponsored_fpc.js"
import { Gas, GasSettings } from "@aztec/stdlib/gas"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { AccountFeePaymentMethodOptions } from "@aztec/entrypoints/account"
import type { CompleteFeeOptionsConfig, FeeOptions } from "@aztec/wallet-sdk/base-wallet"
import type { FieldsOf } from "@aztec/foundation/types"
import { inspect } from "util"
import { SimulationError } from "@aztec/stdlib/errors"
import { ContractArtifact } from "@aztec/stdlib/abi"
import { ContractService, DEFAULT_CONTRACTS, ContractName } from "@obsidion/contracts"

type SchnorrTestAccountType = "schnorr" | "schnorr_initializerless"

/**
 * Test-only wallet extension with unsafe utilities.
 *
 * WARNING: DO NOT USE IN PRODUCTION.
 *
 * This class extends ObsidionWallet with additional methods that are only
 * suitable for testing and development:
 * - createSchnorrAccount / createECDSAKAccount / createECDSARAccount: Create standard Aztec accounts
 * - proveTx: Prove transactions without sending (privacy risk)
 * - getNotes: Access internal note data (exposes contract internals)
 */
export class ObsidionWalletTest extends ObsidionWallet {
  // Integration tests share anvil account #0 with the sandbox sequencer's L1 publisher; waiting
  // for CHECKPOINTED keeps test L1 writes out of the publisher's in-flight window.
  public override readonly defaultWaitOpts: WaitOpts = {}

  constructor(pxe: PXE, node: AztecNode, walletOpts?: ObsidionWalletOptions) {
    super(pxe, node, walletOpts)
  }

  protected override async getAccountArtifact(): Promise<ContractArtifact> {
    return ContractService.getInstance().getArtifactForContract(this.getAccountContractName())
  }

  protected override getAccountContractName(): ContractName {
    return DEFAULT_CONTRACTS.obsidionAccountAlphaTest
  }

  // Helper to add accounts to the wallet, e.g. test accounts from
  // `getInitialTestAccountsData()` (Schnorr fixtures) or alpha accounts
  // already registered via `createObsidionAccount`. When `type` is
  // omitted, ObsidionAccount instances are tagged `"alpha"` and the rest
  // default to `"schnorr"` (the upstream sandbox fixture's account type);
  // pass an explicit type for ECDSA test accounts or to override.
  async setAccounts(accounts: Account[], type?: AlphaAccountType) {
    for (const account of accounts) {
      const effectiveType: AlphaAccountType =
        type ?? (account instanceof ObsidionAccount ? "alpha" : "schnorr")
      this.addAccount(account.getAddress(), account, effectiveType)
    }
  }

  static async create(
    node: AztecNode,
    overridePXEConfig?: Partial<PXEConfig>,
    options: PXECreationOptions = { loggers: {} },
    walletOpts?: ObsidionWalletOptions,
  ): Promise<ObsidionWalletTest> {
    const pxeConfig = Object.assign(getPXEConfig(), {
      proverEnabled: overridePXEConfig?.proverEnabled ?? false,
      autoSync: overridePXEConfig?.autoSync ?? false,
      ...overridePXEConfig,
    })
    // TODO: change this, this is a 200ms roundtrip to the node
    const l1Contracts = await node.getL1ContractAddresses()
    const rollupAddress = l1Contracts.rollupAddress
    pxeConfig.dataDirectory = pxeConfig.dataDirectory ?? `pxe-${rollupAddress}`

    const pxe = await (await import("@aztec/pxe/server")).createPXE(node, pxeConfig, options)
    return new ObsidionWalletTest(pxe, node, walletOpts)
  }

  // -- Account Creation (TEST ONLY) --
  /**
   * Create a Schnorr account for testing purposes.
   * This creates a standard Aztec Schnorr account (not an Obsidion account).
   *
   * @param secret - The secret key for the account
   * @param salt - The salt for contract deployment
   * @param signingKey - Optional signing key (derived from secret if not provided)
   * @returns AccountManager for the created account
   */
  async createSchnorrAccount(
    secret: Fr,
    salt: Salt,
    signingKey?: Fq,
    accountType: SchnorrTestAccountType = "schnorr",
  ): Promise<AccountManager> {
    const sk = signingKey ?? deriveMasterIncomingViewingSecretKey(secret)
    if (accountType === "schnorr_initializerless") {
      const contract = new SchnorrInitializerlessAccountContract(sk)
      const accountManager = await AccountManager.create(this, secret, contract, { salt })
      const instance = await accountManager.getInstance()

      await this.registerContract(
        instance,
        SchnorrInitializerlessAccountContractArtifact,
        accountManager.getSecretKey(),
      )

      const completeAddress = await accountManager.getCompleteAddress()
      const account = contract.getAccount(completeAddress)
      this.addAccount(account.getAddress(), account, "schnorr")

      const constructorAbi = SchnorrInitializerlessAccountContractArtifact.functions.find(
        (fn) => fn.name === "constructor",
      )
      if (!constructorAbi) {
        throw new Error("SchnorrInitializerlessAccount artifact is missing its constructor utility")
      }
      const { x, y } = await contract.getSigningPublicKey()
      await new ContractFunctionInteraction(this, instance.address, constructorAbi, [
        x,
        y,
      ]).simulate({
        from: instance.address,
      })

      return accountManager
    }

    const contract = new SchnorrAccountContract(sk)
    return await this.createTestAccountInternal(secret, salt, contract, "schnorr")
  }

  /**
   * Create an ECDSA K256 (secp256k1) account for testing purposes.
   * This creates a standard Aztec ECDSA account (not an Obsidion account).
   *
   * @param secret - The secret key for the account
   * @param salt - The salt for contract deployment
   * @param signingKey - The ECDSA signing key buffer
   * @returns AccountManager for the created account
   */
  async createECDSAKAccount(secret: Fr, salt: Salt, signingKey: Buffer): Promise<AccountManager> {
    const contract = new EcdsaKAccountContract(signingKey)
    return await this.createTestAccountInternal(secret, salt, contract, "ecdsasecp256k1")
  }

  /**
   * Create an ECDSA R256 (secp256r1) account for testing purposes.
   * This creates a standard Aztec ECDSA account (not an Obsidion account).
   *
   * @param secret - The secret key for the account
   * @param salt - The salt for contract deployment
   * @param signingKey - The ECDSA signing key buffer
   * @returns AccountManager for the created account
   */
  async createECDSARAccount(secret: Fr, salt: Salt, signingKey: Buffer): Promise<AccountManager> {
    const contract = new EcdsaRAccountContract(signingKey)
    return await this.createTestAccountInternal(secret, salt, contract, "ecdsasecp256r1")
  }

  /**
   * Internal helper to create test accounts.
   */
  private async createTestAccountInternal(
    secret: Fr,
    salt: Salt,
    contract: AccountContract,
    type: AlphaAccountType,
  ): Promise<AccountManager> {
    const accountManager = await AccountManager.create(this, secret, contract, { salt })
    const instance = await accountManager.getInstance()
    const artifact = await accountManager.getAccountContract().getContractArtifact()
    await this.registerContract(instance, artifact, accountManager.getSecretKey())
    this.addAccount(accountManager.address, await accountManager.getAccount(), type)
    return accountManager
  }

  /**
   * NOTE: Use aztec's SponsoredFeePaymentMethod by default.
   * Get the default send options for the wallet.
   * @param from - The address to send from
   * @returns The default send options
   */

  override async getDefaultSendOptions(
    from: AztecAddress,
    options?: FeePaymentOptions,
  ): Promise<SendInteractionOptions> {
    if (options) {
      return await super.getDefaultSendOptions(from, options)
    }

    return {
      from,
      fee: {
        paymentMethod: await getSponsoredFeePaymentMethod(this.pxe),
        gasSettings: await this.getGasSettings(),
      },
    }
  }

  /**
   * Override completeFeeOptions to automatically inject sponsored fee payment
   * when no fee payment method is provided.
   *
   * This allows tests to call `contract.methods.foo().send({ from: address })`
   * without explicitly passing fee options - the sponsored fee will be used by default.
   */
  protected override async completeFeeOptions(
    config: CompleteFeeOptionsConfig,
  ): Promise<FeeOptions> {
    // If no fee payer is provided (i.e., no fee payment method was embedded),
    // inject the sponsored fee payment method automatically
    if (!config.feePayer) {
      const sponsoredPaymentMethod = await getSponsoredFeePaymentMethod(this.pxe)
      const maxFeesPerGas =
        config.gasSettings?.maxFeesPerGas ?? (await this.node.getCurrentMinFees())
      const { txsLimits } = await this.node.getNodeInfo()
      const fullGasSettings = GasSettings.fallback({
        ...config.gasSettings,
        maxFeesPerGas,
        gasLimits: config.gasSettings?.gasLimits ?? Gas.from(txsLimits.gas),
      })

      return {
        gasSettings: fullGasSettings,
        walletFeePaymentMethod: sponsoredPaymentMethod,
        accountFeePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
      }
    }

    // If fee payer is provided, use the default behavior from BaseWallet
    return super.completeFeeOptions(config)
  }

  // -- Unsafe Testing Utilities --

  /**
   * Prove a transaction without sending it.
   *
   * WARNING: DO NOT USE IN PRODUCTION.
   * Proven transactions can be intercepted and tracked by malicious nodes.
   * This also makes it difficult for the wallet to track the interaction.
   *
   * @param exec - The execution payload to prove
   * @param opts - The options to configure the interaction
   * @returns A proven transaction ready to be sent
   */
  async proveTx(exec: ExecutionPayload, opts: SendOptions): Promise<ProvenTx> {
    const fee = await this.completeFeeOptions({
      from: opts.from,
      feePayer: exec.feePayer,
      gasSettings: opts.fee?.gasSettings,
    })
    const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(exec, opts.from, fee)
    // `sync: true` — this test-only prove path bypasses `sendTx`'s sync
    // point, so the prove owns its own (settled reads need a fresh anchor).
    const txProvingResult = await proveTxWithProgress(
      this.pxe,
      txRequest,
      {
        scopes: this.scopesFrom(opts.from, opts.additionalScopes ?? [], opts.sendMessagesAs),
        senderForTags: this.senderForTagsFrom(opts.from, opts.sendMessagesAs),
      },
      { sync: true },
    )
    return new ProvenTx(
      this.aztecNode,
      await txProvingResult.toTx(),
      txProvingResult.getOffchainEffects(),
      txProvingResult.stats,
    )
  }

  /**
   * Get notes based on the provided filter.
   *
   * WARNING: DO NOT USE IN PRODUCTION.
   * This exposes contract internal implementation details.
   * Use contract-specific getter functions instead (e.g., get_balance on Token contract).
   *
   * @param filter - The filter to apply to the notes
   * @returns The requested notes
   */
  // TODO: implement this with our own pxe
  // getNotes(filter: NotesFilter): Promise<NoteDao[]> {
  //   return this.pxe.getNotes(filter)
  // }

  /**
   * Stop the PXE service.
   * Useful for cleanup in tests.
   */
  async stop(): Promise<void> {
    await this.pxe.stop()
  }
}

export type ProvenTxSendOpts = {
  wait?: NoWait | WaitOpts
}

export type ProvenTxSendReturn<T extends NoWait | WaitOpts | undefined> = T extends NoWait
  ? TxHash
  : TxReceipt

/**
 * A proven transaction that can be sent to the network. Returned by the `prove` method of the test wallet
 */
export class ProvenTx extends Tx {
  constructor(
    private node: AztecNode,
    tx: Tx,
    public offchainEffects: OffchainEffect[],
    public stats?: ProvingStats,
  ) {
    super(
      tx.getTxHash(),
      tx.data,
      tx.chonkProof,
      tx.contractClassLogFields,
      tx.publicFunctionCalldata,
    )
  }

  send(options?: Omit<ProvenTxSendOpts, "wait">): Promise<TxReceipt>
  send<W extends ProvenTxSendOpts["wait"]>(
    options: ProvenTxSendOpts & { wait: W },
  ): Promise<ProvenTxSendReturn<W>>
  async send(options?: ProvenTxSendOpts): Promise<TxHash | TxReceipt> {
    const txHash = this.getTxHash()
    await this.node.sendTx(this).catch((err) => {
      throw this.contextualizeError(err, inspect(this))
    })

    if (options?.wait === NO_WAIT) {
      return txHash
    }

    const waitOpts = typeof options?.wait === "object" ? options.wait : undefined
    return await waitForTx(this.node, txHash, waitOpts)
  }

  private contextualizeError(err: Error, ...context: string[]): Error {
    let contextStr = ""
    if (context.length > 0) {
      contextStr = `\nContext:\n${context.join("\n")}`
    }
    if (err instanceof SimulationError) {
      err.setAztecContext(contextStr)
    }
    return err
  }
}
