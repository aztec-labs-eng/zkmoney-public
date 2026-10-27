// TODO(benesjan): Why do we have this package as a whole as opposed to just having auto-generated types? Is it to
// not depend on auto-gen or is it just slop?
import { CheckpointNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { memoize } from '@aztec-labs/foundation/decorators';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import type { PortalDomain } from '@oxide/oxide-lib/types.js';

import {
  type Account,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type GetContractReturnType,
  type Hex,
  type Log,
  type PublicActions,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
  type WatchContractEventReturnType,
  decodeEventLog,
  getContract,
} from 'viem';

import { OxidePortalAbi } from './artifacts.js';
import { OxidePortalEventsAbi } from './events.js';
import { type ContractWriteResult, type WriteOptions, writeWithGasLimit } from './write_receipt.js';

export interface FrozenEvent {
  checkpointNumber: CheckpointNumber;
  epochNumber: EpochNumber;
  archive: Fr;
  freezeCheckpointCount: bigint;
}

export interface DepositEvent {
  recipientCommitment: Fr;
  amount: bigint;
  messageKey: Fr;
  leafIndex: bigint;
}

export interface ProverClaim {
  claimArgs: ProverClaimArgs;
  epochNumber: EpochNumber;
  messageLeafIndex: bigint;
  path: Hex[];
  proofLength: bigint;
  checkpointNumber: CheckpointNumber;
}

export interface ProverClaimArgs {
  content: {
    executor: EthAddress;
    userPayloadHash: Fr;
    amount: bigint;
    proverTip: bigint;
    randomness: bigint;
  };
  /** Checkpoint whose archive root anchors the TEE finalization signature — any proven checkpoint
   *  covering the initiation; independent of the proof's own (initiation) checkpointNumber. */
  checkpointNumber: CheckpointNumber;
  withdrawalId: Buffer32;
  teeSignature: Signature;
}

/** TS Wrapper around OxidePortal.sol */
/** Executor the portal hands a verified refund to, plus the payloads it runs. */
export interface ExecutorCall {
  executor: EthAddress;
  userPayload: Buffer;
  relayerPayload: Buffer;
}

export function encodeExecutorCall(executorCall: ExecutorCall) {
  return {
    executor: executorCall.executor.toString() as Hex,
    userPayload: `0x${executorCall.userPayload.toString('hex')}` as Hex,
    relayerPayload: `0x${executorCall.relayerPayload.toString('hex')}` as Hex,
  };
}

export class OxidePortalContract {
  public readonly address: EthAddress;
  private readonly portal: GetContractReturnType<typeof OxidePortalAbi, OxidePortalContract['client']>;

  constructor(
    public readonly client: PublicClient | (WalletClient<Transport, Chain, Account> & PublicActions),
    address: Hex | EthAddress,
  ) {
    if (address instanceof EthAddress) {
      address = address.toString();
    }
    this.address = EthAddress.fromString(address);
    this.portal = getContract({ address, abi: OxidePortalAbi, client });
  }

  getContract(): GetContractReturnType<typeof OxidePortalAbi, OxidePortalContract['client']> {
    return this.portal;
  }

  getWriteContract(): GetContractReturnType<typeof OxidePortalAbi, WalletClient<Transport, Chain, Account>> {
    return getContract({ address: this.address.toString(), abi: OxidePortalAbi, client: this.writeClient() });
  }

  // ─── immutables / constants ────────────────────────────────────────────────────────────────

  @memoize
  async getUnderlying(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.UNDERLYING());
  }
  @memoize
  async getInbox(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.INBOX());
  }
  @memoize
  async getOutbox(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.OUTBOX());
  }
  @memoize
  async getRollup(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.ROLLUP());
  }
  @memoize
  async getRegistry(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.REGISTRY());
  }
  @memoize
  async getFrozenNotesRefundVerifier(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.FROZEN_NOTES_REFUND_VERIFIER());
  }
  @memoize
  getRollupVersion(): Promise<bigint> {
    return this.portal.read.ROLLUP_VERSION();
  }
  @memoize
  getTxAmountCap(): Promise<bigint> {
    return this.portal.read.TX_AMOUNT_CAP();
  }
  @memoize
  async getL2Token(): Promise<AztecAddress> {
    return AztecAddress.fromStringUnsafe(await this.portal.read.L2_TOKEN());
  }
  @memoize
  async getTeeRegistry(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.TEE_REGISTRY());
  }
  getChainId(): bigint {
    if (!this.client.chain) {
      throw new Error('OxidePortalContract: viem client has no `chain` configured');
    }
    return BigInt(this.client.chain.id);
  }

  // ─── current state ─────────────────────────────────────────────────────────────────────────

  isFrozen(): Promise<boolean> {
    return this.portal.read.$frozen();
  }

  async getPortalDomain(): Promise<PortalDomain> {
    const [l2Token, teeRegistry, rollupVersion] = await Promise.all([
      this.getL2Token(),
      this.getTeeRegistry(),
      this.getRollupVersion(),
    ]);
    return { l1Portal: this.address, l1ChainId: this.getChainId(), l2Token, teeRegistry, rollupVersion };
  }

  async getFreezeCheckpointNumber(): Promise<CheckpointNumber> {
    return CheckpointNumber.fromBigInt(await this.portal.read.$freezeCheckpointNumber());
  }
  async getFreezeEpochNumber(): Promise<EpochNumber> {
    return EpochNumber.fromBigInt(await this.portal.read.$freezeEpochNumber());
  }
  async getFreezeArchive(): Promise<Fr> {
    return Fr.fromHexString(await this.portal.read.$freezeArchive());
  }
  getFreezeCheckpointCount(): Promise<bigint> {
    return this.portal.read.$freezeCheckpointCount();
  }

  async claimed(epoch: EpochNumber, leafId: bigint): Promise<boolean> {
    return await this.portal.read.$claimed([BigInt(epoch), leafId]);
  }

  listenToFrozen(callback: (event: FrozenEvent) => unknown): WatchContractEventReturnType {
    return this.portal.watchEvent.Frozen(
      {},
      {
        onLogs: logs => {
          for (const log of logs) {
            const args = log.args;
            if (
              args.checkpointNumber !== undefined &&
              args.epochNumber !== undefined &&
              args.archive !== undefined &&
              args.freezeCheckpointCount !== undefined
            ) {
              callback({
                checkpointNumber: CheckpointNumber.fromBigInt(args.checkpointNumber),
                epochNumber: EpochNumber.fromBigInt(args.epochNumber),
                archive: Fr.fromHexString(args.archive),
                freezeCheckpointCount: args.freezeCheckpointCount,
              });
            }
          }
        },
      },
    );
  }

  // ─── replay guards ─────────────────────────────────────────────────────────────────────────

  isWithdrawalSpent(withdrawalId: Buffer32): Promise<boolean> {
    return this.portal.read.$isWithdrawalSpent([withdrawalId.toString() as Hex]);
  }
  isRefundNullifierSpent(nullifier: Fr): Promise<boolean> {
    return this.portal.read.$isRefundNullifierSpent([nullifier.toString()]);
  }

  // ─── writes ────────────────────────────────────────────────────────────────────────────────

  async freeze(options: WriteOptions = {}): Promise<ContractWriteResult> {
    return await this.writeToPortal('freeze', [], options);
  }

  async deposit(
    recipientCommitment: Fr,
    amount: bigint,
    options: WriteOptions = {},
  ): Promise<{ event: DepositEvent | undefined } & ContractWriteResult> {
    const base = await this.writeToPortal('deposit', [recipientCommitment.toString(), amount], options);
    const event = base.receipt ? OxidePortalContract.parseDepositEvent(base.receipt, this.address) : undefined;
    return { ...base, event };
  }

  async withdraw(
    executor: EthAddress,
    userPayloadHash: Fr,
    amount: bigint,
    proverTip: bigint,
    randomness: Fr,
    userPayload: Buffer,
    relayerPayload: Buffer,
    epochNumber: EpochNumber,
    numCheckpointsInEpoch: bigint,
    leafIndex: bigint,
    siblingPath: Fr[],
    checkpointNumber: CheckpointNumber,
    withdrawalId: Buffer32,
    teeSignature: Signature,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      'withdraw',
      [
        {
          content: {
            executor: executor.toString(),
            userPayloadHash: userPayloadHash.toString(),
            amount,
            proverTip,
            randomness: randomness.toBigInt(),
          },
          userPayload: `0x${userPayload.toString('hex')}`,
          relayerPayload: `0x${relayerPayload.toString('hex')}`,
          epochNumber: BigInt(epochNumber),
          numCheckpointsInEpoch,
          leafIndex,
          path: siblingPath.map(p => p.toString()),
          checkpointNumber: BigInt(checkpointNumber),
          withdrawalId: withdrawalId.toString(),
          teeSignature: teeSignature.toString(),
        },
      ],
      options,
    );
  }

  async refundFrozenNotes(
    executorCall: ExecutorCall,
    amount: bigint,
    nullifiers: Fr[],
    proof: Buffer,
    teeSignature: Signature,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      'refundFrozenNotes',
      [
        {
          ...encodeExecutorCall(executorCall),
          amount,
          nullifiers: nullifiers.map(n => n.toString()),
          proof: `0x${proof.toString('hex')}`,
          teeSignature: teeSignature.toString(),
        },
      ],
      options,
    );
  }

  async refundFrozenDeposits(
    executorCall: ExecutorCall,
    amount: bigint,
    nullifiers: Fr[],
    proof: Buffer,
    teeSignature: Signature,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      'refundFrozenDeposits',
      [
        {
          ...encodeExecutorCall(executorCall),
          amount,
          nullifiers: nullifiers.map(n => n.toString()),
          proof: `0x${proof.toString('hex')}`,
          teeSignature: teeSignature.toString(),
        },
      ],
      options,
    );
  }

  async refundUnprocessedDeposit(
    executorCall: ExecutorCall,
    amount: bigint,
    siloedNullifier: Fr,
    messageHash: Fr,
    messageLeafIndex: bigint,
    proof: Buffer,
    teeSignature: Signature,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      'refundUnprocessedDeposit',
      [
        {
          ...encodeExecutorCall(executorCall),
          amount,
          siloedNullifier: siloedNullifier.toString(),
          messageHash: messageHash.toString(),
          messageLeafIndex,
          proof: `0x${proof.toString('hex')}`,
          teeSignature: teeSignature.toString(),
        },
      ],
      options,
    );
  }

  async claimProverTips(
    proverSubsidy: EthAddress,
    claims: ProverClaim[],
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      'claimProverTips',
      [proverSubsidy.toString(), claims.map(toProverTipClaim)],
      options,
    );
  }

  // ─── event decoding ────────────────────────────────────────────────────────────────────────

  static parseDepositEvent(
    receipt: Pick<TransactionReceipt, 'logs'>,
    portalAddress?: EthAddress,
  ): DepositEvent | undefined {
    const wanted = portalAddress?.toString().toLowerCase();
    for (const log of receipt.logs) {
      if (wanted && log.address.toLowerCase() !== wanted) {
        continue;
      }
      const decoded = OxidePortalContract.tryDecodeDeposit(log);
      if (decoded) {
        return decoded;
      }
    }
    return undefined;
  }

  private static tryDecodeDeposit(log: Log): DepositEvent | undefined {
    try {
      const decoded = decodeEventLog({
        abi: OxidePortalEventsAbi,
        eventName: 'Deposit',
        topics: log.topics,
        data: log.data,
      });
      return {
        recipientCommitment: Fr.fromHexString(decoded.args.recipientCommitment),
        amount: decoded.args.amount,
        messageKey: Fr.fromHexString(decoded.args.key),
        leafIndex: decoded.args.index,
      };
    } catch {
      // Topic didn't match `Deposit` — fall through.
      return undefined;
    }
  }

  // ─── wallet plumbing ───────────────────────────────────────────────────────────────────────

  private writeClient() {
    if (!('writeContract' in this.client) || !this.client.account) {
      throw new Error('OxidePortalContract: this method requires a wallet client with an account');
    }
    return this.client;
  }

  private writeToPortal<functionName extends ContractFunctionName<typeof OxidePortalAbi, 'nonpayable'>>(
    functionName: functionName,
    args: ContractFunctionArgs<typeof OxidePortalAbi, 'nonpayable', functionName>,
    options: WriteOptions,
  ): Promise<ContractWriteResult> {
    return writeWithGasLimit(
      this.writeClient(),
      { address: this.address.toString(), abi: OxidePortalAbi, functionName, args },
      options,
    );
  }
}

function toProverClaimArgs(c: ProverClaimArgs) {
  return {
    content: {
      executor: c.content.executor.toString(),
      userPayloadHash: c.content.userPayloadHash.toString(),
      amount: c.content.amount,
      proverTip: c.content.proverTip,
      randomness: c.content.randomness,
    },
    checkpointNumber: BigInt(c.checkpointNumber),
    withdrawalId: c.withdrawalId.toString(),
    teeSignature: c.teeSignature.toString(),
  };
}

/** Convert a `ProverClaim` into the `{args, proof}` tuple `claimProverTips` expects on chain. */
export function toProverTipClaim(c: ProverClaim) {
  return {
    args: toProverClaimArgs(c.claimArgs),
    proof: {
      epochNumber: BigInt(c.epochNumber),
      messageLeafIndex: c.messageLeafIndex,
      path: c.path,
      proofLength: c.proofLength,
      checkpointNumber: BigInt(c.checkpointNumber),
    },
  };
}
