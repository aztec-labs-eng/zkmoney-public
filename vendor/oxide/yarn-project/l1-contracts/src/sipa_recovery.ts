import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters } from 'viem';

import { SIPAAbi } from './artifacts.js';

export interface SipaRecoveryArgs {
  sharedSecretSalt: Hex;
  account: Address;
  signature: Hex;
  target: Address;
  nonce: Hex;
}

export function sipaERC20RecoveryDigest(
  sipa: Address,
  chainId: bigint,
  target: Address,
  token: Address,
  nonce: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256, address, address, bytes32'), [
      sipa,
      chainId,
      target,
      token,
      nonce,
    ]),
  );
}

export function sipaETHRecoveryDigest(sipa: Address, chainId: bigint, target: Address, nonce: Hex): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256, address, bytes32'), [sipa, chainId, target, nonce]),
  );
}

export function encodeSipaRecoverERC20(args: SipaRecoveryArgs & { token: Address }): Hex {
  return encodeFunctionData({
    abi: SIPAAbi,
    functionName: 'recoverERC20',
    args: [args.sharedSecretSalt, args.account, args.signature, args.target, args.token, args.nonce],
  });
}

export function encodeSipaRecoverETH(args: SipaRecoveryArgs): Hex {
  return encodeFunctionData({
    abi: SIPAAbi,
    functionName: 'recoverETH',
    args: [args.sharedSecretSalt, args.account, args.signature, args.target, args.nonce],
  });
}
