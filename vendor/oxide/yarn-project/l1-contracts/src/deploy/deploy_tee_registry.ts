import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import type { Buffer32 } from '@aztec-labs/foundation/buffer';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import { TEE_REGISTRY_L2_RECIPIENT } from '@oxide/oxide-lib/oxide_constants.gen.js';

import { TeeRegistryAbi, TeeRegistryBytecode } from '../artifacts.js';
import { TeeRegistryContract } from '../tee_registry.js';

export interface DeployTeeRegistryArgs {
  /** `keccak256(PCR0)`. */
  pcr0Hash: Buffer32;
  certManager: EthAddress;
  /** Must use `certManager`. */
  nitroValidator: EthAddress;
  /** The Aztec registry. */
  registry: EthAddress;
  rollupVersion: bigint;
}

export async function deployTeeRegistry(
  client: ExtendedViemWalletClient,
  args: DeployTeeRegistryArgs,
): Promise<TeeRegistryContract> {
  const { address } = await deployL1Contract(client, TeeRegistryAbi, TeeRegistryBytecode, [
    args.pcr0Hash.toString(),
    args.certManager.toString(),
    args.nitroValidator.toString(),
    args.registry.toString(),
    args.rollupVersion,
    new Fr(TEE_REGISTRY_L2_RECIPIENT).toString(),
  ]);
  return new TeeRegistryContract(client, address);
}
