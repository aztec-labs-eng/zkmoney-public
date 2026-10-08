// TODO(benesjan): Why do we have this package as a whole as opposed to just having auto-generated types? Is it to
// not depend on auto-gen or is it just slop?
import { CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { Buffer32 } from '@aztec/foundation/buffer';
import { Fr } from '@aztec/foundation/curves/bn254';
import { memoize } from '@aztec/foundation/decorators';
import { EthAddress } from '@aztec/foundation/eth-address';
import { Signature } from '@aztec/foundation/eth-signature';
import { AztecAddress } from '@aztec/stdlib/aztec-address';

import {
  type Account,
  type Chain,
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
  encodeFunctionData,
  getContract,
} from 'viem';

import { CertManagerAbi } from './abis/CertManager.js';
import { NitroValidatorAbi } from './abis/NitroValidator.js';
import { OxidePortalAbi } from './artifacts.js';
import { OxidePortalEventsAbi } from './events.js';
import { type ContractWriteResult, type WriteOptions, maybeWaitForReceipt } from './write_receipt.js';

/**
 * `OxidePortal.withdraw` calldata with a zeroed argument, which is what a withdrawal broadcast carries: the wallet
 * cannot know the withdrawal's fields (`randomness` is drawn in the circuit, and the witness needs the Outbox), so
 * the relayer rebuilds the call in full once the burn's message is consumable. The broadcast pins the target and the
 * selector; everything else comes from the burn tx the relayer proves.
 */
export function encodeWithdrawalBroadcast(): Hex {
  return encodeFunctionData({
    abi: OxidePortalAbi,
    functionName: 'withdraw',
    args: [
      {
        content: {
          executor: EthAddress.ZERO.toString(),
          userPayloadHash: `0x${'00'.repeat(32)}`,
          amount: 0n,
          proverTip: 0n,
          randomness: 0n,
        },
        userPayload: '0x',
        relayerPayload: '0x',
        epochNumber: 0n,
        numCheckpointsInEpoch: 0n,
        leafIndex: 0n,
        path: [],
        checkpointNumber: 0n,
        withdrawalId: `0x${'00'.repeat(32)}`,
        teeSignature: '0x',
      },
    ],
  });
}

export interface TEEKeys {
  pubKeyX: Buffer32;
  pubKeyY: Buffer32;
  encPubKeyX: Buffer32;
  encPubKeyY: Buffer32;
}

export interface TEEBinding {
  pcr0Hash: Buffer32;
  keys: TEEKeys;
}

export interface TEEAddedEvent {
  tee: EthAddress;
  pubKeyX: Buffer32;
  pubKeyY: Buffer32;
  encPubKeyX: Buffer32;
  encPubKeyY: Buffer32;
  messageKey: Fr;
  leafIndex: bigint;
}

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
   *  covering the burn; independent of the proof's own (burn) checkpointNumber. */
  checkpointNumber: CheckpointNumber;
  withdrawalId: Buffer32;
  teeSignature: Signature;
}

export interface FirstProverRecordedEvent {
  checkpointNumber: CheckpointNumber;
  prover: EthAddress;
  l1BlockNumber: bigint;
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
  private certManager?: GetContractReturnType<typeof CertManagerAbi, OxidePortalContract['client']>;
  private nitroValidator?: GetContractReturnType<typeof NitroValidatorAbi, OxidePortalContract['client']>;

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
  async getOwner(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.owner());
  }
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
  async getCertManager(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.TEE_CERT_MANAGER());
  }
  @memoize
  async getNitroValidator(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.TEE_NITRO_VALIDATOR());
  }
  @memoize
  getRollupVersion(): Promise<bigint> {
    return this.portal.read.ROLLUP_VERSION();
  }
  @memoize
  async getFpcFunder(): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.FPC_FUNDER());
  }
  @memoize
  getFpcFundingCut(): Promise<bigint> {
    return this.portal.read.FPC_FUNDING_CUT();
  }

  getChainId(): bigint {
    if (!this.client.chain) {
      throw new Error('OxidePortalContract: viem client has no `chain` configured');
    }
    return BigInt(this.client.chain.id);
  }

  @memoize
  getAttestationMaxAge(): Promise<bigint> {
    return this.portal.read.TEE_ATTESTATION_MAX_AGE();
  }

  // ─── current state ─────────────────────────────────────────────────────────────────────────

  isInitialized(): Promise<boolean> {
    return this.portal.read.$initialized();
  }
  isFrozen(): Promise<boolean> {
    return this.portal.read.$frozen();
  }
  async getL2Portal(): Promise<AztecAddress> {
    return AztecAddress.fromStringUnsafe(await this.portal.read.$l2Portal());
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

  async firstProver(
    checkpointNumber: CheckpointNumber,
    options: { blockNumber?: bigint; strict?: boolean } = {},
  ): Promise<EthAddress> {
    return EthAddress.fromString(await this.portal.read.$firstProver([BigInt(checkpointNumber)], options));
  }

  async claimed(epoch: EpochNumber, leafId: bigint): Promise<boolean> {
    return await this.portal.read.$claimed([BigInt(epoch), leafId]);
  }

  async getFirstProverRecordedEvents({
    prover,
    checkpointNumber,
    fromBlock,
    toBlock,
  }: {
    prover?: EthAddress;
    checkpointNumber?: CheckpointNumber;
    fromBlock?: bigint;
    toBlock?: bigint;
  } = {}): Promise<FirstProverRecordedEvent[]> {
    const logs = await this.portal.getEvents.FirstProverRecorded(
      {
        ...(prover ? { prover: prover.toString() } : {}),
        ...(checkpointNumber !== undefined ? { checkpointNumber: BigInt(checkpointNumber) } : {}),
      },
      { fromBlock: fromBlock ?? 'earliest', toBlock: toBlock ?? 'latest', strict: true },
    );
    return logs.map(log => ({
      checkpointNumber: CheckpointNumber.fromBigInt(log.args.checkpointNumber!),
      prover: EthAddress.fromString(log.args.prover!),
      l1BlockNumber: log.blockNumber,
    }));
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

  // ─── TEE bindings ──────────────────────────────────────────────────────────────────────────

  async getTeeBinding(tee: EthAddress): Promise<TEEBinding> {
    const [pcr0Hash, keys] = await this.portal.read.$teeBindings([tee.toString()]);
    return {
      pcr0Hash: Buffer32.fromString(pcr0Hash),
      keys: {
        pubKeyX: Buffer32.fromString(keys.pubKeyX),
        pubKeyY: Buffer32.fromString(keys.pubKeyY),
        encPubKeyX: Buffer32.fromString(keys.encPubKeyX),
        encPubKeyY: Buffer32.fromString(keys.encPubKeyY),
      },
    };
  }

  isTeeActive(tee: EthAddress): Promise<boolean> {
    return this.portal.read.isTeeActive([tee.toString()]);
  }

  isPcr0Approved(pcr0Hash: Buffer32): Promise<boolean> {
    return this.portal.read.$approvedTeePcr0([pcr0Hash.toString() as Hex]);
  }

  async getTeeAddedEventOnChain(
    tee: EthAddress,
    opts: { fromBlock?: bigint; maxLookback?: bigint; window?: bigint } = {},
  ): Promise<TEEAddedEvent | undefined> {
    // Inclusive [lo, lo+window] spans window+1 blocks; 9 keeps that at the free-tier 10-block cap.
    const window = opts.window ?? 9n;
    const head = await this.client.getBlockNumber();

    const scan = async (lo: bigint, hi: bigint): Promise<TEEAddedEvent | undefined> => {
      const logs = await this.client.getContractEvents({
        address: this.address.toString(),
        abi: OxidePortalEventsAbi,
        eventName: 'TEEAdded',
        args: { tee: tee.toString() },
        fromBlock: lo,
        toBlock: hi,
      });
      for (let i = logs.length - 1; i >= 0; i--) {
        const decoded = OxidePortalContract.tryDecodeTeeAdded(logs[i] as unknown as Log);
        if (decoded) {
          return decoded;
        }
      }
      return undefined;
    };

    if (opts.fromBlock !== undefined) {
      for (let lo = opts.fromBlock; lo <= head; lo += window + 1n) {
        const hi = lo + window > head ? head : lo + window;
        const found = await scan(lo, hi);
        if (found) {
          return found;
        }
      }
      return undefined;
    }

    const maxLookback = opts.maxLookback ?? 5_000n;
    const floor = head > maxLookback ? head - maxLookback : 0n;
    let toBlock = head;
    while (toBlock >= floor) {
      const fromBlock = toBlock > floor + window ? toBlock - window : floor;
      const found = await scan(fromBlock, toBlock);
      if (found) {
        return found;
      }
      if (fromBlock === floor) {
        break;
      }
      toBlock = fromBlock - 1n;
    }
    return undefined;
  }

  // ─── replay guards ─────────────────────────────────────────────────────────────────────────

  isWithdrawalSpent(withdrawalId: Buffer32): Promise<boolean> {
    return this.portal.read.$isWithdrawalSpent([withdrawalId.toString() as Hex]);
  }
  isRefundNullifierSpent(nullifier: Fr): Promise<boolean> {
    return this.portal.read.$isRefundNullifierSpent([nullifier.toString()]);
  }

  // ─── writes ────────────────────────────────────────────────────────────────────────────────

  async initialize(l2Portal: Fr, options: WriteOptions = {}): Promise<ContractWriteResult> {
    return await this.writeToPortal(cw => cw.initialize([l2Portal.toString()]), options);
  }

  async approveTeePcr0(pcr0Hash: Buffer32, options: WriteOptions = {}): Promise<ContractWriteResult> {
    return await this.writeToPortal(cw => cw.approveTeePcr0([pcr0Hash.toString() as Hex]), options);
  }

  async freeze(options: WriteOptions = {}): Promise<ContractWriteResult> {
    return await this.writeToPortal(cw => cw.freeze(), options);
  }

  async renounceOwnership(options: WriteOptions = {}): Promise<ContractWriteResult> {
    return await this.writeToPortal(cw => cw.renounceOwnership(), options);
  }

  async verifyTeeCACert(
    cert: Buffer,
    parentCertHash: Buffer32,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      cw => cw.verifyTeeCACert([`0x${cert.toString('hex')}`, parentCertHash.toString() as Hex]),
      options,
    );
  }

  async verifyTeeClientCert(
    cert: Buffer,
    parentCertHash: Buffer32,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      cw => cw.verifyTeeClientCert([`0x${cert.toString('hex')}`, parentCertHash.toString() as Hex]),
      options,
    );
  }

  async verifyTeeAttestationHash(attestationTbs: Buffer, options: WriteOptions = {}): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      cw => cw.verifyTeeAttestationHash([`0x${attestationTbs.toString('hex')}`]),
      options,
    );
  }

  async verifyTeeAttestationSig(
    attestationTbsKeccak: Buffer32,
    signature: Buffer,
    leafCertHash: Buffer32,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      cw =>
        cw.verifyTeeAttestationSig([
          attestationTbsKeccak.toString() as Hex,
          `0x${signature.toString('hex')}`,
          leafCertHash.toString() as Hex,
        ]),
      options,
    );
  }

  /** Whether the cert manager already caches a verified entry for this cert (keyed by keccak256(cert)). */
  async isTeeCertStaged(certHash: Buffer32): Promise<boolean> {
    const cm = await this.certManagerContract();
    return (await cm.read.verified([certHash.toString() as Hex])) !== '0x';
  }

  async isTeeAttestationHashStaged(attestationTbsKeccak: Buffer32): Promise<boolean> {
    const nv = await this.nitroValidatorContract();
    return (await nv.read.attestationSha384([attestationTbsKeccak.toString() as Hex])) !== '0x';
  }

  async isTeeAttestationSigStaged(attestationTbsKeccak: Buffer32): Promise<boolean> {
    const nv = await this.nitroValidatorContract();
    return BigInt(await nv.read.verifiedAttestationLeaf([attestationTbsKeccak.toString() as Hex])) !== 0n;
  }

  private async certManagerContract(): Promise<
    GetContractReturnType<typeof CertManagerAbi, OxidePortalContract['client']>
  > {
    this.certManager ??= getContract({
      address: (await this.getCertManager()).toString(),
      abi: CertManagerAbi,
      client: this.client,
    });
    return this.certManager;
  }

  private async nitroValidatorContract(): Promise<
    GetContractReturnType<typeof NitroValidatorAbi, OxidePortalContract['client']>
  > {
    this.nitroValidator ??= getContract({
      address: (await this.getNitroValidator()).toString(),
      abi: NitroValidatorAbi,
      client: this.client,
    });
    return this.nitroValidator;
  }

  async registerTee(
    attestationTbs: Buffer,
    signature: Buffer,
    pubKeyX: Buffer32,
    pubKeyY: Buffer32,
    encPubKeyX: Buffer32,
    encPubKeyY: Buffer32,
    options: WriteOptions = {},
  ): Promise<
    {
      event: TEEAddedEvent | undefined;
    } & ContractWriteResult
  > {
    const base = await this.writeToPortal(
      cw =>
        cw.registerTee([
          `0x${attestationTbs.toString('hex')}`,
          `0x${signature.toString('hex')}`,
          pubKeyX.toString() as Hex,
          pubKeyY.toString() as Hex,
          encPubKeyX.toString() as Hex,
          encPubKeyY.toString() as Hex,
        ]),
      options,
    );
    const event = base.receipt ? OxidePortalContract.parseTeeAddedEvent(base.receipt, this.address) : undefined;
    return { ...base, event };
  }

  async deposit(
    recipientCommitment: Fr,
    amount: bigint,
    options: WriteOptions = {},
  ): Promise<{ event: DepositEvent | undefined } & ContractWriteResult> {
    // The inbox insertion cost jumps when the message rolls the in-progress subtree over. viem
    // sends with its raw pre-send estimate, so state drift between estimate and inclusion runs the
    // tx out of gas — pad the estimate by half.
    const args = [recipientCommitment.toString(), amount] as const;
    const contract = this.getWriteContract();
    const gas = ((await contract.estimateGas.deposit(args, { account: this.writeClient().account })) * 3n) / 2n;
    const base = await this.writeToPortal(cw => cw.deposit(args, { gas }), options);
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
      cw =>
        cw.withdraw([
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
        ]),
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
      cw =>
        cw.refundFrozenNotes([
          {
            ...encodeExecutorCall(executorCall),
            amount,
            nullifiers: nullifiers.map(n => n.toString()),
            proof: `0x${proof.toString('hex')}`,
            teeSignature: teeSignature.toString(),
          },
        ]),
      options,
    );
  }

  async refundFrozenDeposit(
    executorCall: ExecutorCall,
    amount: bigint,
    siloedNullifier: Fr,
    proof: Buffer,
    teeSignature: Signature,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      cw =>
        cw.refundFrozenDeposit([
          {
            ...encodeExecutorCall(executorCall),
            amount,
            siloedNullifier: siloedNullifier.toString(),
            proof: `0x${proof.toString('hex')}`,
            teeSignature: teeSignature.toString(),
          },
        ]),
      options,
    );
  }

  async refundUnprocessedDeposit(
    executorCall: ExecutorCall,
    amount: bigint,
    siloedNullifier: Fr,
    messageHash: Fr,
    messageLeafIndex: bigint,
    inboxSiblingPath: Fr[],
    proof: Buffer,
    teeSignature: Signature,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      cw =>
        cw.refundUnprocessedDeposit([
          {
            ...encodeExecutorCall(executorCall),
            amount,
            siloedNullifier: siloedNullifier.toString(),
            messageHash: messageHash.toString(),
            messageLeafIndex,
            inboxSiblingPath: inboxSiblingPath.map(s => s.toString() as Hex),
            proof: `0x${proof.toString('hex')}`,
            teeSignature: teeSignature.toString(),
          },
        ]),
      options,
    );
  }

  async claimProverTips(
    proverSubsidy: EthAddress,
    claims: ProverClaim[],
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return await this.writeToPortal(
      cw => cw.claimProverTips([proverSubsidy.toString(), claims.map(toProverTipClaim)]),
      options,
    );
  }

  // ─── event decoding ────────────────────────────────────────────────────────────────────────

  static parseTeeAddedEvent(
    receipt: Pick<TransactionReceipt, 'logs'>,
    portalAddress?: EthAddress,
  ): TEEAddedEvent | undefined {
    const wanted = portalAddress?.toString().toLowerCase();
    for (const log of receipt.logs) {
      if (wanted && log.address.toLowerCase() !== wanted) {
        continue;
      }
      const decoded = OxidePortalContract.tryDecodeTeeAdded(log);
      if (decoded) {
        return decoded;
      }
    }
    return undefined;
  }

  private static tryDecodeTeeAdded(log: Log): TEEAddedEvent | undefined {
    try {
      const decoded = decodeEventLog({
        abi: OxidePortalEventsAbi,
        eventName: 'TEEAdded',
        topics: log.topics,
        data: log.data,
      });
      return {
        tee: EthAddress.fromString(decoded.args.tee),
        pubKeyX: Buffer32.fromString(decoded.args.pubKeyX),
        pubKeyY: Buffer32.fromString(decoded.args.pubKeyY),
        encPubKeyX: Buffer32.fromString(decoded.args.encPubKeyX),
        encPubKeyY: Buffer32.fromString(decoded.args.encPubKeyY),
        messageKey: Fr.fromHexString(decoded.args.messageKey),
        leafIndex: decoded.args.index,
      };
    } catch {
      // Topic didn't match `TEEAdded` — fall through.
      return undefined;
    }
  }

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

  private async writeToPortal(
    func: (contractWrite: ReturnType<OxidePortalContract['getWriteContract']>['write']) => Promise<Hex>,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    const txHash = await func(this.getWriteContract().write);
    return maybeWaitForReceipt(this.writeClient(), txHash, options);
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
