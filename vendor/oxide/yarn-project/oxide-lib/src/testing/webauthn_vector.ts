// A WebAuthn assertion by `TEST_PASSKEY` over `TEST_CHALLENGE`, also pinned in `noir-projects/oxide_lib/src/webauthn.nr`
// and `deploy-lib/src/passkey_test_account/stub_passkey_signer.test.ts`.
import { Fr } from '@aztec-labs/aztec.js/fields';

import type { PasskeyPublicKey, WebAuthnAuth } from '../account_address.js';

export const TEST_PASSKEY: PasskeyPublicKey = {
  x: Buffer.from('d8cd12ea5c67f2f8a00c1124893edcfa6754c4d6cede6be13bdf2295c810a97f', 'hex'),
  y: Buffer.from('a5a89d2d2a360c0ca9a4d6c7c9ed4b28d3e199d6627f2e696d689c310a5b0f48', 'hex'),
};
export const TEST_CHALLENGE = Fr.fromString('0x18380a3a4dec4daa04fe30592fa1f43bce1fb7e07fbcf136954ce1d9ce76cf98');
export const TEST_ASSERTION: WebAuthnAuth = {
  authenticatorData: Buffer.from('06cc72c2e66ce5754ea5792ba3919b3e4935e7019a1723e25cabde1134efc6f90500000007', 'hex'),
  clientDataJSON: Buffer.from(
    '{"type":"webauthn.get","challenge":"GDgKOk3sTaoE_jBZL6H0O84ft-B_vPE2lUzh2c52z5g","origin":"https://stub.passkey.test","crossOrigin":false}',
    'utf8',
  ),
  signature: Buffer.from(
    'cc373c505a3e689a64d0548f0766e6f5f368d1570fe03819d818b9eeb077531a61e59a8c9c0c7e38cbee296f44df3be18dec796c3c0123edc9d1ee8992f003d9',
    'hex',
  ),
};
