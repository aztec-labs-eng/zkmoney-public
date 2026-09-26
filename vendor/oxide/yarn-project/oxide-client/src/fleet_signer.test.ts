/**
 * `FleetSigner` against a scripted fake fleet: what it verifies before pinning, and which failures
 * resend the same sealed bytes, which re-pin, and which stop.
 */
import { Buffer32 } from '@aztec/foundation/buffer';

import type { OxidePortalContract, TEEBinding } from '@oxide/l1-contracts/oxide_portal.js';
import type { AttestationData } from '@oxide/oxide-lib/attestation/attestation_data.js';
import {
  decodeRequest,
  encodeEncryptedResponse,
  encodeErrorResponse,
  encodeOkResponse,
} from '@oxide/oxide-lib/codec.js';
import { type EnclaveEncryptionKeypair, generateEncryptionKeypair, openRequest } from '@oxide/oxide-lib/encryption.js';
import { FrameReader, frame } from '@oxide/oxide-lib/framing.js';
import type { TokenOperation } from '@oxide/oxide-lib/types.js';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { TEE_ID_HEADER } from './enclave_transport.js';
import { EnclaveRejected, EnclaveUnavailable } from './errors.js';
import { FleetSigner } from './fleet_signer.js';

type Kind = 'attestation' | 'sealed';

interface Request {
  kind: Kind;
  body: Buffer;
  teeHeader?: string;
}

/** A router or enclave answer. Omitting `status` serves `json` (or an authenticated sealed refusal). */
interface Reply {
  status?: number;
  routerCode?: string;
  json?: string;
}

/**
 * Answers whatever the test's `respond` returns and records what was asked. `n` counts requests of
 * that kind so far, so a test can script the first sealed call differently from the second.
 */
class FakeFleet {
  readonly seen: Request[] = [];
  respond: (kind: Kind, n: number) => Reply = () => ({});
  url = '';

  private readonly server = http.createServer((req, res) => void this.handle(req, res));

  constructor(private readonly keypair: EnclaveEncryptionKeypair) {}

  async start(): Promise<this> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  reset(): void {
    this.seen.length = 0;
    this.respond = () => ({});
  }

  kinds(): Kind[] {
    return this.seen.map(r => r.kind);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    const [requestFrame] = new FrameReader().push(body);
    const decoded = await decodeRequest(requestFrame!.toString('utf8'));
    const kind: Kind = decoded.kind === 'encrypted' ? 'sealed' : 'attestation';
    const n = this.seen.filter(r => r.kind === kind).length;
    this.seen.push({ kind, body, teeHeader: req.headers[TEE_ID_HEADER] as string | undefined });

    const reply = this.respond(kind, n);
    if (reply.status) {
      res.writeHead(reply.status, reply.routerCode ? { 'x-oxide-router-error': reply.routerCode } : {});
      res.end('scripted failure');
      return;
    }

    let replyJson = reply.json;
    if (replyJson === undefined && decoded.kind === 'encrypted') {
      const opened = await openRequest(this.keypair, decoded.payload);
      const sealed = await opened.sealResponse(Buffer.from(encodeErrorResponse(new Error('scripted refusal')), 'utf8'));
      replyJson = encodeEncryptedResponse(sealed);
    }

    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(frame(replyJson ?? encodeErrorResponse(new Error('scripted refusal'))));
  }
}

const TIMEOUTS = { attestationMs: 2_000, operationMs: 2_000 };
const OPERATION = {} as unknown as TokenOperation;

let attestation: AttestationData;
let attestationReply: string;
let binding: TEEBinding;
let fleet: FakeFleet;

/** Serves the one enclave this suite's portal stub knows about. */
const healthyFleet = (kind: Kind): Reply => (kind === 'attestation' ? { json: attestationReply } : {});

function stubPortal(overrides: Partial<TEEBinding> = {}, pcr0Approved = true): OxidePortalContract {
  return {
    getTeeBinding: () => Promise.resolve({ ...binding, ...overrides }),
    isPcr0Approved: () => Promise.resolve(pcr0Approved),
  } as unknown as OxidePortalContract;
}

const connect = (portal = stubPortal()) => FleetSigner.connect(fleet.url, portal, { timeouts: TIMEOUTS });

beforeAll(async () => {
  const encryption = await generateEncryptionKeypair();
  attestation = {
    attestation: Buffer.alloc(0),
    userData: {
      publicKeyX: Buffer32.fromString(`0x${'11'.repeat(32)}`),
      publicKeyY: Buffer32.fromString(`0x${'22'.repeat(32)}`),
      encPubKeyX: encryption.publicKey.x,
      encPubKeyY: encryption.publicKey.y,
    },
  };
  attestationReply = encodeOkResponse(attestation);
  binding = {
    pcr0Hash: Buffer32.fromString(`0x${'ab'.repeat(32)}`),
    keys: {
      pubKeyX: attestation.userData.publicKeyX,
      pubKeyY: attestation.userData.publicKeyY,
      encPubKeyX: attestation.userData.encPubKeyX,
      encPubKeyY: attestation.userData.encPubKeyY,
    },
  };
  fleet = await new FakeFleet(encryption).start();
});

afterAll(async () => {
  await fleet.close();
});

afterEach(() => {
  fleet.reset();
});

describe('FleetSigner.connect', () => {
  beforeEach(() => {
    fleet.respond = healthyFleet;
  });

  it('pins the enclave the portal registered these exact keys for', async () => {
    const signer = await connect();
    expect(signer.encryptionPublicKey.x).toEqual(attestation.userData.encPubKeyX);
    expect(signer.ethAddress).toEqual(signer.enclave.ethAddress);
  });

  it('refuses an enclave with no registration binding', async () => {
    await expect(connect(stubPortal({ pcr0Hash: Buffer32.ZERO }))).rejects.toThrow(/not registered/);
  });

  it('refuses an enclave whose PCR0 is not approved', async () => {
    await expect(connect(stubPortal({}, false))).rejects.toThrow(/PCR0 not approved/);
  });

  it('refuses an enclave whose attested keys differ from the registered ones', async () => {
    const keys = { ...binding.keys, encPubKeyX: Buffer32.fromString(`0x${'99'.repeat(32)}`) };
    await expect(connect(stubPortal({ keys }))).rejects.toThrow(/does not match/);
  });
});

describe('FleetSigner addressing', () => {
  it('names the pinned enclave on sealed calls and lets the fleet choose for attestation fetches', async () => {
    fleet.respond = healthyFleet;
    const signer = await connect();
    await expect(signer.signTokenOperation(OPERATION)).rejects.toThrow(EnclaveRejected);

    expect(fleet.seen[0]).toMatchObject({ kind: 'attestation', teeHeader: undefined });
    expect(fleet.seen[1]).toMatchObject({ kind: 'sealed', teeHeader: signer.ethAddress.toString() });
  });
});

describe('FleetSigner retry policy', () => {
  let signer: FleetSigner;

  beforeEach(async () => {
    fleet.respond = healthyFleet;
    signer = await connect();
    fleet.seen.length = 0;
  });

  it('stops on no-tee-routable instead of spending the remaining attempts', async () => {
    fleet.respond = () => ({ status: 503, routerCode: 'no-tee-routable' });

    const err = await signer.signTokenOperation(OPERATION).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnclaveUnavailable);
    expect((err as EnclaveUnavailable).routerCode).toBe('no-tee-routable');
    expect(fleet.kinds()).toEqual(['sealed']);
  });

  it('re-pins when the fleet no longer knows the pinned enclave', async () => {
    fleet.respond = (kind, n) => {
      if (kind === 'attestation') {
        return { json: attestationReply };
      }
      return n === 0 ? { status: 404, routerCode: 'tee-unknown' } : {};
    };

    // Reaching an enclave that refuses is a completed round trip, so the re-pin worked.
    await expect(signer.signTokenOperation(OPERATION)).rejects.toThrow(EnclaveRejected);
    expect(fleet.kinds()).toEqual(['sealed', 'attestation', 'sealed']);
  });

  it('resends the identical sealed bytes once after a transport failure', async () => {
    fleet.respond = (kind, n) => (kind === 'sealed' && n === 0 ? { status: 500 } : {});

    await expect(signer.signTokenOperation(OPERATION)).rejects.toThrow(EnclaveRejected);
    expect(fleet.kinds()).toEqual(['sealed', 'sealed']);
    expect(fleet.seen[1].body.equals(fleet.seen[0].body)).toBe(true);
  });

  it('spends an attempt on a failed re-pin rather than surfacing the re-pin failure', async () => {
    fleet.respond = () => ({ status: 500 });

    const err = await signer.signTokenOperation(OPERATION).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnclaveUnavailable);
    expect((err as EnclaveUnavailable).message).toMatch(/failed after 3 attempts/);
    expect(fleet.kinds()).toEqual(['sealed', 'sealed', 'attestation']);
  });
});
