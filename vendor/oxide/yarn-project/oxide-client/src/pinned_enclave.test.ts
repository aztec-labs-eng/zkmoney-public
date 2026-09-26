import { Buffer32 } from '@aztec/foundation/buffer';

import type { AttestationData } from '@oxide/oxide-lib/attestation/attestation_data.js';
import {
  decodeRequest,
  encodeEncryptedResponse,
  encodeErrorResponse,
  encodeOkResponse,
} from '@oxide/oxide-lib/codec.js';
import { type EnclaveEncryptionKeypair, generateEncryptionKeypair, openRequest } from '@oxide/oxide-lib/encryption.js';
import { FrameReader, frame } from '@oxide/oxide-lib/framing.js';
import type { WithdrawalFinalizationInput } from '@oxide/oxide-lib/types.js';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { EnclaveRejected, EnclaveUnavailable, PermanentError } from './errors.js';
import { PinnedEnclave } from './pinned_enclave.js';

const STUB_INPUT = {} as WithdrawalFinalizationInput;
const TIMEOUTS = { attestationMs: 5_000, operationMs: 5_000 };

function responseFromBytes(bytes: Buffer): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
}

function framedResponse(json: string): Response {
  return responseFromBytes(frame(json));
}

function framedBody(...jsons: string[]): Response {
  return responseFromBytes(Buffer.concat(jsons.map(json => frame(json))));
}

function makeSigner(keypair: EnclaveEncryptionKeypair): PinnedEnclave {
  const attestation: AttestationData = {
    attestation: Buffer.from('stub-attestation'),
    userData: {
      publicKeyX: Buffer32.ZERO,
      publicKeyY: Buffer32.ZERO,
      encPubKeyX: keypair.publicKey.x,
      encPubKeyY: keypair.publicKey.y,
    },
  };
  return new PinnedEnclave('http://enclave.test/', attestation, TIMEOUTS);
}

/** Proxy that opens the client's sealed request and returns an HPKE-sealed inner JSON response. */
function authenticatingProxy(keypair: EnclaveEncryptionKeypair, innerJson: string): typeof fetch {
  return async (_url, init) => {
    const reqBytes = Buffer.from(init!.body as ArrayBuffer);
    const [reqFrame] = new FrameReader().push(reqBytes);
    const outer = await decodeRequest(reqFrame!.toString('utf8'));
    if (outer.kind !== 'encrypted') {
      throw new Error('expected encrypted request');
    }
    const opened = await openRequest(keypair, outer.payload);
    const sealed = await opened.sealResponse(Buffer.from(innerJson, 'utf8'));
    return framedResponse(encodeEncryptedResponse(sealed));
  };
}

describe('PinnedEnclave outer-response trust', () => {
  const originalFetch = globalThis.fetch;
  let keypair: EnclaveEncryptionKeypair;

  beforeEach(async () => {
    keypair = await generateEncryptionKeypair();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('treats a forged outer error response as retryable, not PermanentError', async () => {
    globalThis.fetch = () => Promise.resolve(framedResponse(encodeErrorResponse(new Error('refused'))));
    const signer = makeSigner(keypair);

    const err = await signer.signWithdrawalFinalization(STUB_INPUT).then(
      () => undefined,
      e => e,
    );
    expect(err).toBeInstanceOf(EnclaveUnavailable);
    expect(err).not.toBeInstanceOf(PermanentError);
    expect((err as Error).message).toMatch(/unauthenticated error/);
  });

  it('treats a forged outer plaintext success as retryable, not PermanentError', async () => {
    globalThis.fetch = () => Promise.resolve(framedResponse(encodeOkResponse({ forged: true })));
    const signer = makeSigner(keypair);

    const err = await signer.signWithdrawalFinalization(STUB_INPUT).then(
      () => undefined,
      e => e,
    );
    expect(err).toBeInstanceOf(EnclaveUnavailable);
    expect(err).not.toBeInstanceOf(PermanentError);
    expect((err as Error).message).toMatch(/unauthenticated plaintext/);
  });

  it('rejects a multi-frame body (forged verdict ahead of a real encrypted reply) as retryable', async () => {
    const forged = encodeErrorResponse(new Error('refused'));
    const trailing = encodeEncryptedResponse(Buffer.from('not-real-ciphertext'));
    globalThis.fetch = () => Promise.resolve(framedBody(forged, trailing));
    const signer = makeSigner(keypair);

    const err = await signer.signWithdrawalFinalization(STUB_INPUT).then(
      () => undefined,
      e => e,
    );
    expect(err).toBeInstanceOf(EnclaveUnavailable);
    expect(err).not.toBeInstanceOf(PermanentError);
    expect((err as Error).message).toMatch(/2 frames/);
  });

  it('throws EnclaveRejected for an HPKE-authenticated inner refusal', async () => {
    globalThis.fetch = authenticatingProxy(keypair, encodeErrorResponse(new Error('non-compliant')));
    const signer = makeSigner(keypair);

    await expect(signer.signWithdrawalFinalization(STUB_INPUT)).rejects.toBeInstanceOf(EnclaveRejected);
  });
});
