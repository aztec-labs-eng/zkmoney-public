// A migration signed by `TEST_PASSKEY` (see `webauthn_vector.ts`), also pinned in
// `noir-projects/refund_lib/src/migration_signature.nr`.
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import type { WebAuthnAuth } from '../account_address.js';

export const TEST_EXECUTOR = EthAddress.fromString('0x000000000000000000000000000000000000e5ec');
export const TEST_USER_PAYLOAD_HASH = new Fr(0x9a71n);
export const TEST_REFUND_COMMITMENT = Fr.fromString(
  '0x21354e75606ac560d687b8845876dff5d07cb672259194c591dd252783382426',
);
export const TEST_WEBAUTHN: WebAuthnAuth = {
  authenticatorData: Buffer.from('06cc72c2e66ce5754ea5792ba3919b3e4935e7019a1723e25cabde1134efc6f90500000007', 'hex'),
  clientDataJSON: Buffer.from(
    '{"type":"webauthn.get","challenge":"ITVOdWBqxWDWh7iEWHbf9dB8tnIlkZTFkd0lJ4M4JCY","origin":"https://stub.passkey.test","crossOrigin":false}',
    'utf8',
  ),
  signature: Buffer.from(
    'e3b7f353c74cfd6d9fdfd552ce6b70088477a2240003843cea6c80c49e486e4342b70a9ed70f34f73577ae8afb307c2c053c4a500d8b4e5c8fe5ec56116aa94d',
    'hex',
  ),
};
