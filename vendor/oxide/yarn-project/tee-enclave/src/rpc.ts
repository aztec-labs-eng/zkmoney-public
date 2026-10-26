import type { BlockHeader } from '@aztec-labs/stdlib/tx';

import {
  type RpcMethod,
  type RpcParams,
  decodeRequest,
  encodeEncryptedResponse,
  encodeErrorResponse,
  encodeOkResponse,
  parseParams,
} from '@oxide/oxide-lib-tee/codec.js';
import { openRequest } from '@oxide/oxide-lib-tee/encryption.js';
import { FrameReader, frame } from '@oxide/oxide-lib-tee/framing.js';
import { type PortalDomain, PortalLink } from '@oxide/oxide-lib-tee/types.js';

import * as net from 'node:net';

import type { SignatureBudget } from './signature_budget.js';
import { LocalTeeSigner } from './signer.js';
import type { EnclaveKeyMaterial } from './worker_data.js';

export interface EnclaveDispatcher {
  handle(
    method: RpcMethod,
    params: unknown,
    link: PortalLink | undefined,
    disclosedDomain?: PortalDomain,
  ): Promise<unknown>;
  isPlaintextAllowed(method: RpcMethod): boolean;
  openEncryptedPayload(
    payload: Buffer,
    disclosedDomain?: PortalDomain,
  ): Promise<{
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
 * Per-worker dispatcher over the shared enclave key material.
 */
export class EnclaveSession implements EnclaveDispatcher {
  constructor(
    private readonly material: EnclaveKeyMaterial,
    private readonly budget: SignatureBudget,
  ) {}

  isPlaintextAllowed(method: RpcMethod): boolean {
    return PLAINTEXT_METHODS.has(method);
  }

  openEncryptedPayload(
    payload: Buffer,
    disclosedDomain?: PortalDomain,
  ): Promise<{
    innerPlaintext: Buffer;
    sealResponse: (innerPlaintext: Buffer) => Promise<Buffer>;
  }> {
    return openRequest(this.material.encryptionKeypair, payload, disclosedDomain);
  }

  /** @dev `link` is optional only for `getAttestation`. Every other method throws without one.
   *  A disclosed domain, when present, must match the sealed link and the request's anchor header. */
  async handle(
    method: RpcMethod,
    rawParams: unknown,
    link: PortalLink | undefined,
    disclosedDomain?: PortalDomain,
  ): Promise<unknown> {
    if (method === 'getAttestation') {
      return this.material.attestation;
    }
    if (!link) {
      throw new Error(`${method} requires a portal link in the sealed request`);
    }
    if (disclosedDomain && !PortalLink.from(disclosedDomain).equals(link)) {
      throw new Error('disclosed domain does not name the sealed portal link');
    }
    const params = await parseParams(method, rawParams);
    assertDisclosedDomainMatchesBlockHeader(disclosedDomain, method, params);
    const signer = new LocalTeeSigner(this.material.signingKey, link, this.budget);
    return await signer[method](params as never);
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
    const result = await dispatcher.handle(req.method, req.params, undefined);
    return encodeOkResponse(result);
  }
  // The disclosed plaintext domain is the payload's AAD, so opening fails if the sender did not seal under it.
  const opened = await dispatcher.openEncryptedPayload(req.payload, req.domain);
  const innerJson = opened.innerPlaintext.toString('utf8');
  const innerResponseJson = await dispatchInner(dispatcher, innerJson, req.domain);
  const sealed = await opened.sealResponse(Buffer.from(innerResponseJson, 'utf8'));
  return encodeEncryptedResponse(sealed);
}

async function dispatchInner(
  dispatcher: EnclaveDispatcher,
  innerJson: string,
  disclosedDomain: PortalDomain | undefined,
): Promise<string> {
  try {
    const inner = await decodeRequest(innerJson);
    if (inner.kind !== 'plaintext') {
      throw new Error('encrypted-in-encrypted requests are not allowed');
    }
    const result = await dispatcher.handle(inner.method, inner.params, inner.link, disclosedDomain);
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

/**
 * Rejects a disclosed domain whose chain id or rollup version disagrees with the block header the request anchors
 * on.
 */
function assertDisclosedDomainMatchesBlockHeader<M extends SigningMethod>(
  disclosed: PortalDomain | undefined,
  method: M,
  params: RpcParams<M>,
): void {
  if (!disclosed) {
    return;
  }
  const { chainId, version } = ANCHOR_HEADER[method](params).globalVariables;
  if (disclosed.l1ChainId !== chainId.toBigInt() || disclosed.rollupVersion !== version.toBigInt()) {
    throw new Error(
      `disclosed domain names chain id ${disclosed.l1ChainId} and rollup version ` +
        `${disclosed.rollupVersion}, but the block header names ` +
        `${chainId.toBigInt()} and ${version.toBigInt()}`,
    );
  }
}

type SigningMethod = Exclude<RpcMethod, 'getAttestation'>;

/** Where each signing request carries the block header its signatures anchor on. */
const ANCHOR_HEADER: { [M in SigningMethod]: (params: RpcParams<M>) => BlockHeader } = {
  signTokenOperation: params => params.anchorBlockHeader,
  signWithdrawalFinalization: params => params.hints.txEffectsHints.txBlockHeader,
  signFrozenNotesRefundFinalization: params => params.frozenTip,
  signFrozenDepositsRefundFinalization: params => params.frozenTip,
  signUnprocessedDepositRefundFinalization: params => params.frozenTip,
};
