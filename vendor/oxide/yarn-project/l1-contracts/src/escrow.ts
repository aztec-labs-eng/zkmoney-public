// Address prediction and recovery encoding for `EscrowBase` and `EscrowFactoryBase`.
import {
  type Address,
  type Hex,
  type PublicClient,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  getCreate2Address,
  keccak256,
  pad,
  parseAbiItem,
  parseAbiParameters,
  size,
  toHex,
} from 'viem';

import { EscrowBaseAbi } from './artifacts.js';

const ESCROW_EXECUTED = parseAbiItem('event EscrowExecuted(address indexed escrow, address tipRecipient)');

/** A zero commitment opens to no account, so the funds the escrow cannot deliver would be stuck. */
export function assertRecoveryCommitment(recoveryCommitment: Hex): void {
  if (BigInt(recoveryCommitment) === 0n) {
    throw new Error('recoveryCommitment must be nonzero');
  }
}

/** The escrow address for `encodedArgs`, computed without RPC. */
export function predictEscrowAddressLocally(factory: Address, encodedArgs: Hex): Address {
  // the implementation is the factory's first self-deploy (nonce 1)
  const implementation = getContractAddress({ from: factory, nonce: 1n });
  const initCode = concatHex([
    '0x61',
    pad(toHex(size(encodedArgs) + 0x2d), { size: 2 }),
    '0x3d81600a3d39f3363d3d373d3d3d363d73',
    implementation,
    '0x5af43d82803e903d91602b57fd5bf3',
    encodedArgs,
  ]);
  return getCreate2Address({ from: factory, salt: pad('0x', { size: 32 }), bytecode: initCode });
}

/** The transaction that executed `escrow`. `toBlock` defaults to the latest block. */
export async function findEscrowExecutionTx(
  publicClient: PublicClient,
  factory: Address,
  escrow: Address,
  fromBlock: bigint,
  toBlock?: bigint,
): Promise<Hex | undefined> {
  const [log] = await publicClient.getLogs({
    address: factory,
    event: ESCROW_EXECUTED,
    args: { escrow },
    fromBlock,
    toBlock,
  });
  return log?.transactionHash;
}

interface EscrowRecoveryArgs {
  recoverySalt: Hex;
  account: Address;
  /**
   * ERC-1271 signature over `accountPersonalSignHash` of the recovery digest if the account has code, else the EOA's
   * `personal_sign` of the digest.
   */
  signature: Hex;
  target: Address;
  nonce: Hex;
  deadline: bigint;
}

export function escrowERC20RecoveryDigest(
  escrow: Address,
  chainId: bigint,
  target: Address,
  token: Address,
  nonce: Hex,
  deadline: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256, address, address, bytes32, uint256'), [
      escrow,
      chainId,
      target,
      token,
      nonce,
      deadline,
    ]),
  );
}

export function escrowETHRecoveryDigest(
  escrow: Address,
  chainId: bigint,
  target: Address,
  nonce: Hex,
  deadline: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256, address, bytes32, uint256'), [
      escrow,
      chainId,
      target,
      nonce,
      deadline,
    ]),
  );
}

export function encodeEscrowRecoverERC20(args: EscrowRecoveryArgs & { token: Address }): Hex {
  return encodeFunctionData({
    abi: EscrowBaseAbi,
    functionName: 'recoverERC20',
    args: [args.recoverySalt, args.account, args.signature, args.target, args.token, args.nonce, args.deadline],
  });
}

export function encodeEscrowRecoverETH(args: EscrowRecoveryArgs): Hex {
  return encodeFunctionData({
    abi: EscrowBaseAbi,
    functionName: 'recoverETH',
    args: [args.recoverySalt, args.account, args.signature, args.target, args.nonce, args.deadline],
  });
}
