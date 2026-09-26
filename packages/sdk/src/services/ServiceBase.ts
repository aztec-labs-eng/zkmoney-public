import { EventEmitter } from "eventemitter3"
import { ContractService, ContractName } from "@obsidion/contracts"
import { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import {
  BatchCall,
  Contract,
  ContractBase,
  ContractFunctionInteraction,
  DeployInstantiationOptions,
  DeployMethod,
  DeployOptions,
  type OffchainOutput,
  SendInteractionOptions,
  SimulateInteractionOptions,
  NO_WAIT,
} from "@aztec/aztec.js/contracts"
import { Account } from "@aztec/aztec.js/account"
import { TxReceipt, TxHash, TxProfileResult } from "@aztec/stdlib/tx"
import { waitForTx } from "@aztec/aztec.js/node"
import { TESTNET_TIMEOUT } from "../utils/constants.js"
import { QueueStatus, TransactionProgress } from "@obsidion/core/constants"
import { createAsyncTransaction } from "../utils/helper.js"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import type { OriginalFlowKind } from "@obsidion/proving-progress"
import { type TeeSigner } from "@oxide/oxide-lib/types.js"
import {
  type BuildTeeOperationSendOpts,
  dedupeByAddressString,
} from "./teeOperation.js"

/**
 * Base options for all service methods that interact with contracts
 */
export interface BaseServiceMethodOptions {
  /** Options for the send transaction */
  sendOptions?: SendInteractionOptions
  /** If true, profile the transaction before sending (logs gate counts) */
  profile?: boolean
  /**
   * Caller-supplied operation id. When
   * the React-side `usePaymentFlow` mints a fresh op id at Confirm tap, it
   * threads the id through here so `wallet.sendTx` sees it on the merged
   * send options. The wallet's `withProvingScope` then registers the
   * provided id instead of generating one — keeping the synth row's op id
   * in sync with proving-progress events.
   */
  operationId?: string
  /**
   * Original-flow kind. Threaded through
   * `wallet.sendTx`'s `opts.kind` so withdraw / paylink-create flows route
   * their proving-progress events and persisted record with the right
   * discriminator. Defaults to `"send"` at the wallet boundary when omitted.
   */
  kind?: OriginalFlowKind
  /**
   * When true, `sendAndWait` suppresses ALL of its own progress/status
   * emissions for this call: the service status events
   * (`emitProveAndSend`/`emitMining`/`emitSuccess`/`emitFailed`), the
   * wait-phase `provingProgress.emitStageComplete(Mining)`, and the
   * catch-block `provingProgress.emitReset()`. Used by `paylink-create`,
   * which historically dispatched via a bespoke direct `wallet.sendTx(...
   * NO_WAIT)` that emitted none of these — keeping it `silent` makes routing
   * through `sendAndWait` behavior-neutral (no service-emitted status row
   * feeding the tracked-tx queue, no proving-UI reset). The wallet-boundary
   * proving emissions and proving-scope registration inside `wallet.sendTx`
   * (driven by `kind` / `operationId`) are unaffected — they already fired
   * on the direct path, so `silent` only gates this class's own emits.
   * Defaults to false — no change for existing callers.
   */
  silent?: boolean
  /**
   * Lazy-start simulation gate, forwarded verbatim to `wallet.sendTx`'s
   * `confirmGate` via `sendAndWait`'s merged send options. The UI starts the
   * service call at confirmation-modal mount and resolves this on confirm /
   * rejects (AbortError) on dismiss or TTL. Undefined for every non-lazy
   * caller. See {@link ObsidionWallet.sendTx}.
   */
  confirmGate?: Promise<unknown>
}

/**
 * Generic method options type that combines base options with method-specific options
 */
export type MethodOptions<T extends object = object> = BaseServiceMethodOptions & T

export class ServiceBase extends EventEmitter {
  protected wallet: ObsidionWallet
  protected _lastProfileSteps: { method: string; gateCount: number }[] | undefined = undefined
  /** Delegate whose profile steps are used as fallback when this service has none. */
  protected _profileDelegate: ServiceBase | undefined = undefined
  /**
   * Optional TEE signer for services that drive oxide's submit-style flows
   * (TokenService for transfer/withdraw, PaylinkService for claim/refund).
   * Services that don't dispatch TEE-signed batches (ClientFee,
   * OidcKeyRegistry, ...) leave it undefined; calling
   * {@link getTeeSigner} on a service without a wired signer throws.
   *
   * Lives on ServiceBase (not ServiceContractBase) so PaylinkService — which
   * extends ServiceBase directly but still dispatches via `buildTeeOperation`
   * — can hold its own signer without brokering through TokenService.
   */
  private _teeSigner?: TeeSigner

  constructor(wallet: ObsidionWallet, teeSigner?: TeeSigner) {
    super()
    this.wallet = wallet
    this._teeSigner = teeSigner
  }

  /**
   * Inject, replace, or clear the TEE signer post-construction. Mirrors the
   * relayer `BridgeService.setTeeSigner` pattern — useful when the bridge
   * context (l1Portal / l2Bridge addresses) is only known after the L2
   * bridge has been deployed and the signer needs to be reified with it.
   *
   * Passing `undefined` clears the wired signer; subsequent `getTeeSigner()`
   * calls will throw the standard "TEE signer not wired" error. The clear
   * path supports React-hook fan-out where the same service instance can
   * see a config change (network switch, account change) that invalidates
   * the previously-fanned-in signer.
   */
  public setTeeSigner(teeSigner?: TeeSigner): void {
    this._teeSigner = teeSigner
  }

  /**
   * Returns the wired TEE signer, throwing a clear error if none was passed
   * at construction or via {@link setTeeSigner}. Service methods that route
   * through `buildTeeOperation` call this; methods that don't need a signer
   * never touch it.
   */
  protected getTeeSigner(): TeeSigner {
    if (!this._teeSigner) {
      throw new Error(
        `[${this.constructor.name}] TEE signer not wired. Pass \`teeSigner\` to the constructor / static \`create(...)\` or call \`setTeeSigner(...)\` before invoking a flow that requires oxide's submit().`,
      )
    }
    return this._teeSigner
  }

  public get lastProfileSteps(): { method: string; gateCount: number }[] | undefined {
    return this._lastProfileSteps ?? this._profileDelegate?.lastProfileSteps
  }
  public emitInit() {
    this.emit("status", QueueStatus.INITIALIZING, TransactionProgress.INITIALIZING)
  }

  public emitProveAndSend() {
    this.emit("status", QueueStatus.PROVING_AND_SENDING, TransactionProgress.PROVING_AND_SENDING)
  }

  public emitMining() {
    this.emit("status", QueueStatus.MINING, TransactionProgress.MINING)
  }

  public emitSuccess(txHash: string) {
    this.emit("status", QueueStatus.SUCCESS, TransactionProgress.SUCCESS, txHash)
  }

  public emitFailed(txHash: string | undefined) {
    this.emit("status", QueueStatus.FAILED, TransactionProgress.FAILED, txHash)
  }

  /**
   * Get send options, using provided options or falling back to wallet defaults.
   * @param from - The sender address for default options
   * @param options - Optional method options that may contain sendOptions
   * @returns SendInteractionOptions to use for the transaction
   */
  protected async getSendOptions(
    from: AztecAddress,
    options?: BaseServiceMethodOptions,
  ): Promise<SendInteractionOptions> {
    return options?.sendOptions ?? (await this.wallet.getDefaultSendOptions(from))
  }

  /**
   * Internal helper to log profile results as a formatted table.
   * @param executionSteps - The execution steps from the profile result
   * @param label - Label to display in the header (string or array of strings)
   */
  private logProfileResult(
    executionSteps: { functionName: string; gateCount?: number }[],
    label: string | string[],
  ): void {
    let totalGateCount = 0
    const steps: { id: number; method: string; gateCount: number }[] = []

    for (const step of executionSteps) {
      steps.push({
        id: steps.length + 1,
        method: step.functionName,
        gateCount: step.gateCount ?? 0,
      })
      totalGateCount += step.gateCount ?? 0
    }

    // Create table header
    console.log("\n" + "=".repeat(80))
    console.log("EXECUTION PROFILE: ", label)
    console.log("=".repeat(80))

    // Table header
    console.log("┌─────┬──────────────────────────────────────┬─────────────┐")
    console.log("│ ID  │ Method                               │ Gate Count  │")
    console.log("├─────┼──────────────────────────────────────┼─────────────┤")

    // Table rows
    for (const step of steps) {
      const id = step.id.toString().padStart(3)
      const method = step.method.padEnd(36)
      const gateCount = step.gateCount.toString().padStart(11)
      console.log(`│ ${id} │ ${method} │ ${gateCount} │`)
    }

    // Table footer with total
    console.log("├─────┼──────────────────────────────────────┼─────────────┤")
    const totalStr = totalGateCount.toString().padStart(11)
    console.log(`│     │ TOTAL                                │ ${totalStr} │`)
    console.log("└─────┴──────────────────────────────────────┴─────────────┘")
    console.log("=".repeat(80) + "\n")
  }

  /**
   * Profile a contract interaction and log gate counts.
   * This profiles the transaction without actually sending it.
   * @param interaction The contract function interaction or deploy method to profile
   * @param options Simulation options including the 'from' address
   */
  protected async profileInteraction(
    interaction: ContractFunctionInteraction | DeployMethod,
    options: SimulateInteractionOptions,
  ): Promise<{ method: string; gateCount: number }[]> {
    const result: TxProfileResult = await interaction.profile({
      ...options,
      profileMode: "gates",
      skipProofGeneration: true,
    })

    const executionNames = (await interaction.request()).calls.map((call) => call.name)
    this.logProfileResult(result.executionSteps, executionNames)

    const steps = result.executionSteps.map((step) => ({
      method: step.functionName,
      gateCount: step.gateCount ?? 0,
    }))
    this._lastProfileSteps = steps
    return steps
  }

  /**
   * Helper to send a transaction and wait for completion with standardized emit lifecycle.
   * Supports optional profiling before sending the transaction.
   *
   * `init.interaction` accepts either a `ContractFunctionInteraction` (the
   * legacy single-call path used by every non-TEE caller) or a `BatchCall`
   * (the path U4/U6 lands when token/paylink TEE flows route through
   * {@link buildTeeOperation}). Both expose
   * `.send({ wait: NO_WAIT })` and return `{ txHash, offchainMessages, offchainEffects }`.
   *
   * `BatchCall` has no `.with()` method, so the profile branch is guarded
   * by an `instanceof ContractFunctionInteraction` check (see inline comment).
   *
   * Op-id parity with `ObsidionWallet.sendTx` (which emits
   * `ProvingStage.Mining` start) is achieved by threading
   * `options.operationId` / `options.kind` into the merged `sendOptions`
   * — NOT by emitting a second Mining stage-start here, which would
   * double-fire to subscribers (TxLifecycleService, UI proving feeds).
   *
   * @param initFn Function that returns the interaction and any extra data { interaction, ...extra }
   * @param buildResult Function that transforms the result after tx is mined (can be async)
   * @param options Optional options including sendOptions and profile flag
   */
  protected sendAndWait<
    TInit extends {
      interaction: ContractFunctionInteraction | BatchCall
      sendOpts?: BuildTeeOperationSendOpts
    },
    TResult,
  >(
    initFn: () => Promise<TInit>,
    buildResult: (
      data: Omit<TInit, "interaction" | "sendOpts"> & {
        txHash: string
        receipt: TxReceipt
      } & OffchainOutput,
    ) => TResult | Promise<TResult>,
    options?: BaseServiceMethodOptions,
  ): {
    txPromise: Promise<TResult>
    txHash: Promise<string>
    // adding this for the offchin effects, little bit of duplication with the txhash
    sentTx: Promise<TInit & { txHash: string } & OffchainOutput>
  } {
    return createAsyncTransaction(
      async () => {
        try {
          if (!options?.silent) this.emitProveAndSend()
          const init = await initFn()

          // Profile if requested (capsules from sendOptions must also be available during simulation).
          // Profiling uses `.with({ capsules })`, which exists on `ContractFunctionInteraction` but
          // NOT on `BatchCall` — when `init.interaction` is a `BatchCall` (TEE token/paylink flows
          // landing under U4/U6), the profile branch is silently skipped. Accepted regression:
          // paylink benchmark tests that pass `profile: true` lose profile data for TEE flows.
          if (
            options?.profile &&
            options.sendOptions?.from &&
            init.interaction instanceof ContractFunctionInteraction
          ) {
            const capsules = options.sendOptions?.capsules
            const interactionToProfile = capsules?.length
              ? init.interaction.with({ capsules })
              : init.interaction
            this._lastProfileSteps = await this.profileInteraction(interactionToProfile, {
              from: options.sendOptions.from,
              additionalScopes: options.sendOptions.additionalScopes,
            })
          }

          // Send the transaction (sendOptions must be provided by the service method)
          if (!options?.sendOptions) {
            throw new Error("sendOptions must be provided to sendAndWait")
          }

          // Merge caller-supplied `sendOptions` with any `sendOpts` returned by
          // `buildTeeOperation`. Semantics:
          //   - `additionalScopes`: UNION of both arrays, deduped by
          //     `AztecAddress.toString()` (object-identity dedupe would miss
          //     two address instances built from the same hex).
          //   - `fee`: shallow-merge. The {@link buildTeeOperation} contract
          //     guarantees `sendOpts.fee` carries `paymentMethod` only — never
          //     `gasSettings` — so the caller's `gasSettings` survives by
          //     construction. If a future revision adds `gasSettings` to
          //     `sendOpts.fee`, switch to explicit per-sub-key deep merge.
          //   - `operationId` / `kind`: propagated from `options` so
          //     `wallet.sendTx` picks them up for Mining-stage emits and
          //     proving-scope registration.
          //   - `finalize`: the staged-execution finalizer minted by
          //     `buildTeeOperation`. `wallet.sendTx` invokes it with its
          //     single pre-simulation's result and proves the payload it
          //     returns — see `obsidion/stagedExecution.ts`. Undefined for
          //     every non-TEE caller (no `init.sendOpts`).
          //   - Other keys: shallow-merged from `options.sendOptions`.
          const mergedSendOptions = {
            ...options.sendOptions,
            additionalScopes: dedupeByAddressString([
              ...(options.sendOptions?.additionalScopes ?? []),
              ...(init.sendOpts?.additionalScopes ?? []),
            ]),
            fee: { ...options.sendOptions?.fee, ...init.sendOpts?.fee },
            operationId: options.operationId,
            kind: options.kind,
            finalize: init.sendOpts?.finalize,
            // Lazy-start: forward the confirm gate to wallet.sendTx so it blocks
            // signing/prove/submit until the user confirms. (`silent` is NOT put
            // here — it is consumed by sendAndWait itself, above, not by sendTx.)
            confirmGate: options.confirmGate,
          }

          // Send with NO_WAIT to get txHash immediately
          const { txHash, offchainMessages, offchainEffects } = await init.interaction.send({
            ...mergedSendOptions,
            wait: NO_WAIT,
          })

          return {
            ...init,
            txHash: txHash.toString(),
            offchainMessages: offchainMessages,
            offchainEffects: offchainEffects,
          }
        } catch (error) {
          if (!options?.silent) {
            provingProgress.emitReset()
            this.emitFailed(undefined)
          }
          throw error
        }
      },
      async (init) => {
        try {
          if (!options?.silent) this.emitMining()
          // Use waitForTx to wait for the transaction to be mined
          const receipt = await waitForTx(this.wallet.node, TxHash.fromString(init.txHash), {
            ...this.wallet.defaultWaitOpts,
            timeout: TESTNET_TIMEOUT,
          })
          if (!options?.silent) {
            provingProgress.emitStageComplete(ProvingStage.Mining, options?.operationId)
            this.emitSuccess(init.txHash)
          }
          const { interaction, sendOpts, ...rest } = init
          return await buildResult({ ...rest, receipt } as Omit<
            TInit,
            "interaction" | "sendOpts"
          > & {
            txHash: string
            receipt: TxReceipt
          } & OffchainOutput)
        } catch (error) {
          if (!options?.silent) {
            provingProgress.emitReset()
            this.emitFailed(init.txHash)
          }
          throw error
        }
      },
    )
  }
}

export abstract class ServiceContractBase extends ServiceBase {
  private static registrationPromises: Map<ContractName, Promise<void>> = new Map()

  protected contractService: ContractService
  private deploymentInProgress: Promise<ContractBase | undefined> | null = null
  protected contractAddress: AztecAddress | undefined
  protected contractName: ContractName
  protected contract: ContractBase | undefined
  protected deployer?: Account

  constructor(
    contractName: ContractName,
    wallet: ObsidionWallet,
    contractAddress?: AztecAddress,
    deployer?: Account,
    contractService?: ContractService,
    teeSigner?: TeeSigner,
  ) {
    super(wallet, teeSigner)
    this.contractService = contractService ?? ContractService.getInstance()
    this.contractName = contractName
    this.contractAddress = contractAddress
    this.deployer = deployer

    this.registerContract()
  }

  protected getDeployer(): AztecAddress {
    if (!this.deployer) {
      throw new Error("Deployer not initialized")
    }
    return this.deployer.getAddress()
  }

  private registerContract(): void {
    if (ServiceContractBase.registrationPromises.has(this.contractName)) {
      return
    }

    const promise = this.contractService
      .registerContractWithName(this.contractName)
      .catch((error) => {
        console.error(`Error registering contract ${this.contractName}:`, error)
        ServiceContractBase.registrationPromises.delete(this.contractName)
      })

    ServiceContractBase.registrationPromises.set(this.contractName, promise)
  }

  protected async ensureContractsRegistered(): Promise<void> {
    const promise = ServiceContractBase.registrationPromises.get(this.contractName)
    if (promise) {
      await promise
    }
  }

  public async getContractAddress(): Promise<AztecAddress> {
    if (this.contractAddress) {
      return this.contractAddress
    }

    if (!this.contractAddress) {
      this.contractAddress = await this.contractService.getContractAddress(this.contractName)
      if (!this.contractAddress) {
        throw new Error(`Contract address not found for contract ${this.contractName}`)
      }
    }
    return this.contractAddress
  }

  protected async getContract(address?: AztecAddress): Promise<ContractBase> {
    if (this.contract) {
      await this.ensureContractsRegistered()
      return this.contract
    }

    let contract: ContractBase
    // A service constructed with an explicit address anchors on it even when the caller passes
    // none — operations must run against the address the service exposes.
    const anchor = address ?? this.contractAddress
    if (anchor) {
      contract = await this.contractService.getContractWithArtifactAndAddress(
        anchor,
        this.wallet,
        await this.contractService.getArtifactForContract(this.contractName, anchor),
      )
    } else {
      contract = await this.contractService.getContract(this.contractName, this.wallet)
    }

    if (!contract) {
      throw new Error(`Failed to get contract ${this.contractName}`)
    }

    this.contract = contract

    await this.ensureContractsRegistered()
    return contract
  }

  protected async deployContract(
    args: any[],
    options?: DeployOptions,
    instantiation?: DeployInstantiationOptions,
  ): Promise<ContractBase | undefined> {
    if (this.deploymentInProgress) {
      console.log(`Deployment for contract ${this.contractName} already in progress, waiting...`)
      return this.deploymentInProgress
    }

    this.deploymentInProgress = this.deployContractInternal(args, options, instantiation)

    return await this.deploymentInProgress
  }

  private async deployContractInternal(
    args: any[],
    options?: DeployOptions,
    instantiation?: DeployInstantiationOptions,
  ): Promise<ContractBase | undefined> {
    console.debug(`deploying contract ${this.contractName}...`)

    try {
      const artifact = await this.contractService.getArtifactForContract(this.contractName)

      const defaultOptions = options
        ? options
        : await this.wallet.getDefaultSendOptions(this.getDeployer())

      // Update internal address and store in ContractService
      const deployed = await Contract.deploy(
        this.wallet,
        artifact,
        args,
        undefined,
        instantiation,
      ).send(defaultOptions)
      this.contract = deployed.contract
      this.contractAddress = this.contract.address

      await this.contractService.setContractAddress(this.contractName, this.contract.address)

      return this.contract
    } catch (error) {
      console.error(`Error deploying contract ${this.contractName}:`, error)
      throw error
    } finally {
      this.deploymentInProgress = null
    }
  }
}
