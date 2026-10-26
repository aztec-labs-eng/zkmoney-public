import { EthAddress, type AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { WithdrawalOptions } from "@obsidion/sdk"
import { buildSkyEscrowWithdrawal } from "@oxide/experiments/sky/withdraw_escrow.js"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import type { Address, Hex } from "viem"
import { deriveSkyEscrowSalts, type FieldLike } from "../../../oxide/oxideAccountKeys"
import type { WithdrawalRecord } from "../bridge/types"
import {
  savingsSourceExecutor,
  tupleField,
  type SavingsDeployments,
  type SkyFactory,
} from "./savingsDeployment"
import { savingsRoute } from "./savingsMoveQuote"
import type { SavingsQuote } from "./types"

/** The Broadcaster bindings the escrow builder takes; the sdk registers one for an address. */
export type SkyBroadcaster = Parameters<typeof buildSkyEscrowWithdrawal>[0]["broadcaster"]

export interface SavingsMoveBuildDeps {
  broadcaster: SkyBroadcaster
  deployments: SavingsDeployments
  factory: SkyFactory
  masterSecret: FieldLike
  /** The account that claims the destination deposit. */
  recipient: AztecAddress
  /** The L1 account whose signature recovers the escrow: this wallet's OxideAccount. */
  recoveryAccount: Address
}

export interface SavingsMoveBuild {
  escrow: Address
  nonce: Hex
  recipientCommitment: Hex
  /** What the burn's sdk options carry, so the burn tx broadcasts the escrow's run. */
  escrowOptions: NonNullable<WithdrawalOptions["escrow"]>
  /** What the burn's record keeps, so a rescan rebuilds the move. */
  skyMove: NonNullable<WithdrawalRecord["skyMove"]>
}

/**
 * The burn into a counterfactual Sky escrow for a quoted move. The salts come from the master secret
 * and a fresh nonce, so a wallet restored from its secret can still claim or recover the move.
 */
export async function buildSavingsMove(
  deps: SavingsMoveBuildDeps,
  quote: SavingsQuote,
): Promise<SavingsMoveBuild> {
  const { main, savings } = deps.deployments
  const source = quote.direction === "in" ? main : savings
  const executor = savingsSourceExecutor(deps.deployments, quote.direction)
  const nonce = Fr.random().toString() as Hex
  const salts = deriveSkyEscrowSalts(deps.masterSecret, nonce)
  const recipientCommitment = (
    await computeRecipientCommitment(salts.recipient, deps.recipient)
  ).toString() as Hex
  const built = buildSkyEscrowWithdrawal({
    broadcaster: deps.broadcaster,
    skyEscrowFactory: EthAddress.fromString(deps.factory.address),
    dai: EthAddress.fromString(deps.factory.dai),
    from: deps.recipient,
    withdrawalExecutor: { address: EthAddress.fromString(executor), fee: quote.withdrawalFee },
    amount: quote.amount,
    withdrawalRelayerTip: quote.releaseTip,
    proverTip: 0n,
    portal: EthAddress.fromString(tupleField(source, "portal")),
    route: savingsRoute(quote.direction),
    recipientCommitment,
    recoveryAccount: EthAddress.fromString(deps.recoveryAccount),
    relayerTip: quote.escrowTip,
    nonce,
    recoverySalt: salts.recovery,
  })
  if (built.operation.kind !== "withdraw") throw new Error("The Sky escrow built no withdrawal")
  return {
    escrow: built.escrow.toString() as Address,
    nonce,
    recipientCommitment,
    escrowOptions: {
      escrow: built.escrow,
      userPayload: built.operation.userPayload,
      l1Operation: built.l1Operation,
      // Main's relayer runs every Sky escrow, either way: it watches the DAI each escrow waits for.
      broadcaster: tupleField(main, "l2Broadcaster"),
      sky: { ...built.escrowArgs, factory: deps.factory.address },
      executor,
      withdrawalFee: quote.withdrawalFee,
    },
    skyMove: {
      direction: quote.direction,
      factory: deps.factory.address,
      recipientCommitment,
      recoveryCommitment: built.escrowArgs.recoveryCommitment,
      relayerTip: quote.escrowTip.toString(),
      nonce,
    },
  }
}
