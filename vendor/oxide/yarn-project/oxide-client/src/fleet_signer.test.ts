/**
 * `FleetSigner` against a scripted fake fleet: what it verifies before pinning, and which failures
 * resend the same sealed bytes, which re-pin, and which stop.
 */
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import type { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import type { TEEKeys } from '@oxide/l1-contracts/tee_registry.js';
import type { AttestationData } from '@oxide/oxide-lib/attestation/attestation_data.js';
import { ethAddressFromSecpPublicKey } from '@oxide/oxide-lib/attestation/user_data.js';
import {
  decodeRequest,
  encodeEncryptedResponse,
  encodeErrorResponse,
  encodeOkResponse,
} from '@oxide/oxide-lib/codec.js';
import { type EnclaveEncryptionKeypair, generateEncryptionKeypair, openRequest } from '@oxide/oxide-lib/encryption.js';
import { FrameReader, frame } from '@oxide/oxide-lib/framing.js';
import type { SignTokenOperationOutput, TokenOperation } from '@oxide/oxide-lib/types.js';

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

/** A router failure, or the enclave's result (none means refusal). */
type Reply = { status: number; routerCode?: string } | { result?: unknown };

/**
 * Answers whatever the test's `respond` returns and records what was asked. `n` counts requests of
 * that kind so far, so a test can script the first sealed call differently from the second.
 */
class FakeFleet {
  readonly seen: Request[] = [];
  respond: (kind: Kind, n: number) => Reply | Promise<Reply> = () => ({});
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

    const reply = await this.respond(kind, n);
    if ('status' in reply) {
      res.writeHead(reply.status, reply.routerCode ? { 'x-oxide-router-error': reply.routerCode } : {});
      res.end('scripted failure');
      return;
    }

    let replyJson =
      reply.result === undefined ? encodeErrorResponse(new Error('scripted refusal')) : encodeOkResponse(reply.result);
    if (decoded.kind === 'encrypted') {
      const opened = await openRequest(this.keypair, decoded.payload, decoded.domain);
      const sealed = await opened.sealResponse(Buffer.from(replyJson, 'utf8'));
      replyJson = encodeEncryptedResponse(sealed);
    }

    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(frame(replyJson));
  }
}

const TIMEOUTS = { attestationMs: 2_000, operationMs: 2_000 };
const OPERATION = {} as unknown as TokenOperation;
const EMPTY_OUTPUT: SignTokenOperationOutput = {
  signatures: [],
  withdrawalSignatures: [],
  requiredNullifiers: [],
  teeNotes: [],
  withdrawalMessageHashes: [],
};
const REGISTRATION_LEAF_INDEX = 7n;
const TEE_REGISTRY = EthAddress.fromString('0x2222222222222222222222222222222222222222');

let attestation: AttestationData;
let fleet: FakeFleet;

/** Serves the one enclave this suite's portal stub knows about. */
const healthyFleet = (kind: Kind): Reply => (kind === 'attestation' ? { result: attestation } : {});

const addressOf = ({ userData }: AttestationData) =>
  ethAddressFromSecpPublicKey({ x: userData.publicKeyX, y: userData.publicKeyY });

const keysOf = ({ userData }: AttestationData): TEEKeys => ({
  pubKeyX: userData.publicKeyX,
  pubKeyY: userData.publicKeyY,
  encPubKeyX: userData.encPubKeyX,
  encPubKeyY: userData.encPubKeyY,
});

type ReadArgs = { address: string; functionName: string; args: [string] };

/** `enclaves` are registered on the registry with `keyOverrides`, at leaf indices from `REGISTRATION_LEAF_INDEX` on. */
function stubPortal(keyOverrides: Partial<TEEKeys> = {}, enclaves = [attestation]): OxidePortalContract {
  const indexOf = (tee: EthAddress) => enclaves.findIndex(enclave => addressOf(enclave).equals(tee));
  const zero = `0x${'00'.repeat(32)}`;
  // Serves `$registrationMessages` and `$teeKeys` only for the registered enclaves on the domain's registry.
  const readContract = ({ address, functionName, args }: ReadArgs) => {
    const index = EthAddress.fromString(address).equals(TEE_REGISTRY) ? indexOf(EthAddress.fromString(args[0])) : -1;
    if (functionName === '$registrationMessages') {
      return Promise.resolve(
        index >= 0 ? [`0x${'0a'.repeat(32)}`, REGISTRATION_LEAF_INDEX + BigInt(index)] : [zero, 0n],
      );
    }
    if (functionName !== '$teeKeys') {
      throw new Error(`Unexpected read: ${functionName}`);
    }
    const keys = index >= 0 ? { ...keysOf(enclaves[index]), ...keyOverrides } : undefined;
    return Promise.resolve(
      keys
        ? [keys.pubKeyX, keys.pubKeyY, keys.encPubKeyX, keys.encPubKeyY].map(k => k.toString())
        : [zero, zero, zero, zero],
    );
  };
  return {
    address: EthAddress.fromString('0x1111111111111111111111111111111111111111'),
    client: { readContract },
    getPortalDomain: async () => ({
      l1Portal: EthAddress.fromString('0x1111111111111111111111111111111111111111'),
      l1ChainId: 31337n,
      l2Token: await AztecAddress.random(),
      teeRegistry: TEE_REGISTRY,
      rollupVersion: 1n,
    }),
  } as unknown as OxidePortalContract;
}

const connect = (portal = stubPortal(), timeouts = TIMEOUTS) => FleetSigner.connect(fleet.url, portal, { timeouts });

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

  it('pins the enclave the registry registered these exact keys for', async () => {
    const signer = await connect();
    expect(signer.enclave.encryptionPublicKey.x).toEqual(attestation.userData.encPubKeyX);
    expect(signer.enclave.ethAddress).toEqual(addressOf(attestation));
    expect(signer.enclave.registrationLeafIndex).toBe(REGISTRATION_LEAF_INDEX);
  });

  it('refuses an enclave that the registry did not register', async () => {
    await expect(connect(stubPortal({}, []))).rejects.toThrow(/not registered/);
  });

  it('refuses an enclave whose attested keys differ from the registered ones', async () => {
    await expect(connect(stubPortal({ encPubKeyX: Buffer32.fromString(`0x${'99'.repeat(32)}`) }))).rejects.toThrow(
      /does not match/,
    );
  });
});

describe('FleetSigner addressing', () => {
  it('names the pinned enclave on sealed calls and lets the fleet choose for attestation fetches', async () => {
    fleet.respond = healthyFleet;
    const signer = await connect();
    await expect(signer.signTokenOperation(OPERATION)).rejects.toThrow(EnclaveRejected);

    expect(fleet.seen[0]).toMatchObject({ kind: 'attestation', teeHeader: undefined });
    expect(fleet.seen[1]).toMatchObject({ kind: 'sealed', teeHeader: signer.enclave.ethAddress.toString() });
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
        return { result: attestation };
      }
      return n === 0 ? { status: 404, routerCode: 'tee-unknown' } : {};
    };

    // Reaching an enclave that refuses is a completed round trip, so the re-pin worked.
    await expect(signer.signTokenOperation(OPERATION)).rejects.toThrow(EnclaveRejected);
    expect(fleet.kinds()).toEqual(['sealed', 'attestation', 'sealed']);
  });

  it('resends the identical sealed bytes once after a transport failure', async () => {
    fleet.respond = (kind, n): Reply => (kind === 'sealed' && n === 0 ? { status: 500 } : {});

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

  it('names the enclave that signed even after a concurrent call re-pins', async () => {
    // The first call waits on the second's whole re-pin, so it gets more than the suite's operation timeout.
    // Same encryption key, so the fake fleet can open its requests.
    const otherAttestation = {
      attestation: Buffer.alloc(0),
      userData: {
        ...attestation.userData,
        publicKeyX: Buffer32.fromString(`0x${'33'.repeat(32)}`),
        publicKeyY: Buffer32.fromString(`0x${'44'.repeat(32)}`),
      },
    };
    const patientSigner = await connect(stubPortal({}, [attestation, otherAttestation]), {
      ...TIMEOUTS,
      operationMs: 30_000,
    });
    const firstArrived = promiseWithResolvers<void>();
    const releaseFirst = promiseWithResolvers<void>();
    fleet.respond = async (kind, n) => {
      if (kind === 'attestation') {
        return { result: otherAttestation };
      }
      if (n === 0) {
        firstArrived.resolve();
        await releaseFirst.promise;
        return { result: EMPTY_OUTPUT };
      }
      return n === 1 ? { status: 404, routerCode: 'tee-unknown' } : {};
    };

    const first = patientSigner.signTokenOperation(OPERATION);
    try {
      await firstArrived.promise;
      await expect(patientSigner.signTokenOperation(OPERATION)).rejects.toThrow(EnclaveRejected);
      expect(patientSigner.enclave.ethAddress).toEqual(addressOf(otherAttestation));
    } finally {
      releaseFirst.resolve();
    }
    const output = await first;
    expect(output.publicKey).toEqual({ x: attestation.userData.publicKeyX, y: attestation.userData.publicKeyY });
    expect(output.registrationLeafIndex).toBe(REGISTRATION_LEAF_INDEX);
  });
});
