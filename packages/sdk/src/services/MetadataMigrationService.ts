import { NO_FROM } from "@aztec/aztec.js/account"
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
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
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  prepareMetadataUpdate,
  assertMetadataUpdateFresh,
  readMetadataDestinationState,
  readMetadataUpdateFee,
  readOrdinaryDepositFee,
  StalePlanError,
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
import {
  migrationDepositCalls,
  migrationSipaCoordinates,
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
   * `onSelected` receives the batch id once its selection is saved, before anything is signed.
   */
  prepare(
    recipient: Address,
    minimumNetAmount: bigint,
    onSelected?: (id: string) => Promise<void>,
    /** What the batch's deposit pays on the destination, recorded with it. */
    depositFee?: bigint,
  ): Promise<{
    id: string
    netAmount: bigint
    operation?: BroadcastL1Operation
    /** False for a batch whose proof asks the user nothing. */
    asksApproval?: boolean
  }>
  /** Rebuild from source data and verify the selected batch still pays the specified SIPA. */
  restore(
    id: string,
    recipient: Address,
  ): Promise<{ netAmount: bigint; operation?: BroadcastL1Operation; asksApproval?: boolean }>
  /**
   * Live burn only. Must durably record its tx before RPC and reconcile it on retries. A cancelled
   * `signal` stops it before recording a new hash.
   */
  fund(id: string, recipient: Address, signal?: AbortSignal): Promise<void>
  /** Existing source recovery adapter, restricted to ordinary DepositSIPAs after bootstrap. */
  recoverRemaining(signal?: AbortSignal): Promise<void>
  /**
   * Plan and prove every later batch inside the user's action, so recovery only sends. A source
   * without it plans each batch during recovery.
   */
  prepareRemaining?(
    minimumNetAmount: bigint,
    opts: {
      /** What each batch's deposit pays on the destination, recorded with it. */
      depositFee?: bigint
      exclude?: string
      reserved?: { day: number; nonce: number }[]
      signal?: AbortSignal
      onApproval?: (approved: number, total: number) => Promise<void>
    },
  ): Promise<void>
  /** Whether every planned later batch has been sent. */
  remainingSent?(): Promise<boolean>
  /** Bring every sent batch up to date from chain evidence, never signing or sending. */
  reconcileRemaining?(): Promise<void>
  remainingComplete(): Promise<boolean>
  /**
   * What a run moves from here now, by the rule each batch applies: the first must net at least
   * `first` after the source's exit, each later one at least `later`.
   */
  quote?(minimums: { first: bigint; later: bigint }): Promise<MigrationSourceQuote>
  /** Everything the source holds for the account. */
  holdings?(): Promise<bigint>
}

/** Funds still on the source, read from chain. A refund counts until it executes on L1. */
export interface MigrationSourceQuote {
  /** What a run moves now. */
  movable: bigint
  /** What no batch can afford. */
  stranded: bigint
  /** What the source can't refund yet. */
  waiting: bigint
  /** How many refund batches move it. */
  batches?: number
  /**
   * Approvals a run asks for: the consent until the first refund settles, and one per batch that
   * asks one. A source's own quote counts only its batches.
   */
  approvals?: number
  /** What the batches pay: each one's relayer tip and its deposit's fee. */
  fees?: bigint
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
  /** Whether the consent asks a passkey, so a run's approvals count it. */
  consentPrompts?(): Promise<boolean>
  /** Scan bound captured before publication, persisted with the signed plan. */
  fromBlock?: bigint
  /** Whether a balance read begun now is stored. Absent: an import is enough. */
  confirmBalance?(): Promise<boolean>
  /** A funding address is shown for the first time: seed it on the rail, as a registration address is. */
  seedFunding?(sipa: Address, resolution: { messageSecret: Fr; recipientHash: Fr }): Promise<void>
}

/** What a preparation saves before it signs, so resuming it asks for the same approvals. */
interface Draft {
  day: number
  nonce: number
  sourceBatch?: string
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

  /** What funding the update takes, before any plan: its sweep's fee and the least it sweeps. */
  async fundingTerms() {
    const o = this.options
    const token = o.destination.token
    const [fee, decimals, symbol] = await Promise.all([
      readMetadataUpdateFee(o.client, o.destination),
      o.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      o.client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    ])
    return { fee, minimumAmount: fee + 1n, token, decimals, symbol }
  }

  async funding(raw: string) {
    const { sipa, plan, resolution } = await this.restore(raw)
    await this.options.seedFunding?.(sipa, resolution)
    return {
      address: sipa,
      ...(await this.fundingTerms()),
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

  /**
   * Prepare from `draft` when one was saved, else from new coordinates. `saveDraft` persists each step
   * before the approval that follows it; `signal` stops before each approval and before returning.
   */
  async prepare(
    draft?: string,
    saveDraft?: (draft: string) => Promise<void>,
    signal?: AbortSignal,
    onApproval?: (approved: number, total: number) => Promise<void>,
  ): Promise<string> {
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
    const saved: Draft = draft ? (JSON.parse(draft) as Draft) : migrationSipaCoordinates()
    const { day, nonce } = saved
    if (!draft) await saveDraft?.(JSON.stringify(saved))
    const resolution = await this.resolve(day, nonce)
    const sourceState = await o.source.state()
    // A current destination record publishes no bootstrap, so its refund would never be broadcast.
    const first = await this.firstBatch(async () => sourceState)
    // The consent, then each batch's approval, counted up front for the run's screen.
    const consent = await this.consentApprovals()
    const total = consent + (sourceState === "frozen" ? await this.batchApprovals(first) : 0)
    await onApproval?.(0, total)
    signal?.throwIfAborted()
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
    await onApproval?.(consent, total)
    const batch =
      sourceState === "empty" || first.skipped
        ? undefined
        : await this.firstSourceBatch(saved, metadata.sipa, first, saveDraft, signal)
    const before = consent + (batch && batch.asksApproval !== false ? 1 : 0)
    if (batch) await onApproval?.(before, total)
    signal?.throwIfAborted()
    if (sourceState === "frozen")
      await this.prepareLater(
        { day, nonce, sourceBatch: batch?.id },
        signal,
        onApproval && ((approved, of) => onApproval(before + approved, before + of)),
      )
    signal?.throwIfAborted()
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

  /** The consent counts as an approval when it asks a passkey. */
  private async consentApprovals(): Promise<number> {
    return (await this.options.consentPrompts?.()) === false ? 0 : 1
  }

  /** How many approvals a frozen source's batches ask now, by the rules preparing applies. */
  private async batchApprovals(first: { minimum: bigint; skipped: boolean }): Promise<number> {
    const o = this.options
    if (!o.source.quote) return 0
    const later = (await readOrdinaryDepositFee(o.client, o.destination)) + 1n
    const quote = await o.source.quote({ first: first.skipped ? later : first.minimum, later })
    return quote.approvals ?? quote.batches ?? 0
  }

  /** The draft's batch when it still pays this SIPA, else a new selection saved before its approval. */
  private async firstSourceBatch(
    draft: Draft,
    sipa: Address,
    first: { fee: bigint; minimum: bigint },
    saveDraft: ((draft: string) => Promise<void>) | undefined,
    signal: AbortSignal | undefined,
  ) {
    const o = this.options
    signal?.throwIfAborted()
    if (draft.sourceBatch) {
      try {
        return { id: draft.sourceBatch, ...(await o.source.restore(draft.sourceBatch, sipa)) }
      } catch (error) {
        if (!(error instanceof StalePlanError)) throw error
      }
    }
    return o.source.prepare(
      sipa,
      first.minimum,
      async (id) => {
        await saveDraft?.(JSON.stringify({ ...draft, sourceBatch: id } satisfies Draft))
        signal?.throwIfAborted()
      },
      first.fee,
    )
  }

  /** Plan and prove every later batch, beside the first batch and the plan's own coordinates. */
  private async prepareLater(
    plan: Pick<Plan, "day" | "nonce" | "sourceBatch">,
    signal?: AbortSignal,
    onApproval?: (approved: number, total: number) => Promise<void>,
  ) {
    const o = this.options
    if (!o.source.prepareRemaining) return
    const depositFee = await readOrdinaryDepositFee(o.client, o.destination)
    await o.source.prepareRemaining(depositFee + 1n, {
      depositFee,
      exclude: plan.sourceBatch,
      reserved: [{ day: plan.day, nonce: plan.nonce }],
      signal,
      onApproval,
    })
  }

  /**
   * The user's own step before anything else is sent: rebuild from saved approvals what the next
   * publication needs, approve any planned batch whose approval is missing, and plan and prove funds
   * that reached the source since. A cancel during it sends nothing.
   */
  async ready(
    raw: string,
    signal?: AbortSignal,
    published = false,
    onApproval?: (approved: number, total: number) => Promise<void>,
  ): Promise<void> {
    const o = this.options
    const plan = JSON.parse(raw) as Plan
    if (!published && plan.sourceBatch && this.prepared?.plan !== raw) {
      const { resolution, metadata, sipa } = await this.restore(raw, true)
      signal?.throwIfAborted()
      const batch = await o.source.restore(plan.sourceBatch, sipa)
      signal?.throwIfAborted()
      this.prepared = {
        plan: raw,
        batch: await this.bootstrap(metadata!, resolution.messageSecret, batch.operation),
      }
    }
    signal?.throwIfAborted()
    // The plan's state is a snapshot: a source empty at preparation can hold refundable funds now.
    await this.prepareLater(plan, signal, onApproval)
  }

  private async restore(raw: string, verifyConsent = false) {
    const o = this.options
    const plan = JSON.parse(raw) as Plan
    if (plan.binding !== (await this.binding()))
      throw new Error("Migration account or deployment changed")
    const resolution = await this.resolve(plan.day, plan.nonce)
    const intent = decodeMetadataUpdateIntentData(plan.intentData)
    const signature = decodeMetadataUpdateProofs(plan.proofs)
    // The consent commits to the state it was signed over; checked first, since the account rejects
    // the old signature once that state moves.
    if (
      verifyConsent &&
      (await readMetadataDestinationState(o.client, o.destination, o.owner)).toLowerCase() !==
        intent.expectedStateHash.toLowerCase()
    ) {
      throw new StalePlanError("Metadata state changed; prepare migration again")
    }
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
      throw new StalePlanError("Stored migration intent does not match the destination")
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
        throw new StalePlanError("Metadata state changed; prepare migration again")
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
    return { skipped, fee, minimum: fee + 1n }
  }

  /**
   * What a run moves from the source now, by the rules `prepare` and recovery apply. Once the saved
   * run's first refund has settled (`firstBatchSettled`), the rest pays only ordinary deposit fees.
   */
  async quote(opts: { firstBatchSettled?: boolean } = {}): Promise<MigrationSourceQuote> {
    const o = this.options
    if (!o.source.quote) throw new Error("This migration source cannot quote its funds")
    const ordinary = await readOrdinaryDepositFee(o.client, o.destination)
    const later = ordinary + 1n
    const first = opts.firstBatchSettled
      ? later
      : (await this.firstBatch(() => o.source.state())).minimum
    const quote = await o.source.quote({ first, later })
    if (quote.batches === undefined) return quote
    const batches = BigInt(quote.batches)
    return {
      ...quote,
      approvals:
        (quote.approvals ?? quote.batches) +
        (opts.firstBatchSettled ? 0 : await this.consentApprovals()),
      // The first deposit pays the fee its minimum covers; every later one the ordinary fee.
      fees: batches && batches * WITHDRAW_RELAYER_TIP + first - 1n + (batches - 1n) * ordinary,
    }
  }

  async movable(): Promise<boolean> {
    return (await this.quote()).movable > 0n
  }

  /** What the source holds for the account, or undefined when it can't say. */
  async holdings(): Promise<bigint | undefined> {
    return this.options.source.holdings?.()
  }

  /** Whether the balance holds everything the run imported, so the run may be done. */
  async confirmBalance(): Promise<boolean> {
    return (await this.options.confirmBalance?.()) ?? true
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

  async broadcast(
    raw: string,
    onTxHash: (txHash: string) => Promise<void>,
    operationId?: string,
  ): Promise<void> {
    const o = this.options
    const { plan, resolution, metadata, sipa } = await this.restore(raw, true)
    if ((await o.source.state()) !== plan.sourceState)
      throw new StalePlanError("Source state changed; prepare migration again")
    if (plan.sourceState === "frozen" && !plan.sourceBatch)
      throw new StalePlanError("Destination metadata changed; prepare migration again")
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
      operationId,
      onTxHash: async (hash) => {
        await assertMetadataUpdateFresh(o.client, metadata!)
        await onTxHash(hash)
      },
    })
  }

  async fund(raw: string, signal?: AbortSignal): Promise<void> {
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
      await this.options.source.fund(plan.sourceBatch, sipa, signal)
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
    const depositReceived = await o.received(sipa)
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
        depositReceived &&
        (message?.status === "consumable" || recurringSponsorship),
      recurringSponsorship,
      swept: await o.swept(sipa),
      sent: (await o.source.remainingSent?.()) ?? false,
      // The rail's claim of every sweep establishes the receipt. A destination record that was
      // already current published no bootstrap, so no first deposit.
      complete:
        metadataSettled &&
        recurringSponsorship &&
        (!record.bootstrapTx || depositReceived) &&
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

  async subscribe(
    raw: string,
    onTxHash: (txHash: string) => Promise<void>,
    operationId?: string,
  ): Promise<void> {
    const o = this.options
    const { plan } = await this.restore(raw)
    if (
      (await readMetadataDestinationState(o.client, o.destination, o.owner)) !==
      userRecordStateHash(o.record)
    ) {
      throw new Error("Destination metadata changed before sponsorship activation")
    }
    if (!(await this.received(raw))) throw new Error("The migration deposit is not available yet")
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
      operationId,
      onTxHash,
    })
  }

  private async receiveCalls(day: number, nonce: number): Promise<FunctionCall[]> {
    return migrationDepositCalls(
      this.deposits,
      await resolveMigrationDeposit(this.deposits, day, nonce),
    )
  }

  private async received(raw: string): Promise<boolean> {
    const { sipa } = await this.restore(raw)
    return this.options.received(sipa)
  }

  async reconcileRemaining(raw: string): Promise<void> {
    await this.restore(raw)
    await this.options.source.reconcileRemaining?.()
  }

  async recoverRemaining(raw: string, published: boolean, signal?: AbortSignal): Promise<void> {
    await this.restore(raw)
    if (!(await this.recurring())) throw new Error("Recurring sponsorship is not available")
    if (published && !(await this.received(raw)))
      throw new Error("The first migration deposit is not available")
    await this.options.source.recoverRemaining(signal)
  }
}
