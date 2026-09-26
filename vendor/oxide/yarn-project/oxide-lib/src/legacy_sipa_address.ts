import { Fr } from '@aztec/foundation/curves/bn254';
import type { EthAddress } from '@aztec/foundation/eth-address';

import { type SipaAddressInputs, computeSIPAAddress } from './sipa_address.js';

export function computeLegacySIPAAddress(
  inputs: Omit<SipaAddressInputs, 'recoveryCommitment'> & { recoveryAddress: EthAddress },
): EthAddress {
  return computeSIPAAddress({
    ...inputs,
    recoveryCommitment: Fr.fromBuffer(inputs.recoveryAddress.toBuffer32()),
  });
}
