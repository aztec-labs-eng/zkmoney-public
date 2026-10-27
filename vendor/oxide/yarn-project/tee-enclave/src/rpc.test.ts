import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { BlockHeader, GlobalVariables } from '@aztec-labs/stdlib/tx';

import type { RpcMethod, RpcParams } from '@oxide/oxide-lib-tee/codec.js';
import { sealRequest } from '@oxide/oxide-lib-tee/encryption.js';
import { FrameReader, MAX_MESSAGE_SIZE, frame } from '@oxide/oxide-lib-tee/framing.js';
import {
  type PortalDomain,
  PortalLink,
  type TokenOperation,
  type WithdrawalFinalizationInput,
} from '@oxide/oxide-lib-tee/types.js';
import { encodeEncryptedRequest, encodeRequest } from '@oxide/oxide-lib/codec.js';

import { afterEach, describe, expect, it } from '@jest/globals';
import * as net from 'node:net';

import { type EnclaveDispatcher, EnclaveSession, processFrame, startRpcServer } from './rpc.js';
import { SignatureBudget } from './signature_budget.js';
import { createEnclaveKeyMaterial } from './worker_data.js';

// Round-trips one request frame through a real loopback server and returns the parsed response.
function roundTrip(port: number, request: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FrameReader();
    const client = net.connect(port, '127.0.0.1', () => client.write(frame(request)));
    client.on('data', chunk => {
      const frames = reader.push(chunk);
      if (frames.length > 0) {
        client.end();
        resolve(JSON.parse(frames[0]!.toString('utf8')));
      }
    });
    client.on('error', reject);
  });
}

describe('startRpcServer framing robustness', () => {
  let server: net.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function listen(dispatcher: EnclaveDispatcher): Promise<number> {
    server = startRpcServer(payload => processFrame(dispatcher, payload), { port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => server!.once('listening', resolve));
    return (server!.address() as net.AddressInfo).port;
  }

  it('replies with a short error instead of crashing when the response overflows the frame cap', async () => {
    // A result just over MAX_MESSAGE_SIZE overflows the cap, so `frame(response)` throws inside `handleFrame`.
    const oversized = 'x'.repeat(MAX_MESSAGE_SIZE + 1024);
    const dispatcher: EnclaveDispatcher = {
      isPlaintextAllowed: () => true,
      handle: () => Promise.resolve(oversized),
      openEncryptedPayload: () => Promise.reject(new Error('unused')),
    };
    const port = await listen(dispatcher);
    const res = await roundTrip(port, Buffer.from(JSON.stringify({ method: 'getAttestation' })));
    expect(res).toEqual({ ok: false, error: 'response too large' });
  });

  it('round-trips a normal small response', async () => {
    const dispatcher: EnclaveDispatcher = {
      isPlaintextAllowed: () => true,
      handle: () => Promise.resolve({ hello: 'world' }),
      openEncryptedPayload: () => Promise.reject(new Error('unused')),
    };
    const port = await listen(dispatcher);
    const res = await roundTrip(port, Buffer.from(JSON.stringify({ method: 'getAttestation' })));
    expect(res).toEqual({ ok: true, result: { hello: 'world' } });
  });
});

describe('EnclaveSession portal link and disclosed-domain handling', () => {
  const STUB_ATTESTATION_PROVIDER = {
    attest: (userData: Buffer) => Promise.resolve(Buffer.concat([Buffer.from('stub-attestation:'), userData])),
  };

  const LINK = PortalLink.from({
    l1Portal: EthAddress.fromString('0x1111111111111111111111111111111111111111'),
    l2Token: AztecAddress.fromStringUnsafe('0x0000000000000000000000000000000000000000000000000000000000001234'),
    teeRegistry: EthAddress.fromString('0x3333333333333333333333333333333333333333'),
  });
  const DOMAIN: PortalDomain = { ...LINK, l1ChainId: 31337n, rollupVersion: 1n };
  const OTHER_PORTAL_DOMAIN: PortalDomain = {
    ...DOMAIN,
    l1Portal: EthAddress.fromString('0x2222222222222222222222222222222222222222'),
  };

  const STUB_INPUT = {} as WithdrawalFinalizationInput;

  // Signable under DOMAIN and costs one budget unit to sign.
  const ONE_NOTE_OPERATION: TokenOperation = {
    anchorBlockHeader: BlockHeader.empty({
      globalVariables: GlobalVariables.empty({
        chainId: new Fr(DOMAIN.l1ChainId),
        version: new Fr(DOMAIN.rollupVersion),
      }),
    }),
    spentNotes: [],
    createdNotes: [{ amount: 0n, owner: AztecAddress.ZERO, randomness: new Fr(1) }],
    deposits: [],
    withdrawals: [],
  };

  it('refuses to sign without a portal link in the sealed request', async () => {
    const { session, material } = await newSession();
    const { inner } = await dispatch(session, material, {}, {});
    expect(inner).toEqual({ ok: false, error: expect.stringContaining('requires a portal link') });
  });

  it.each([
    ['l1Portal', { l1Portal: OTHER_PORTAL_DOMAIN.l1Portal }],
    [
      'l2Token',
      { l2Token: AztecAddress.fromStringUnsafe('0x0000000000000000000000000000000000000000000000000000000000005678') },
    ],
    ['teeRegistry', { teeRegistry: EthAddress.fromString('0x4444444444444444444444444444444444444444') }],
  ] as const)('rejects a disclosed domain whose %s does not match the sealed link', async (_field, change) => {
    const { session, material } = await newSession();
    const { inner } = await dispatch(
      session,
      material,
      { link: PortalLink.from({ ...DOMAIN, ...change }) },
      { domain: DOMAIN },
      DOMAIN,
    );
    expect(inner).toEqual({ ok: false, error: expect.stringContaining('domain does not name') });
  });

  it('fails to open a payload whose disclosed domain was swapped in transit', async () => {
    const { session, material } = await newSession();
    const { outer, inner } = await dispatch(session, material, { link: LINK }, { domain: DOMAIN }, OTHER_PORTAL_DOMAIN);
    expect(inner).toBeUndefined();
    expect(outer.ok).toBe(false);
  });

  it("fails to open a payload whose disclosed domain's chain id was rewritten in transit", async () => {
    const { session, material } = await newSession();
    const { outer, inner } = await dispatch(
      session,
      material,
      { link: LINK },
      { domain: DOMAIN },
      { ...DOMAIN, l1ChainId: DOMAIN.l1ChainId + 1n },
    );
    expect(inner).toBeUndefined();
    expect(outer.ok).toBe(false);
  });

  it('dispatches to the method handler when disclosed domain, AAD, and sealed link agree', async () => {
    const { session, material } = await newSession();
    const { inner } = await dispatch(session, material, { link: LINK }, { domain: DOMAIN }, DOMAIN);
    // The schema error on the stub params proves dispatch got past the disclosed-domain checks.
    expect(inner).toEqual({ ok: false, error: expect.stringContaining('archiveRoot') });
  });

  it('dispatches a sealed request with no disclosed domain', async () => {
    const { session, material } = await newSession();
    const { inner } = await dispatch(session, material, { link: LINK }, {});
    expect(inner).toEqual({ ok: false, error: expect.stringContaining('archiveRoot') });
  });

  it.each(['l1ChainId', 'rollupVersion'] as const)(
    "rejects a disclosed domain whose %s disagrees with the flow's anchor header",
    async field => {
      const { session, material, budget } = await newSession();
      const badDomain: PortalDomain = { ...DOMAIN, [field]: DOMAIN[field] + 1n };
      const { inner } = await dispatch(
        session,
        material,
        { link: LINK, call: { method: 'signTokenOperation', params: ONE_NOTE_OPERATION } },
        { domain: badDomain },
        badDomain,
      );
      expect(inner).toEqual({ ok: false, error: expect.stringContaining('disclosed domain names chain id') });
      expect(budget.remaining()).toBe(10);
    },
  );

  it("signs when the disclosed domain agrees with the flow's anchor header", async () => {
    const { session, material, budget } = await newSession();
    const { inner } = await dispatch(
      session,
      material,
      { link: LINK, call: { method: 'signTokenOperation', params: ONE_NOTE_OPERATION } },
      { domain: DOMAIN },
      DOMAIN,
    );
    expect(inner).toEqual({ ok: true, result: expect.objectContaining({ signatures: [expect.anything()] }) });
    expect(budget.remaining()).toBe(9);
  });

  async function newSession() {
    const material = await createEnclaveKeyMaterial(STUB_ATTESTATION_PROVIDER);
    const budget = new SignatureBudget(10);
    return { session: new EnclaveSession(material, budget), material, budget };
  }

  // Run one sealed request through the full dispatch path, returning the outer envelope and the decrypted inner one.
  async function dispatch(
    session: EnclaveSession,
    material: Awaited<ReturnType<typeof createEnclaveKeyMaterial>>,
    inner: { link?: PortalLink; call?: RpcCall },
    seal: { domain?: PortalDomain },
    disclosed?: PortalDomain,
  ) {
    const { method, params } = inner.call ?? { method: 'signWithdrawalFinalization', params: STUB_INPUT };
    const innerJson = encodeRequest(method, params, inner.link);
    const sealed = await sealRequest(material.encryptionKeypair.publicKey, Buffer.from(innerJson, 'utf8'), seal.domain);
    const body = encodeEncryptedRequest(sealed.wirePayload, disclosed);
    const outer = JSON.parse(await processFrame(session, Buffer.from(body, 'utf8')));
    if (!outer.ok || !('ciphertext' in outer)) {
      return { outer, inner: undefined };
    }
    const innerResponse = await sealed.openResponse(Buffer.from(outer.ciphertext, 'base64'));
    return { outer, inner: JSON.parse(innerResponse.toString('utf8')) };
  }
});

type RpcCall = { [M in RpcMethod]: { method: M; params: RpcParams<M> } }[RpcMethod];
