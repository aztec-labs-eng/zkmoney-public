import { Buffer32 } from '@aztec/foundation/buffer';

import { describe, expect, it } from '@jest/globals';

import { P256PublicKey, generateEncryptionKeypair, openRequest, sealRequest } from './encryption.js';

describe('encryption (HPKE P-256 + AES-128-GCM)', () => {
  it('round-trips request and response plaintexts', async () => {
    const enclave = await generateEncryptionKeypair();
    expect(enclave.publicKey.x.toBuffer().length).toBe(32);
    expect(enclave.publicKey.y.toBuffer().length).toBe(32);

    const requestPlaintext = Buffer.from('hello enclave', 'utf8');
    const responsePlaintext = Buffer.from('hello client', 'utf8');

    const sealed = await sealRequest(enclave.publicKey, requestPlaintext);
    const opened = await openRequest(enclave, sealed.wirePayload);
    expect(Buffer.from(opened.innerPlaintext)).toEqual(requestPlaintext);

    const responseCiphertext = await opened.sealResponse(responsePlaintext);
    const decrypted = await sealed.openResponse(responseCiphertext);
    expect(Buffer.from(decrypted)).toEqual(responsePlaintext);
  });

  it('fails to open a ciphertext that was tampered with', async () => {
    const enclave = await generateEncryptionKeypair();
    const sealed = await sealRequest(enclave.publicKey, Buffer.from('payload'));
    const tampered = Buffer.from(sealed.wirePayload);
    // Flip a byte inside the ciphertext (past the 65-byte enc prefix).
    tampered[tampered.length - 1] ^= 0x01;
    await expect(openRequest(enclave, tampered)).rejects.toThrow();
  });

  it('round-trips through toSec1Uncompressed / fromSec1Uncompressed', () => {
    const key = P256PublicKey.fromCoordinates({
      x: Buffer32.fromBuffer(Buffer.alloc(32, 0xa1)),
      y: Buffer32.fromBuffer(Buffer.alloc(32, 0xb2)),
    });
    const sec1 = key.toSec1Uncompressed();
    expect(sec1.length).toBe(65);
    expect(sec1[0]).toBe(0x04);
    const split = P256PublicKey.fromSec1Uncompressed(sec1);
    expect(split.x.toBuffer()).toEqual(key.x.toBuffer());
    expect(split.y.toBuffer()).toEqual(key.y.toBuffer());
  });

  it('fromSec1Uncompressed rejects wrong length or prefix', () => {
    expect(() => P256PublicKey.fromSec1Uncompressed(Buffer.alloc(32))).toThrow(/65-byte/);
    const bad = Buffer.alloc(65);
    bad[0] = 0x02;
    expect(() => P256PublicKey.fromSec1Uncompressed(bad)).toThrow(/prefix 0x04/);
  });
});
