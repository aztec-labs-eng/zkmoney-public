import { NO_FROM } from "@aztec/aztec.js/account"
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { isL1ToL2MessageReady } from "@aztec/aztec.js/messaging"
import { TxHash, TxStatus, TxExecutionResult } from "@aztec/stdlib/tx"
import type { FunctionCall } from "@aztec/stdlib/abi"
import {
  decodeMetadataUpdateIntentData,
  decodeMetadataUpdateProofs,
  encodeUserRecordMetadata,
  predictSIPA,
  readMetadataStateHash,
  readNameOf,
  userRecordStateHash,
  type UserRecordArg,
} from "@oxide/l1-contracts"
import type { BroadcastL1Operation } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { erc20Abi, keccak256, toHex, type Address, type Hex } from "viem"
import {
  prepareMetadataUpdate,
  assertMetadataUpdateFresh,
  readMetadataDestinationState,
  readMetadataUpdateFee,
  readOrdinaryDepositFee,
  type PreparedMetadataUpdate,
} from "./metadataMigration.js"
import {
  prepareMigrationBootstrap,
  claimFpcIdentitySubscribed,
  type MigrationBootstrapOptions,
} from "./migrationBootstrap.js"
import {
  buildClaimSubscribePayload,
  buildClaimSponsorPayload,
  type OxideAccountBinding,
} from "../feePaymentMethod/claimSponsoredCall.js"
import { claimFpcSponsoredFee } from "../feePaymentMethod/claimFpcBatchGas.js"
import { claimFpcSubscriptionUses, hasClaimFpcSubscription } from "./claimSponsor.js"
import {
  findRegistrationMessage,
  registrationInbox,
  REGISTRATION_MESSAGE_SECRET,
} from "./registrationMessage.js"
import { readSweepEvents, readDepositMessageKey } from "./sipaClaim.js"
import {
  migrationDepositCalls,
  migrationSipaCoordinates,
  receiveMigrationSweeps,
  resolveMigrationDeposit,
  type MigrationDestinationContext,
} from "./migrationDeposit.js"

/** A source generation supplies public DTOs; its Aztec objects/prover never cross into this SDK. */
export interface MetadataMigrationSource {
  /** Includes source rollup, portal, asset and proof generation. */
  identity: string
  /** Read actual source state. This must not freeze a live deployment. */
  state(): Promise<"live" | "frozen" | "empty">
  /**
   * Select one sufficient batch after the source's exit fee. The returned net amount is denominated in the
   * destination deposit asset. Reject an unavailable settlement route before authorizing a broadcast.
   */
  prepare(
    recipient: Address,
    minimumNetAmount: bigint,
  ): Promise<{
    id: string
    netAmount: bigint
    operation?: BroadcastL1Operation
  }>
  /** Rebuild from source data and verify the selected batch still pays the specified SIPA. */
  restore(
    id: string,
    recipient: Address,
  ): Promise<{ netAmount: bigint; operation?: BroadcastL1Operation }>
  /** Live burn only. Must durably record its tx before RPC and reconcile it on retries. */
  fund(id: string, recipient: Address): Promise<void>
  /** Existing source recovery adapter, restricted to ordinary DepositSIPAs after bootstrap. */
  recoverRemaining(): Promise<void>
  remainingComplete(): Promise<boolean>
  /**
   * What a run moves from here now, by the rule each batch applies: the first must net at least
   * `first` after the source's exit, each later one at least `later`.
   */
  quote?(minimums: { first: bigint; later: bigint }): Promise<MigrationSourceQuote>
}

/** Funds still on the source, read from chain. A refund counts until it executes on L1. */
export interface MigrationSourceQuote {
  /** What a run moves now. */
  movable: bigint
  /** What no batch can afford. */
  stranded: bigint
  /** What the source can't refund yet. */
  waiting: bigint
}

type FpcOptions = MigrationBootstrapOptions["fpc"]

export interface MetadataMigrationServiceOptions
  extends Omit<MigrationDestinationContext, "node" | "recipient" | "recoveryAccount"> {
  wallet: MigrationBootstrapOptions["wallet"]
  /** The registered OxideAccount; it recovers every migration SIPA. */
  owner: Address
  record: UserRecordArg
  source: MetadataMigrationSource
  bootstrap: FpcOptions
  registered: FpcOptions
  nameClaim(): Promise<
    Extract<MigrationBootstrapOptions["sponsorship"], { kind: "bootstrap" }>["gate"]
  >
  bindingWitness(nameHash: Hex): Promise<OxideAccountBinding>
  signConsent(digest: Hex): Promise<Hex>
  /** Scan bound captured before publication, persisted with the signed plan. */
  fromBlock?: bigint
}

interface Plan {
  binding: string
  day: number
  nonce: number
  fromBlock: string
  intentData: Hex
  proofs: Hex
  sourceState: "live" | "frozen" | "empty"
  sourceBatch?: string
}

/** Contract adapter used by the shared front-core durable driver. No L1 writes or relayer requests. */
export class MetadataMigrationService {
  private prepared?: { plan: string; batch: Awaited<ReturnType<typeof prepareMigrationBootstrap>> }
  constructor(private readonly options: MetadataMigrationServiceOptions) {}

  private get deposits(): MigrationDestinationContext {
    const o = this.options
    return {
      ...o,
      node: o.wallet.node,
      recipient: o.registered.user,
      recoveryAccount: o.owner,
    }
  }

  async needsMigration(): Promise<boolean> {
    const o = this.options
    const name = await readNameOf(o.client, o.destination.nameRegistry, o.owner)
    if (/^0x0+$/.test(name)) return false
    return (
      (await readMetadataStateHash(o.client, o.destination.controller, o.owner)) !==
      userRecordStateHash(o.record)
    )
  }

  async funding(raw: string) {
    const { sipa, plan } = await this.restore(raw)
    const o = this.options
    const token = o.destination.token
    const [fee, decimals, symbol] = await Promise.all([
      readMetadataUpdateFee(o.client, o.destination),
      o.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      o.client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    ])
    return {
      address: sipa,
      fee,
      minimumAmount: fee + 1n,
      token,
      decimals,
      symbol,
      external: plan.sourceState === "empty",
    }
  }

  async binding(): Promise<string> {
    const o = this.options
    return keccak256(
      toHex(
        JSON.stringify({
          source: o.source.identity,
          destination: Object.values(o.destination).map(String),
          owner: o.owner,
          record: encodeUserRecordMetadata(o.record),
          fpc: o.bootstrap.fpcAddress.toString(),
          bootstrap: o.bootstrap.railId,
          registered: o.registered.railId,
        }),
      ),
    )
  }

  private resolve(day: number, nonce: number) {
    const o = this.options
    return o.selfResolver.resolve(o.bootstrap.user, day, nonce, EthAddress.fromString(o.owner))
  }

  async prepare(): Promise<string> {
    const o = this.options
    if (!o.bootstrap.fpcAddress.equals(o.registered.fpcAddress)) {
      throw new Error("Bootstrap and recurring rails must belong to the same destination FPC")
    }
    if (!o.bootstrap.user.equals(o.registered.user)) {
      throw new Error("Bootstrap and recurring sponsorship must name the same destination account")
    }
    const info = await o.wallet.node.getNodeInfo()
    if (BigInt(info.rollupVersion) !== o.destination.rollupVersion) {
      throw new Error("The wallet is connected to a different destination rollup")
    }
    const { day, nonce } = migrationSipaCoordinates()
    const resolution = await this.resolve(day, nonce)
    const metadata = await prepareMetadataUpdate({
      client: o.client,
      destination: o.destination,
      owner: o.owner,
      record: o.record,
      fpc: o.bootstrap.fpcAddress.toString() as Hex,
      recipientCommitment: resolution.recipientHash.toString() as Hex,
      recoveryCommitment: resolution.recoveryCommitment.toString() as Hex,
      signConsent: o.signConsent,
    })
    const sourceState = await o.source.state()
    // A current destination record publishes no bootstrap, so its refund would never be broadcast.
    const first = await this.firstBatch(async () => sourceState)
    const batch =
      sourceState === "empty" || first.skipped
        ? undefined
        : await o.source.prepare(metadata.sipa, first.minimum)
    if (batch && batch.netAmount <= metadata.fee)
      throw new Error("The first batch cannot fund the migration fee and a positive deposit")
    if (sourceState === "frozen" && !first.skipped && !batch?.operation)
      throw new Error("Frozen migration requires a source refund operation")
    if (sourceState === "live" && batch?.operation)
      throw new Error("A live source must use its withdrawal path")
    // Preparing the real payload also checks the call budget, gate and every signature before
    // front-core persists the plan. It does not prove or submit a transaction.
    const prepared = await this.bootstrap(metadata, resolution.messageSecret, batch?.operation)
    const plan = JSON.stringify({
      binding: await this.binding(),
      day,
      nonce,
      fromBlock: String(o.fromBlock ?? (await o.client.getBlockNumber())),
      intentData: metadata.intentData,
      proofs: metadata.proofs,
      sourceState,
      sourceBatch: batch?.id,
    } satisfies Plan)
    this.prepared = { plan, batch: prepared }
    return plan
  }

  private async restore(raw: string, verifyConsent = false) {
    const o = this.options
    const plan = JSON.parse(raw) as Plan
    if (plan.binding !== (await this.binding()))
      throw new Error("Migration account or deployment changed")
    const resolution = await this.resolve(plan.day, plan.nonce)
    const intent = decodeMetadataUpdateIntentData(plan.intentData)
    const signature = decodeMetadataUpdateProofs(plan.proofs)
    // Re-derive routing from the current trusted context. Persisted calldata never chooses a
    // different recipient or registry. Consent is checked again before a new publication.
    if (
      intent.metadata.toLowerCase() !== encodeUserRecordMetadata(o.record).toLowerCase() ||
      intent.owner.toLowerCase() !== o.owner.toLowerCase() ||
      intent.metadataRegistry.toLowerCase() !== o.destination.metadataRegistry.toLowerCase() ||
      intent.recipientCommitment.toLowerCase() !==
        resolution.recipientHash.toString().toLowerCase() ||
      intent.namePortalRecipient.toLowerCase() !==
        o.bootstrap.fpcAddress.toString().toLowerCase() ||
      intent.namePortal.toLowerCase() !== o.destination.namePortal.toLowerCase() ||
      intent.rollupVersion !== o.destination.rollupVersion
    ) {
      throw new Error("Stored migration intent does not match the destination")
    }
    if (verifyConsent) {
      const metadata = await prepareMetadataUpdate({
        client: o.client,
        destination: o.destination,
        owner: o.owner,
        record: o.record,
        fpc: o.bootstrap.fpcAddress.toString() as Hex,
        recipientCommitment: resolution.recipientHash.toString() as Hex,
        recoveryCommitment: resolution.recoveryCommitment.toString() as Hex,
        signConsent: async () => signature,
      })
      if (metadata.intentData !== plan.intentData)
        throw new Error("Metadata state changed; prepare migration again")
      return { plan, resolution, metadata, sipa: metadata.sipa }
    }
    const sipa = await predictSIPA(
      o.client,
      o.destination.factory,
      o.destination.implementation,
      keccak256(plan.intentData),
      resolution.recoveryCommitment.toString() as Hex,
      o.destination.rollupVersion,
      false,
    )
    return { plan, resolution, sipa, metadata: undefined }
  }

  /** A current destination record with recurring sponsorship needs no bootstrap: recovery is ordinary deposits. */
  private async bootstrapSkipped(): Promise<boolean> {
    const o = this.options
    return (
      (await this.recurring()) &&
      (await readMetadataDestinationState(o.client, o.destination, o.owner)) ===
        userRecordStateHash(o.record)
    )
  }

  /**
   * The source's first batch. A frozen source skips it once the destination record is current,
   * and recovers through ordinary deposits. Every other first batch funds the metadata update.
   */
  private async firstBatch(state: () => ReturnType<MetadataMigrationSource["state"]>) {
    const o = this.options
    const skipped = (await this.bootstrapSkipped()) && (await state()) === "frozen"
    const fee = skipped
      ? await readOrdinaryDepositFee(o.client, o.destination)
      : await readMetadataUpdateFee(o.client, o.destination)
    return { skipped, minimum: fee + 1n }
  }

  /**
   * What a run moves from the source now, by the rules `prepare` and recovery apply. Once the saved
   * run's first refund has settled (`firstBatchSettled`), the rest pays only ordinary deposit fees.
   */
  async quote(opts: { firstBatchSettled?: boolean } = {}): Promise<MigrationSourceQuote> {
    const o = this.options
    if (!o.source.quote) throw new Error("This migration source cannot quote its funds")
    const later = (await readOrdinaryDepositFee(o.client, o.destination)) + 1n
    const first = opts.firstBatchSettled
      ? later
      : (await this.firstBatch(() => o.source.state())).minimum
    return o.source.quote({ first, later })
  }

  async movable(): Promise<boolean> {
    return (await this.quote()).movable > 0n
  }

  private async recurring(): Promise<boolean> {
    const o = this.options
    if (
      (await claimFpcSubscriptionUses(
        o.wallet,
        o.registered.fpcAddress,
        o.registered.fpcArtifact,
        o.registered.user,
        o.registered.railId,
      )) > 0
    )
      return true
    if (
      !(await hasClaimFpcSubscription(
        o.wallet,
        o.registered.fpcAddress,
        o.registered.fpcArtifact,
        o.registered.user,
        o.registered.railId,
      ))
    )
      return false
    // A zero-use note may refill. Ask the contract through a read-only sponsor simulation,
    // using its actual anchor and policy instead of duplicating the refill calculation.
    const innerCalls = await this.receiveCalls(0, 0)
    const payload = await buildClaimSponsorPayload({ ...o.registered, innerCalls })
    try {
      await o.wallet.simulateTx(payload, {
        from: NO_FROM,
        additionalScopes: [o.registered.user],
        fee: claimFpcSponsoredFee(o.registered.policy, innerCalls),
      })
      return true
    } catch (error) {
      if (String(error).includes("allowance exhausted")) return false
      throw error
    }
  }

  private async bootstrap(
    metadata: PreparedMetadataUpdate,
    messageSecret: Fr,
    refund?: BroadcastL1Operation,
  ) {
    const o = this.options
    const recurring = await this.recurring()
    return prepareMigrationBootstrap({
      client: o.client,
      wallet: o.wallet,
      metadata,
      token: o.token,
      broadcaster: o.broadcaster,
      messageSecret,
      refund,
      sponsorship: recurring
        ? { kind: "registered" }
        : { kind: "bootstrap", gate: await o.nameClaim() },
      fpc: recurring ? o.registered : o.bootstrap,
    })
  }

  async broadcast(raw: string, onTxHash: (txHash: string) => Promise<void>): Promise<void> {
    const o = this.options
    const { plan, resolution, metadata, sipa } = await this.restore(raw, true)
    if ((await o.source.state()) !== plan.sourceState)
      throw new Error("Source state changed; prepare migration again")
    if (plan.sourceState === "frozen" && !plan.sourceBatch)
      throw new Error("Destination metadata changed; prepare migration again")
    const batch = plan.sourceBatch ? await o.source.restore(plan.sourceBatch, sipa) : undefined
    if (batch && batch.netAmount <= metadata!.fee)
      throw new Error("Source batch no longer covers migration funding")
    // Reuse every collected signature in this process. A cold restart re-creates only the
    // unpublished L2 batch; metadata consent remains the signed public plan on disk.
    const prepared =
      this.prepared?.plan === raw
        ? this.prepared.batch
        : await this.bootstrap(metadata!, resolution.messageSecret, batch?.operation)
    await o.wallet.sendTx(prepared.payload, {
      ...prepared.sendOptions,
      onTxHash: async (hash) => {
        await assertMetadataUpdateFresh(o.client, metadata!)
        await onTxHash(hash)
      },
    })
  }

  async fund(raw: string): Promise<void> {
    const { plan, sipa } = await this.restore(raw)
    const state = await readMetadataDestinationState(
      this.options.client,
      this.options.destination,
      this.options.owner,
    )
    const intent = decodeMetadataUpdateIntentData(plan.intentData)
    if (state !== intent.expectedStateHash && state !== userRecordStateHash(this.options.record)) {
      throw new Error("Destination metadata changed after publication; funding requires attention")
    }
    if (plan.sourceState === "live" && plan.sourceBatch)
      await this.options.source.fund(plan.sourceBatch, sipa)
  }

  private async attestation(fromBlock: bigint) {
    const o = this.options
    const info = await o.wallet.node.getNodeInfo()
    const nameHash = await readNameOf(o.client, o.destination.nameRegistry, o.owner)
    const message = await findRegistrationMessage(
      registrationInbox(o.client, info.l1ContractAddresses.inboxAddress),
      o.wallet.node,
      {
        fpc: o.registered.fpcAddress,
        namePortal: EthAddress.fromString(o.destination.namePortal),
        owner: EthAddress.fromString(o.owner),
        nameHash: Buffer.from(nameHash.slice(2), "hex"),
        rollupVersion: info.rollupVersion,
        l1ChainId: Number(o.destination.chainId),
      },
      { fromBlock },
    )
    return { message, nameHash }
  }

  async observe(record: { plan?: string; bootstrapTx?: string; subscriptionTx?: string }) {
    const o = this.options
    if (!record.plan) throw new Error("Migration has no prepared plan")
    const { plan, sipa } = await this.restore(record.plan)
    const recurringSponsorship = await this.recurring()
    const metadataSettled =
      (await readMetadataDestinationState(o.client, o.destination, o.owner)) ===
      userRecordStateHash(o.record)
    const sweeps = await readSweepEvents(o.client, sipa, BigInt(plan.fromBlock))
    const sweep = sweeps.at(-1)
    const key =
      sweep &&
      (await readDepositMessageKey(o.client, o.destination.portal, sweep.txHash, sweep.index))
    const depositReady = !!key && (await isL1ToL2MessageReady(o.wallet.node, key))
    const { message } = await this.attestation(BigInt(plan.fromBlock))
    return {
      bootstrapStatus: await this.txState(record.bootstrapTx),
      subscriptionStatus: await this.txState(record.subscriptionTx),
      bootstrapSpent: await claimFpcIdentitySubscribed(
        o.wallet.node,
        o.bootstrap.fpcAddress,
        o.owner,
        o.bootstrap.railId,
      ),
      metadataSettled,
      messagesReady:
        metadataSettled &&
        depositReady &&
        (message?.status === "consumable" || recurringSponsorship),
      recurringSponsorship,
      // A verified sweep + imported message + locally stored deposit establishes the receipt.
      // Storing is repeatable and always uses chain events, including after a PXE restart. A
      // destination record that was already current published no bootstrap, so no first deposit.
      complete:
        metadataSettled &&
        recurringSponsorship &&
        (!record.bootstrapTx || (depositReady && (await this.claim(record.plan)))) &&
        (await o.source.remainingComplete()),
    }
  }

  private async txState(
    hash?: string,
  ): Promise<"unknown" | "pending" | "included" | "reverted" | "dropped" | undefined> {
    if (!hash) return undefined
    const receipt = await this.options.wallet.node.getTxReceipt(TxHash.fromString(hash))
    // The node also returns DROPPED for an unknown hash (including after pruning or a
    // node restart). That is not proof that this signed transaction cannot still land.
    if (receipt.status === TxStatus.DROPPED) return "unknown"
    if (receipt.status === TxStatus.PENDING) return "pending"
    if (receipt.executionResult === TxExecutionResult.REVERTED) return "reverted"
    if (receipt.executionResult === TxExecutionResult.SUCCESS) return "included"
    return "unknown"
  }

  async subscribe(raw: string, onTxHash: (txHash: string) => Promise<void>): Promise<void> {
    const o = this.options
    const { plan } = await this.restore(raw)
    if (
      (await readMetadataDestinationState(o.client, o.destination, o.owner)) !==
      userRecordStateHash(o.record)
    ) {
      throw new Error("Destination metadata changed before sponsorship activation")
    }
    if (!(await this.claim(raw))) throw new Error("The migration deposit is not available yet")
    const { message, nameHash } = await this.attestation(BigInt(plan.fromBlock))
    if (message?.status !== "consumable")
      throw new Error("The registration attestation is not available to subscribe")
    // ClaimFPC requires at least one real batched call. Publish the ordinary receive SIPA
    // alongside activation; subsequent recovery uses DepositSIPAs, never another update.
    const innerCalls = await this.receiveCalls(plan.day, plan.nonce)
    const payload = await buildClaimSubscribePayload({
      ...o.registered,
      innerCalls,
      gate: {
        kind: "registration",
        ...(await o.bindingWitness(nameHash)),
        secret: REGISTRATION_MESSAGE_SECRET,
        leafIndex: new Fr(message.leafIndex),
      },
    })
    await o.wallet.sendTx(payload, {
      from: NO_FROM,
      sendMessagesAs: o.registered.user,
      additionalScopes: [o.registered.user],
      fee: claimFpcSponsoredFee(o.registered.policy, innerCalls),
      onTxHash,
    })
  }

  private async receiveCalls(day: number, nonce: number): Promise<FunctionCall[]> {
    return migrationDepositCalls(
      this.deposits,
      await resolveMigrationDeposit(this.deposits, day, nonce),
    )
  }

  private async claim(raw: string): Promise<boolean> {
    const { plan, sipa, resolution } = await this.restore(raw)
    return receiveMigrationSweeps(
      this.deposits,
      sipa,
      BigInt(plan.fromBlock),
      resolution.messageSecret,
    )
  }

  async recoverRemaining(raw: string, published: boolean): Promise<void> {
    await this.restore(raw)
    if (!(await this.recurring())) throw new Error("Recurring sponsorship is not available")
    if (published && !(await this.claim(raw)))
      throw new Error("The first migration deposit is not available")
    await this.options.source.recoverRemaining()
  }
}
