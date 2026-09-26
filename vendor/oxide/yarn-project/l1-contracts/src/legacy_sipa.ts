import { type Address, type Hex, type PublicClient, encodeFunctionData, parseAbi } from 'viem';

const legacyFactoryAbi = parseAbi([
  'function deploySIPA(address implementation, bytes32 intentHash, address recoveryAddress, uint256 rollupVersion, bool resweepable) returns (address)',
  'function predictSIPA(address implementation, bytes32 intentHash, address recoveryAddress, uint256 rollupVersion, bool resweepable) view returns (address)',
]);
const legacySipaAbi = parseAbi([
  'function recoverERC20(bytes signature, address target, address token, bytes32 nonce)',
]);

export interface LegacySipaDeployArgs {
  implementation: Address;
  intentHash: Hex;
  recoveryAddress: Address;
  rollupVersion: bigint;
  resweepable: boolean;
}

export function encodeLegacySipaDeploy(args: LegacySipaDeployArgs): Hex {
  return encodeFunctionData({
    abi: legacyFactoryAbi,
    functionName: 'deploySIPA',
    args: [args.implementation, args.intentHash, args.recoveryAddress, args.rollupVersion, args.resweepable],
  });
}

export function predictLegacySIPA(
  client: PublicClient,
  factory: Address,
  args: LegacySipaDeployArgs,
): Promise<Address> {
  return client.readContract({
    address: factory,
    abi: legacyFactoryAbi,
    functionName: 'predictSIPA',
    args: [args.implementation, args.intentHash, args.recoveryAddress, args.rollupVersion, args.resweepable],
  });
}

export function encodeLegacySipaRecoverERC20(args: {
  signature: Hex;
  target: Address;
  token: Address;
  nonce: Hex;
}): Hex {
  return encodeFunctionData({
    abi: legacySipaAbi,
    functionName: 'recoverERC20',
    args: [args.signature, args.target, args.token, args.nonce],
  });
}
