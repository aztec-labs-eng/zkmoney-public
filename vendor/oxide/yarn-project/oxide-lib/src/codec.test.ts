import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import { describe, expect, it } from '@jest/globals';

import { decodeRequest, encodeEncryptedRequest, encodeErrorResponse, sealEncryptedRequest } from './codec.js';
import { generateEncryptionKeypair } from './encryption.js';
import type { PortalDomain } from './types.js';

describe('encrypted request envelope', () => {
  const payload = Buffer.from('sealed bytes');

  it('round-trips a disclosed plaintext domain', async () => {
    const domain: PortalDomain = {
      l1Portal: EthAddress.random(),
      l2Token: await AztecAddress.random(),
      teeRegistry: EthAddress.random(),
      l1ChainId: 31337n,
      rollupVersion: 2n,
    };
    const decoded = await decodeRequest(encodeEncryptedRequest(payload, domain));
    expect(decoded.kind).toBe('encrypted');
    if (decoded.kind !== 'encrypted') {
      return;
    }
    expect(decoded.payload).toEqual(payload);
    expect(decoded.domain?.l1Portal.equals(domain.l1Portal)).toBe(true);
    expect(decoded.domain?.l2Token.equals(domain.l2Token)).toBe(true);
    expect(decoded.domain?.l1ChainId).toBe(domain.l1ChainId);
    expect(decoded.domain?.rollupVersion).toBe(domain.rollupVersion);
  });

  it('decodes without a disclosed domain', async () => {
    const decoded = await decodeRequest(encodeEncryptedRequest(payload));
    expect(decoded.kind).toBe('encrypted');
    if (decoded.kind !== 'encrypted') {
      return;
    }
    expect(decoded.domain).toBeUndefined();
  });

  it('drops unknown outer fields instead of rejecting them', async () => {
    const env = { ...JSON.parse(encodeEncryptedRequest(payload)), apiKey: 'proxy-only-secret' };
    const decoded = await decodeRequest(JSON.stringify(env));
    expect(decoded).toEqual({ kind: 'encrypted', payload, domain: undefined });
  });
});

describe('encodeErrorResponse', () => {
  it('passes a short message through unchanged', () => {
    const env = JSON.parse(encodeErrorResponse(new Error('boom')));
    expect(env).toEqual({ ok: false, error: 'boom' });
  });

  it('truncates an oversized message so the wire reply stays within limits', () => {
    const huge = 'x'.repeat(50_000);
    const env = JSON.parse(encodeErrorResponse(new Error(huge)));
    expect(env.ok).toBe(false);
    expect(env.error.length).toBeLessThan(huge.length);
    expect(env.error.endsWith('… [truncated]')).toBe(true);
  });

  it('falls back when reading the message itself throws', () => {
    const evil = new Error('placeholder');
    Object.defineProperty(evil, 'message', {
      get() {
        throw new RangeError('Cannot create a string longer than ...');
      },
    });
    const env = JSON.parse(encodeErrorResponse(evil));
    expect(env).toEqual({ ok: false, error: 'error message too large' });
  });

  it('stringifies non-Error values', () => {
    const env = JSON.parse(encodeErrorResponse('plain string'));
    expect(env).toEqual({ ok: false, error: 'plain string' });
  });
});

describe('sealEncryptedRequest domain disclosure', () => {
  it('discloses nothing by default, and the domain in plaintext on request', async () => {
    const enclave = await generateEncryptionKeypair();
    const domain = {
      l1Portal: EthAddress.random(),
      l2Token: await AztecAddress.random(),
      teeRegistry: EthAddress.random(),
      l1ChainId: 31337n,
      rollupVersion: 1n,
    };

    const bare = await sealEncryptedRequest(enclave.publicKey, 'getAttestation', undefined, domain);
    const bareDecoded = await decodeRequest(bare.body);
    expect(bareDecoded.kind).toBe('encrypted');
    if (bareDecoded.kind === 'encrypted') {
      expect(bareDecoded.domain).toBeUndefined();
    }

    const disclosed = await sealEncryptedRequest(enclave.publicKey, 'getAttestation', undefined, domain, {
      discloseDomain: true,
    });
    const disclosedDecoded = await decodeRequest(disclosed.body);
    expect(disclosedDecoded.kind).toBe('encrypted');
    if (disclosedDecoded.kind === 'encrypted') {
      expect(disclosedDecoded.domain?.l1Portal.equals(domain.l1Portal)).toBe(true);
      expect(disclosedDecoded.domain?.l1ChainId).toBe(domain.l1ChainId);
    }
  });
});
