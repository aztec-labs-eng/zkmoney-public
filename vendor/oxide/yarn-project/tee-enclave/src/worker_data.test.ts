import { sealRequest } from '@oxide/oxide-lib-tee/encryption.js';

import { describe, expect, it } from '@jest/globals';

import { EnclaveSession } from './rpc.js';
import { SignatureBudget } from './signature_budget.js';
import { createEnclaveKeyMaterial, fromWorkerData, toWorkerData } from './worker_data.js';

const STUB_ATTESTATION_PROVIDER = {
  attest: (userData: Buffer) => Promise.resolve(Buffer.concat([Buffer.from('stub-attestation:'), userData])),
};

describe('enclave key material worker round trip', () => {
  // `workerData` crosses thread boundaries via the structured clone algorithm; `structuredClone`
  // applies the same one, so this covers what workers actually receive.
  it('survives the workerData structured clone', async () => {
    const material = await createEnclaveKeyMaterial(STUB_ATTESTATION_PROVIDER);
    const { material: cloned } = fromWorkerData(structuredClone(toWorkerData(material, new SignatureBudget(10))));

    expect(cloned.signingKey.toString()).toBe(material.signingKey.toString());
    expect(cloned.attestation.attestation.equals(material.attestation.attestation)).toBe(true);
    expect(cloned.attestation.userData).toEqual(material.attestation.userData);
    expect(cloned.encryptionKeypair.publicKey).toEqual(material.encryptionKeypair.publicKey);
  });

  it('opens requests sealed to the original public key with the cloned CryptoKey, and seals readable responses', async () => {
    const material = await createEnclaveKeyMaterial(STUB_ATTESTATION_PROVIDER);
    const workerData = structuredClone(toWorkerData(material, new SignatureBudget(10)));
    const { material: cloned, budget } = fromWorkerData(workerData);
    const session = new EnclaveSession(cloned, budget);

    const sealed = await sealRequest(material.encryptionKeypair.publicKey, Buffer.from('ping'));
    const opened = await session.openEncryptedPayload(sealed.wirePayload, undefined);
    expect(opened.innerPlaintext.toString('utf8')).toBe('ping');

    const response = await opened.sealResponse(Buffer.from('pong'));
    expect((await sealed.openResponse(response)).toString('utf8')).toBe('pong');
  });
});
