import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { EthAddress } from '@aztec/stdlib/block';

import { sealRequest } from '@oxide/oxide-lib/encryption.js';
import type { PortalContext } from '@oxide/oxide-lib/types.js';

import { describe, expect, it } from '@jest/globals';

import { EnclaveSession } from './rpc.js';
import { SignatureBudget } from './signature_budget.js';
import { createEnclaveKeyMaterial, fromWorkerData, toWorkerData } from './worker_data.js';

const PORTAL_CONTEXT: PortalContext = {
  l1Portal: EthAddress.fromString('0x1111111111111111111111111111111111111111'),
  l1ChainId: 31337n,
  l2Portal: AztecAddress.fromStringUnsafe('0x0000000000000000000000000000000000000000000000000000000000001234'),
  rollupVersion: 1n,
};

const STUB_ATTESTATION_PROVIDER = {
  attest: (userData: Buffer) => Promise.resolve(Buffer.concat([Buffer.from('stub-attestation:'), userData])),
};

describe('enclave key material worker round trip', () => {
  // `workerData` crosses thread boundaries via the structured clone algorithm; `structuredClone`
  // applies the same one, so this covers what workers actually receive.
  it('survives the workerData structured clone', async () => {
    const material = await createEnclaveKeyMaterial(STUB_ATTESTATION_PROVIDER);
    const { material: cloned, portalContext } = fromWorkerData(
      structuredClone(toWorkerData(material, PORTAL_CONTEXT, new SignatureBudget(10))),
    );

    expect(cloned.signingKey.toString()).toBe(material.signingKey.toString());
    expect(cloned.attestation.attestation.equals(material.attestation.attestation)).toBe(true);
    expect(cloned.attestation.userData).toEqual(material.attestation.userData);
    expect(cloned.encryptionKeypair.publicKey).toEqual(material.encryptionKeypair.publicKey);
    expect(portalContext.l1Portal.toString()).toBe(PORTAL_CONTEXT.l1Portal.toString());
    expect(portalContext.l2Portal.toString()).toBe(PORTAL_CONTEXT.l2Portal.toString());
    expect(portalContext.l1ChainId).toBe(PORTAL_CONTEXT.l1ChainId);
    expect(portalContext.rollupVersion).toBe(PORTAL_CONTEXT.rollupVersion);
  });

  it('opens requests sealed to the original public key with the cloned CryptoKey, and seals readable responses', async () => {
    const material = await createEnclaveKeyMaterial(STUB_ATTESTATION_PROVIDER);
    const workerData = structuredClone(toWorkerData(material, PORTAL_CONTEXT, new SignatureBudget(10)));
    const { material: cloned, portalContext, budget } = fromWorkerData(workerData);
    const session = EnclaveSession.fromKeyMaterial(cloned, portalContext, budget);

    const sealed = await sealRequest(material.encryptionKeypair.publicKey, Buffer.from('ping'));
    const opened = await session.openEncryptedPayload(sealed.wirePayload);
    expect(opened.innerPlaintext.toString('utf8')).toBe('ping');

    const response = await opened.sealResponse(Buffer.from('pong'));
    expect((await sealed.openResponse(response)).toString('utf8')).toBe('pong');
  });
});
