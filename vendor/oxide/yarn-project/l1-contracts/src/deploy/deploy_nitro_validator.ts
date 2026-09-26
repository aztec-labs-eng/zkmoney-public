import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import { NitroValidatorAbi, NitroValidatorBytecode } from '../abis/NitroValidator.js';

/**
 * Deploys the production `NitroValidator` from the `nitro-validator` submodule, bound to a
 * pre-deployed `CertManager`. The portal hands `_attestationTbs` + `_signature` straight to this
 * validator's `validateAttestation` at every `registerTee` call.
 */
export async function deployNitroValidator(
  client: ExtendedViemWalletClient,
  certManager: EthAddress,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, NitroValidatorAbi, NitroValidatorBytecode, [
    certManager.toString(),
  ]);
  return address;
}
