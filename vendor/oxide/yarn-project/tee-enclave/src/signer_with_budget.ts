import type { Buffer32 } from '@aztec/foundation/buffer';
import type { EthAddress } from '@aztec/foundation/eth-address';
import type { Signature } from '@aztec/foundation/eth-signature';

import type { Secp256k1Signer } from './libsecp256k1_signer.js';
import type { SignatureBudget } from './signature_budget.js';

/** Signer that consumes one budget unit per signature. */
export class SignerWithBudget {
  constructor(
    private readonly signer: Secp256k1Signer,
    private readonly budget: SignatureBudget,
  ) {}

  get address(): EthAddress {
    return this.signer.address;
  }

  sign(message: Buffer32): Signature {
    this.budget.consume();
    return this.signer.sign(message);
  }
}
