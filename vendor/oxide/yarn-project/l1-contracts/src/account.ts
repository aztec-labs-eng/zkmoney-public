import {
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
  concatHex,
  domainSeparator,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  getCreate2Address,
  keccak256,
  pad,
  parseAbiParameters,
  size,
  toBytes,
  toHex,
} from 'viem';

import { OxideAccountAbi, OxideAccountFactoryAbi } from './artifacts.js';
import { type ContractWriteResult, type WriteOptions, maybeWaitForReceipt } from './write_receipt.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type R1PublicKeyArg = { qx: Hex; qy: Hex };
export type AuthKeyEntry = { key: R1PublicKeyArg; metadata: Hex };

/// A WebAuthn assertion as the account's `_rawSignatureValidation` expects to decode it.
export type WebAuthnAuthArg = {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};

/// A single call in an ERC-7821 batch.
export type Call = { target: Address; value: bigint; data: Hex };

/// ERC-7821 single-batch mode (CALLTYPE_BATCH, EXECTYPE_DEFAULT, no opData).
const EXECUTE_BATCH_MODE = pad('0x01', { size: 32, dir: 'right' });

// ---------------------------------------------------------------------------
// Factory: deterministic deployment from a bootstrap key
// ---------------------------------------------------------------------------

/// The deterministic account address for `bootstrap`, whether or not it is deployed.
export async function predictAccountAddress(
  publicClient: PublicClient,
  factory: Address,
  bootstrap: Address,
): Promise<Address> {
  return (await publicClient.readContract({
    address: factory,
    abi: OxideAccountFactoryAbi,
    functionName: 'predictAccountAddress',
    args: [bootstrap],
  } as any)) as Address;
}

/// {@link predictAccountAddress} computed off-chain.
export function predictAccountAddressLocally(factory: Address, bootstrap: Address): Address {
  const implementation = getContractAddress({ from: factory, nonce: 1n });
  const args = encodeAbiParameters([{ type: 'address' }], [bootstrap]);
  // Byte-for-byte port of OZ `Clones.sol::_cloneCodeWithImmutableArgs` (the init code the factory clones
  // with): 0x61 ++ uint16(args.length + 0x2d) ++ 3d81600a3d39f3363d3d373d3d3d363d73 ++ implementation ++
  // 5af43d82803e903d91602b57fd5bf3 ++ args.
  const initCode = concatHex([
    '0x61',
    pad(toHex(size(args) + 0x2d), { size: 2 }),
    '0x3d81600a3d39f3363d3d373d3d3d363d73',
    implementation,
    '0x5af43d82803e903d91602b57fd5bf3',
    args,
  ]);
  return getCreate2Address({ from: factory, salt: pad('0x', { size: 32 }), bytecode: initCode });
}

/// ERC-4337 `initCode` deploying the account for `bootstrap`: the factory address followed by the
/// `deploy(bootstrap)` calldata. A UserOp carrying it deploys the account during validation, so deployment
/// and the op's calls ride a single bundle.
export function encodeAccountInitCode(factory: Address, bootstrap: Address): Hex {
  return concatHex([
    factory,
    encodeFunctionData({ abi: OxideAccountFactoryAbi, functionName: 'deploy', args: [bootstrap] }),
  ]);
}

/// Deploys the account for `bootstrap`.
export async function deployAccount(
  walletClient: WalletClient,
  publicClient: PublicClient,
  factory: Address,
  bootstrap: Address,
  options: WriteOptions = {},
): Promise<{ account: Address } & ContractWriteResult> {
  const account = predictAccountAddressLocally(factory, bootstrap);
  const txHash = (await walletClient.writeContract({
    address: factory,
    abi: OxideAccountFactoryAbi,
    functionName: 'deploy',
    args: [bootstrap],
  } as any)) as Hex;
  return { account, ...(await maybeWaitForReceipt(publicClient, txHash, options)) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// The bootstrap key that signs UserOps until the first r1 key is registered.
export async function getBootstrapOwner(publicClient: PublicClient, account: Address): Promise<Address> {
  return (await publicClient.readContract({
    address: account,
    abi: OxideAccountAbi,
    functionName: 'bootstrapOwner',
  } as any)) as Address;
}

/// The full r1 key set, in storage order (the index of each key is its position here). Empty while the
/// bootstrap key still controls the account.
export async function getAuthKeys(publicClient: PublicClient, account: Address): Promise<AuthKeyEntry[]> {
  return (await publicClient.readContract({
    address: account,
    abi: OxideAccountAbi,
    functionName: 'getAuthKeys',
  } as any)) as AuthKeyEntry[];
}

/// The value stored under `key` in the account's KV store ('0x' if unset).
export async function getAccountData(publicClient: PublicClient, account: Address, key: Hex): Promise<Hex> {
  return (await publicClient.readContract({
    address: account,
    abi: OxideAccountAbi,
    functionName: 'getData',
    args: [key],
  } as any)) as Hex;
}

// ---------------------------------------------------------------------------
// ERC-1271
// ---------------------------------------------------------------------------

const PERSONAL_SIGN_TYPEHASH = keccak256(toBytes('PersonalSign(bytes prefixed)'));

/// The ERC-7739 PersonalSign digest the account validates through `isValidSignature(hash, signature)`: the
/// signer signs this, not `hash`.
export function accountPersonalSignHash(account: Address, chainId: number, hash: Hex): Hex {
  const separator = domainSeparator({
    domain: { name: 'OxideAccount', version: '1', chainId, verifyingContract: account },
  });
  const structHash = keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, bytes32'), [PERSONAL_SIGN_TYPEHASH, hash]),
  );
  return keccak256(concatHex(['0x1901', separator, structHash]));
}

// ---------------------------------------------------------------------------
// Account-side UserOp encoding
// ---------------------------------------------------------------------------

/// Produce a UserOp signature with an r1 key.
export function encodeR1UserOpSignature(keyIndex: bigint, auth: WebAuthnAuthArg): Hex {
  const encodedAuth = encodeAbiParameters(
    parseAbiParameters(
      'bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON',
    ),
    [auth.r, auth.s, auth.challengeIndex, auth.typeIndex, auth.authenticatorData, auth.clientDataJSON],
  );
  return concatHex([pad(toHex(keyIndex), { size: 32 }), encodedAuth]);
}

/// Produce a UserOp signature with the bootstrap key.
export function signK1UserOpHash(bootstrap: PrivateKeyAccount, userOpHash: Hex): Promise<Hex> {
  return bootstrap.sign({ hash: userOpHash });
}

/// Gas-estimation stand-in for a bootstrap-key signature
export const DUMMY_K1_SIGNATURE: Hex =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

/// Gas-estimation stand-in for an r1/WebAuthn signature by the key at `keyIndex`
export function dummyR1Signature(keyIndex: bigint): Hex {
  return encodeR1UserOpSignature(keyIndex, {
    r: `0x${'7a'.repeat(32)}`,
    s: `0x${'7a'.repeat(32)}`,
    challengeIndex: 23n,
    typeIndex: 1n,
    authenticatorData: concatHex([keccak256(toBytes('rpIdHash')), '0x05', '0x00000000']),
    clientDataJSON: `{"type":"webauthn.get","challenge":"${'A'.repeat(43)}"}`,
  });
}

/// Encodes `OxideAccount.execute(mode, executionData)` calldata for a batch of calls. This is the
/// UserOp `callData` that the EntryPoint invokes on the account; the calls then run as the account.
export function encodeExecuteBatch(calls: Call[]): Hex {
  const executionData = encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes data)[]'), [calls]);
  return encodeFunctionData({
    abi: OxideAccountAbi,
    functionName: 'execute',
    args: [EXECUTE_BATCH_MODE, executionData],
  });
}

/// Encodes `addAuthKey(key, metadata)` calldata
export function encodeAddAuthKey(key: R1PublicKeyArg, metadata: Hex): Hex {
  return encodeFunctionData({ abi: OxideAccountAbi, functionName: 'addAuthKey', args: [key, metadata] });
}

/// Encodes `setData(key, value)` calldata
export function encodeSetData(key: Hex, value: Hex): Hex {
  return encodeFunctionData({ abi: OxideAccountAbi, functionName: 'setData', args: [key, value] });
}
