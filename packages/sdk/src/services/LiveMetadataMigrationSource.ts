import { NO_FROM } from "@aztec/aztec.js/account"
import { EthAddress } from "@aztec/aztec.js/addresses"
import { TxHash, TxExecutionResult } from "@aztec/stdlib/tx"
import type { ViemClient } from "@aztec/ethereum/types"
import { OxidePortalContract } from "@oxide/l1-contracts"
import { plainWithdrawalExecutorAmount } from "@oxide/oxide-lib/plain_withdrawal.js"
import { TX_AMOUNT_CAP } from "@oxide/oxide-lib/oxide_constants.gen.js"
import { keccak256, toHex, type Address } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { MigrationFundingBatch, OxideEnvTuple } from "@obsidion/core/types"
import type { ObsidionAccount } from "../obsidion/alpha/account/ObsidionAccount.js"
import { readPortalWithdrawalState } from "../oxide/plainWithdrawal.js"
import type {
  MetadataMigrationSource,
  MetadataMigrationServiceOptions,
  MigrationSourceQuote,
} from "./MetadataMigrationService.js"
import type { TokenService } from "./TokenService.js"
import type { ClaimSponsorContext } from "./claimSponsor.js"
import { readDepositSIPAImplementation } from "./sipaIntents.js"
import { readQuotedDepositFee } from "./metadataMigration.js"
import { buildClaimSponsorPayload } from "../feePaymentMethod/claimSponsoredCall.js"
import { claimFpcSponsoredFee } from "../feePaymentMethod/claimFpcBatchGas.js"
import {
  migrationDepositCalls,
  migrationSipaCoordinates,
  receiveMigrationSweeps,
  resolveMigrationDeposit,
  type MigrationDestinationContext,
} from "./migrationDeposit.js"

export interface LiveMetadataMigrationSourceOptions
  extends Omit<MigrationDestinationContext, "node" | "recipient" | "recoveryAccount"> {
  wallet: MetadataMigrationServiceOptions["wallet"]
  account: ObsidionAccount
  /** The registered OxideAccount; it recovers every migration SIPA. */
  owner: Address
  source: { tuple: OxideEnvTuple; tokenService: TokenService }
  registered: MetadataMigrationServiceOptions["registered"]
  sourceSponsor(): Promise<ClaimSponsorContext>
  /** front-core owns persistence; the controller holds the account-scoped lock. */
  batches: {
    get(id: string): Promise<MigrationFundingBatch | undefined>
    set(id: string, batch: MigrationFundingBatch): Promise<void>
  }
}

/** Same-rollup live withdrawals. Frozen sources must use their own versioned proof adapter. */
export class LiveMetadataMigrationSource implements MetadataMigrationSource {
  readonly identity: string

  constructor(private readonly options: LiveMetadataMigrationSourceOptions) {
    const o = options
    this.identity = keccak256(
      toHex(
        JSON.stringify({
          sourcePortal: o.source.tuple.portal.toLowerCase(),
          sourceToken: o.source.tokenService.tokenAddress.toString(),
          account: o.account.getAddress().toString(),
          destinationPortal: o.destination.portal.toLowerCase(),
          destinationFactory: o.destination.factory.toLowerCase(),
          destinationRollup: String(o.destination.rollupVersion),
          recipient: o.registered.user.toString(),
        }),
      ),
    )
  }

  private get deposits(): MigrationDestinationContext {
    const o = this.options
    return { ...o, node: o.wallet.node, recipient: o.registered.user, recoveryAccount: o.owner }
  }

  private portal(address: string) {
    return new OxidePortalContract(this.options.client as unknown as ViemClient, address as Address)
  }

  private async validateRoute() {
    const o = this.options
    const source = this.portal(o.source.tuple.portal)
    const destination = this.portal(o.destination.portal)
    const [
      info,
      sourceToken,
      destinationToken,
      fromAsset,
      toAsset,
      sourceRollup,
      destinationRollup,
    ] = await Promise.all([
      o.wallet.node.getNodeInfo(),
      source.getL2Portal(),
      destination.getL2Portal(),
      source.getUnderlying(),
      destination.getUnderlying(),
      source.getRollup(),
      destination.getRollup(),
    ])
    if (
      BigInt(info.rollupVersion) !== o.destination.rollupVersion ||
      !sourceRollup.equals(destinationRollup) ||
      !destinationRollup.equals(info.l1ContractAddresses.rollupAddress) ||
      !sourceToken.equals(o.source.tokenService.tokenAddress) ||
      !destinationToken.equals(o.tokenService.tokenAddress)
    ) {
      throw new Error("The source or destination deployment no longer matches this migration")
    }
    // No conversion is implied by the metadata SIPA. Only use a route whose withdrawn asset
    // is the destination's underlying; other funding tokens need an explicit settlement quote.
    if (!fromAsset.equals(toAsset))
      throw new Error("Migration requires a quoted asset conversion route")
    if (await destination.isFrozen()) throw new Error("The destination portal is frozen")
    return source
  }

  async state(): Promise<"live" | "empty"> {
    const source = await this.validateRoute()
    if (await source.isFrozen())
      throw new Error("Use this source deployment's frozen refund adapter")
    return (await this.options.source.tokenService.getBalance(this.options.account)) > 0n
      ? "live"
      : "empty"
  }

  /**
   * The whole balance moves once the first batch nets `first` after its exit, the rule `prepare`
   * enforces: the batches after it never leave a remainder that can't pay its own way.
   */
  async quote({ first }: { first: bigint }): Promise<MigrationSourceQuote> {
    if ((await this.state()) !== "live") return { movable: 0n, stranded: 0n, waiting: 0n }
    const balance = await this.options.source.tokenService.getBalance(this.options.account)
    const movable = balance >= first + (await this.exitFee(balance)) ? balance : 0n
    return { movable, stranded: balance - movable, waiting: 0n }
  }

  /** What leaves a withdrawal of `amount` before it reaches its recipient. */
  private async exitFee(amount: bigint): Promise<bigint> {
    const o = this.options
    const { fpcFundingCut, frozen } = await readPortalWithdrawalState(
      o.client,
      o.source.tuple.portal as Address,
    )
    const executorAmount = plainWithdrawalExecutorAmount(amount, 0n, fpcFundingCut, frozen)
    return amount - executorAmount + WITHDRAW_RELAYER_TIP
  }

  private async ordinaryFee() {
    const { client, destination } = this.options
    return readQuotedDepositFee(
      client,
      destination.portal,
      await readDepositSIPAImplementation(client, destination.factory, destination.portal),
    )
  }

  private async read(id: string, recipient?: Address) {
    const batch = await this.options.batches.get(id)
    if (
      !batch ||
      batch.binding !== this.identity ||
      (recipient && batch.recipient.toLowerCase() !== recipient.toLowerCase()) ||
      BigInt(batch.amount) <= BigInt(batch.exitFee) ||
      BigInt(batch.exitFee) < 0n
    ) {
      throw new Error("Stored source batch does not match this migration")
    }
    return batch
  }

  async prepare(recipient: Address, minimumNetAmount: bigint) {
    const o = this.options
    if ((await this.state()) !== "live") throw new Error("No live source funds remain")
    const [balance, remainingFee] = await Promise.all([
      o.source.tokenService.getBalance(o.account),
      this.ordinaryFee(),
    ])
    // The same for every amount that covers the source cut, as any batch with a positive net does.
    const exitFee = await this.exitFee(balance)
    if (balance < minimumNetAmount + exitFee) {
      throw new Error(
        "Source funds do not cover the exit, the metadata fee, and a positive deposit",
      )
    }
    let amount = minimumNetAmount + exitFee
    // Avoid leaving a remainder which cannot cover its own exit and ordinary deposit.
    if (balance - amount <= remainingFee + exitFee) amount = balance
    const id = keccak256(toHex(`${this.identity}/${recipient.toLowerCase()}/${amount}/${exitFee}`))
    const existing = await o.batches.get(id)
    if (!existing)
      await o.batches.set(id, {
        binding: this.identity,
        recipient,
        amount: String(amount),
        exitFee: String(exitFee),
        fromBlock: String(await o.client.getBlockNumber()),
      })
    return { id, ...(await this.restore(id, recipient)) }
  }

  async restore(id: string, recipient: Address) {
    const batch = await this.read(id, recipient)
    await this.validateRoute()
    return { netAmount: BigInt(batch.amount) - BigInt(batch.exitFee) }
  }

  /** A saved hash is never burned again, even if the node no longer recognizes it. */
  async fund(id: string, recipient: Address, signal?: AbortSignal): Promise<void> {
    const o = this.options
    const batch = await this.read(id, recipient)
    if (batch.burnTx) {
      await this.requireIncluded(batch.burnTx, "Source withdrawal")
      return
    }
    if ((await this.state()) !== "live") throw new Error("Source funds are no longer available")
    if ((await this.exitFee(BigInt(batch.amount))) > BigInt(batch.exitFee)) {
      throw new Error("The source exit fee increased; the saved batch needs attention")
    }
    await o.source.tokenService.exitToL1PrivateSponsored(
      EthAddress.fromString(recipient),
      batch.amount,
      await o.sourceSponsor(),
      {
        userAccount: o.account,
        useRawAmount: true,
        withdrawal: {
          tuple: o.source.tuple,
          portal: await readPortalWithdrawalState(o.client, o.source.tuple.portal as Address),
        },
        onTxHash: async (hash) => {
          signal?.throwIfAborted()
          batch.burnTx = hash
          await o.batches.set(id, batch)
        },
      },
    )
  }

  private async requireIncluded(hash: string, label: string): Promise<void> {
    const receipt = await this.options.wallet.node.getTxReceipt(TxHash.fromString(hash))
    if (receipt.executionResult === TxExecutionResult.REVERTED)
      throw new Error(`${label} reverted; do not repeat its spend`)
    if (receipt.executionResult !== TxExecutionResult.SUCCESS)
      throw new Error(
        `${label} is awaiting confirmation; its saved transaction will not be sent again`,
      )
  }

  private resolve(batch: Pick<MigrationFundingBatch, "day" | "nonce">) {
    if (batch.day === undefined || batch.nonce === undefined)
      throw new Error("Remaining-funds derivation coordinates are missing")
    return resolveMigrationDeposit(this.deposits, batch.day, batch.nonce)
  }

  private async nextRemaining() {
    for (let index = 0; ; index++) {
      // Retain the original key so an already published batch survives this upgrade.
      const id = index === 0 ? "remaining" : `remaining-${index}`
      const batch = await this.options.batches.get(id)
      if (batch) await this.read(id)
      if (!batch?.received) return { id, batch }
    }
  }

  async recoverRemaining(signal?: AbortSignal): Promise<void> {
    const o = this.options
    const { id, batch: saved } = await this.nextRemaining()
    let batch = saved
    if (!batch) {
      if ((await this.state()) === "empty") return
      const [balance, fee] = await Promise.all([
        o.source.tokenService.getBalance(o.account),
        this.ordinaryFee(),
      ])
      const exitFee = await this.exitFee(balance)
      if (balance <= exitFee + fee)
        throw new Error("Remaining funds do not currently cover their exit and deposit fees")
      // One withdrawal is capped. Later batches take the rest, and each must cover its own fees.
      let amount = balance < TX_AMOUNT_CAP ? balance : TX_AMOUNT_CAP
      if (balance - amount > 0n && balance - amount <= exitFee + fee)
        amount = balance - exitFee - fee - 1n
      const coordinates = migrationSipaCoordinates()
      const resolved = await this.resolve(coordinates)
      batch = {
        binding: this.identity,
        recipient: resolved.sipaAddress,
        amount: String(amount),
        exitFee: String(exitFee),
        fromBlock: String(await o.client.getBlockNumber()),
        ...coordinates,
      }
      await o.batches.set(id, batch)
    }
    batch = await this.read(id)
    const resolved = await this.resolve(batch)
    if (resolved.sipaAddress.toLowerCase() !== batch.recipient.toLowerCase())
      throw new Error("Remaining-funds recipient changed")
    if (!batch.broadcastTx) {
      const innerCalls = await migrationDepositCalls(this.deposits, resolved)
      const payload = await buildClaimSponsorPayload({ ...o.registered, innerCalls })
      await o.wallet.sendTx(payload, {
        from: NO_FROM,
        sendMessagesAs: o.registered.user,
        additionalScopes: [o.registered.user],
        fee: claimFpcSponsoredFee(o.registered.policy, innerCalls),
        onTxHash: async (hash) => {
          signal?.throwIfAborted()
          batch!.broadcastTx = hash
          await o.batches.set(id, batch!)
        },
      })
      return
    }
    await this.requireIncluded(batch.broadcastTx, "Remaining-funds broadcast")
    if (!batch.burnTx) {
      await this.fund(id, resolved.sipaAddress, signal)
      return
    }
    if (
      await receiveMigrationSweeps(
        this.deposits,
        resolved.sipaAddress,
        BigInt(batch.fromBlock),
        resolved.resolution.messageSecret,
      )
    )
      await o.batches.set(id, { ...batch, received: true })
  }

  async remainingComplete(): Promise<boolean> {
    if ((await this.nextRemaining()).batch) return false
    return (await this.state()) === "empty"
  }
}
