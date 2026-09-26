import type { AttestationData } from '@oxide/oxide-lib/attestation/attestation_data.js';
import {
  type RpcMethod,
  decodeRequest,
  encodeEncryptedResponse,
  encodeErrorResponse,
  encodeOkResponse,
  parseParams,
} from '@oxide/oxide-lib/codec.js';
import { type EnclaveEncryptionKeypair, openRequest } from '@oxide/oxide-lib/encryption.js';
import { FrameReader, frame } from '@oxide/oxide-lib/framing.js';
import type {
  FrozenDepositRefundFinalizationInput,
  FrozenNotesRefundFinalizationInput,
  PortalContext,
  TokenOperation,
  UnprocessedDepositRefundFinalizationInput,
  WithdrawalFinalizationInput,
} from '@oxide/oxide-lib/types.js';

import * as net from 'node:net';

import type { SignatureBudget } from './signature_budget.js';
import { LocalTeeSigner } from './signer.js';
import type { EnclaveKeyMaterial } from './worker_data.js';

export interface EnclaveDispatcher {
  handle(method: RpcMethod, params: unknown): Promise<unknown>;
  isPlaintextAllowed(method: RpcMethod): boolean;
  openEncryptedPayload(payload: Buffer): Promise<{
    innerPlaintext: Buffer;
    sealResponse: (innerPlaintext: Buffer) => Promise<Buffer>;
  }>;
}

/**
 * Methods clients are allowed to call without encryption. Currently only the bootstrap RPC —
 * everything else carries private payloads and must be tunneled through HPKE.
 */
const PLAINTEXT_METHODS: ReadonlySet<RpcMethod> = new Set(['getAttestation']);

/**
 * Per-worker dispatcher over the shared enclave key material: ephemeral signer + boot
 * attestation. The portal context comes from process env vars baked into the EIF at build time,
 * so it ends up inside PCR0. There is no `init` RPC; clients only see `getAttestation` + the
 * `sign*` methods.
 */
export class EnclaveSession implements EnclaveDispatcher {
  private constructor(
    private readonly signer: LocalTeeSigner,
    private readonly encryptionKeypair: EnclaveEncryptionKeypair,
    private readonly attestation: AttestationData,
  ) {}

  static fromKeyMaterial(
    material: EnclaveKeyMaterial,
    portalContext: PortalContext,
    budget: SignatureBudget,
  ): EnclaveSession {
    return new EnclaveSession(
      new LocalTeeSigner(material.signingKey, portalContext, budget),
      material.encryptionKeypair,
      material.attestation,
    );
  }

  isPlaintextAllowed(method: RpcMethod): boolean {
    return PLAINTEXT_METHODS.has(method);
  }

  openEncryptedPayload(payload: Buffer): Promise<{
    innerPlaintext: Buffer;
    sealResponse: (innerPlaintext: Buffer) => Promise<Buffer>;
  }> {
    return openRequest(this.encryptionKeypair, payload);
  }

  async handle(method: RpcMethod, rawParams: unknown): Promise<unknown> {
    const params = await parseParams(method, rawParams);
    switch (method) {
      case 'getAttestation':
        return this.attestation;
      case 'signTokenOperation': {
        return await this.signer.signTokenOperation(params as TokenOperation);
      }
      case 'signWithdrawalFinalization':
        return await this.signer.signWithdrawalFinalization(params as WithdrawalFinalizationInput);
      case 'signFrozenNotesRefundFinalization':
        return await this.signer.signFrozenNotesRefundFinalization(params as FrozenNotesRefundFinalizationInput);
      case 'signFrozenDepositRefundFinalization':
        return await this.signer.signFrozenDepositRefundFinalization(params as FrozenDepositRefundFinalizationInput);
      case 'signUnprocessedDepositRefundFinalization':
        return await this.signer.signUnprocessedDepositRefundFinalization(
          params as UnprocessedDepositRefundFinalizationInput,
        );
    }
  }
}

/** Turns one request frame into a response JSON string. Never throws. */
export type FrameHandler = (payload: Buffer) => Promise<string>;

/**
 * Bind a framed-RPC server to a socket. Every connection carries one request frame, gets one
 * response frame, then closes — matches the round-trip pattern the client transport expects.
 */
export function startRpcServer(
  handleRequest: FrameHandler,
  listen: net.ListenOptions,
  onError?: (err: unknown) => void,
): net.Server {
  const server = net.createServer(socket => {
    const reader = new FrameReader();
    let handled = false;

    socket.on('data', (chunk: Buffer) => {
      if (handled) {
        return;
      }
      let frames: Buffer[];
      try {
        frames = reader.push(chunk);
      } catch (err) {
        sendErrorAndClose(socket, err);
        handled = true;
        return;
      }
      if (frames.length === 0) {
        return;
      }
      handled = true;
      respond(socket, handleRequest, frames[0]).catch(err => {
        logEnclaveError('respond', err);
        socket.destroy();
      });
    });

    socket.on('error', err => {
      if (onError) {
        onError(err);
      }
    });
  });
  server.listen(listen);
  return server;
}

async function respond(socket: net.Socket, handleRequest: FrameHandler, payload: Buffer): Promise<void> {
  let response: string;
  try {
    response = await handleRequest(payload);
  } catch (err) {
    logEnclaveError('handle', err);
    response = encodeErrorResponse(err);
  }
  // A response that overflows the frame cap (e.g. an amplified error message) must not crash the enclave.
  let framed: Buffer;
  try {
    framed = frame(response);
  } catch (err) {
    logEnclaveError('frame', err);
    framed = frame(encodeErrorResponse(new Error('response too large')));
  }
  socket.write(framed);
  socket.end();
}

/** Dispatch one request frame against a session and encode the response. Never throws. */
export async function processFrame(dispatcher: EnclaveDispatcher, payload: Buffer): Promise<string> {
  try {
    return await dispatchFrame(dispatcher, payload);
  } catch (err) {
    logEnclaveError('outer', err);
    return encodeErrorResponse(err);
  }
}

async function dispatchFrame(dispatcher: EnclaveDispatcher, payload: Buffer): Promise<string> {
  const req = await decodeRequest(payload.toString('utf8'));
  if (req.kind === 'plaintext') {
    if (!dispatcher.isPlaintextAllowed(req.method)) {
      throw new Error(`method not allowed in plaintext: ${req.method}`);
    }
    const result = await dispatcher.handle(req.method, req.params);
    return encodeOkResponse(result);
  }
  // Encrypted: open the outer payload, dispatch the inner JSON-RPC, and seal the response.
  const opened = await dispatcher.openEncryptedPayload(req.payload);
  const innerJson = opened.innerPlaintext.toString('utf8');
  const innerResponseJson = await dispatchInner(dispatcher, innerJson);
  const sealed = await opened.sealResponse(Buffer.from(innerResponseJson, 'utf8'));
  return encodeEncryptedResponse(sealed);
}

async function dispatchInner(dispatcher: EnclaveDispatcher, innerJson: string): Promise<string> {
  try {
    const inner = await decodeRequest(innerJson);
    if (inner.kind !== 'plaintext') {
      throw new Error('encrypted-in-encrypted requests are not allowed');
    }
    const result = await dispatcher.handle(inner.method, inner.params);
    return encodeOkResponse(result);
  } catch (err) {
    logEnclaveError('inner', err);
    return encodeErrorResponse(err);
  }
}

function sendErrorAndClose(socket: net.Socket, err: unknown): void {
  logEnclaveError('frame', err);
  try {
    socket.write(frame(encodeErrorResponse(err)));
  } finally {
    socket.end();
  }
}

/**
 * Log dispatch errors to stderr so the enclave's journalctl shows them.
 *
 * The error message can embed private info (balance amounts, refund `l2Recipient`); safe to log only because
 * production seals enclave stderr in the Nitro VM.
 */
export function logEnclaveError(stage: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  let detail: string;
  try {
    // `.stack`/`.message` materialize the message string, which can overflow V8's max length for an amplified ZodError
    // and throw ERR_STRING_TOO_LONG. Logging must never throw.
    detail = e.stack ?? e.message;
  } catch {
    detail = '<error detail too large to render>';
  }
  console.error(`[oxide-tee enclave] ${stage} error:`, detail);
}
