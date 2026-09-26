import { jsonStringify } from '@aztec/foundation/json-rpc';

import { z } from 'zod';

import { AttestationDataSchema } from './attestation/attestation_data.js';
import {
  FrozenDepositRefundFinalizationInputSchema,
  FrozenDepositRefundFinalizationOutputSchema,
  FrozenNotesRefundFinalizationInputSchema,
  FrozenNotesRefundFinalizationOutputSchema,
  SignTokenOperationOutputSchema,
  TokenOperationSchema,
  UnprocessedDepositRefundFinalizationInputSchema,
  UnprocessedDepositRefundFinalizationOutputSchema,
  WithdrawalFinalizationInputSchema,
  WithdrawalFinalizationOutputSchema,
} from './types.js';

/**
 * Per-method param + result schemas. The dispatcher on the enclave side re-parses params with
 * the method-specific schema (envelope keeps params as `unknown` so we can route first).
 *
 * Note: there is intentionally no `init` method. The portal context is hard-coded at EIF build
 * time so it lives inside PCR0 — no operator-supplied configuration changes the measurement.
 */
export const RPC_METHODS = {
  getAttestation: { params: z.undefined(), result: AttestationDataSchema },
  signTokenOperation: {
    params: TokenOperationSchema,
    result: SignTokenOperationOutputSchema,
  },
  signWithdrawalFinalization: { params: WithdrawalFinalizationInputSchema, result: WithdrawalFinalizationOutputSchema },
  signFrozenNotesRefundFinalization: {
    params: FrozenNotesRefundFinalizationInputSchema,
    result: FrozenNotesRefundFinalizationOutputSchema,
  },
  signFrozenDepositRefundFinalization: {
    params: FrozenDepositRefundFinalizationInputSchema,
    result: FrozenDepositRefundFinalizationOutputSchema,
  },
  signUnprocessedDepositRefundFinalization: {
    params: UnprocessedDepositRefundFinalizationInputSchema,
    result: UnprocessedDepositRefundFinalizationOutputSchema,
  },
} as const;

export type RpcMethod = keyof typeof RPC_METHODS;

// Use output (post-parse) types so callers pass real runtime instances (Fr, EthAddress, ...),
// not the permissive wire-form unions Zod's coercion schemas accept on input.
export type RpcParams<M extends RpcMethod> = z.output<(typeof RPC_METHODS)[M]['params']>;
export type RpcResult<M extends RpcMethod> = z.output<(typeof RPC_METHODS)[M]['result']>;

/**
 * Outer envelope. `getAttestation` is the bootstrap RPC and goes plaintext (the response is the
 * public attestation that the client verifies before encrypting anything else). Every other
 * method ships under `{ method: "encrypted", payload: <base64> }` — the inner request + response
 * are HPKE-sealed to the enclave's P-256 pubkey, so the operator only ever sees ciphertext.
 */
const ENCRYPTED_OUTER_METHOD = 'encrypted';

const RpcRequestEnvelopeSchema = z.union([
  z.object({ method: z.literal(ENCRYPTED_OUTER_METHOD), payload: z.string() }),
  z.object({ method: z.string(), params: z.unknown().optional() }),
]);

const RpcResponseEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), ciphertext: z.string() }),
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export function encodeRequest<M extends RpcMethod>(method: M, params: RpcParams<M>): string {
  return jsonStringify({ method, params });
}

export function encodeEncryptedRequest(payload: Buffer): string {
  return jsonStringify({ method: ENCRYPTED_OUTER_METHOD, payload: payload.toString('base64') });
}

export type DecodedRequest =
  | { kind: 'plaintext'; method: RpcMethod; params: unknown }
  | { kind: 'encrypted'; payload: Buffer };

// Async-parse path: some sub-schemas (e.g. CompleteAddress) hydrate via async transforms,
// so the whole pipeline must use `parseAsync`. The transport layer is already async.
export async function decodeRequest(json: string): Promise<DecodedRequest> {
  const env = await RpcRequestEnvelopeSchema.parseAsync(JSON.parse(json));
  if (env.method === ENCRYPTED_OUTER_METHOD && 'payload' in env) {
    return { kind: 'encrypted', payload: Buffer.from(env.payload, 'base64') };
  }
  if (!(env.method in RPC_METHODS)) {
    throw new Error(`Unknown RPC method: ${env.method}`);
  }
  // The plaintext path is reserved for getAttestation; the dispatcher rejects everything else.
  return {
    kind: 'plaintext',
    method: env.method as RpcMethod,
    params: 'params' in env ? env.params : undefined,
  };
}

export function encodeOkResponse(result: unknown): string {
  return jsonStringify({ ok: true, result });
}

export function encodeEncryptedResponse(ciphertext: Buffer): string {
  return jsonStringify({ ok: true, ciphertext: ciphertext.toString('base64') });
}

// Wire error messages are capped so a caller cannot amplify a malformed request into a giant reply
// (a long ZodError lists one issue per bad element).
const MAX_ERROR_MESSAGE_CHARS = 4096;

export function encodeErrorResponse(error: unknown): string {
  let message: string;
  try {
    const raw = error instanceof Error ? error.message : String(error);
    message = raw.length > MAX_ERROR_MESSAGE_CHARS ? `${raw.slice(0, MAX_ERROR_MESSAGE_CHARS)}… [truncated]` : raw;
  } catch {
    // Materializing the message can itself throw: a multi-hundred-MB ZodError message overflows
    // V8's max string length, so reading `.message` raises ERR_STRING_TOO_LONG. Fall back instead.
    message = 'error message too large';
  }
  return jsonStringify({ ok: false, error: message });
}

export type DecodedResponse =
  | { kind: 'plaintext'; result: unknown }
  | { kind: 'encrypted'; ciphertext: Buffer }
  | { kind: 'error'; error: string };

export async function decodeResponseEnvelope(json: string): Promise<DecodedResponse> {
  const env = await RpcResponseEnvelopeSchema.parseAsync(JSON.parse(json));
  if (!env.ok) {
    return { kind: 'error', error: env.error };
  }
  if ('ciphertext' in env) {
    return { kind: 'encrypted', ciphertext: Buffer.from(env.ciphertext, 'base64') };
  }
  return { kind: 'plaintext', result: env.result };
}

export async function decodeResponse<M extends RpcMethod>(method: M, json: string): Promise<RpcResult<M>> {
  const env = await decodeResponseEnvelope(json);
  if (env.kind === 'error') {
    throw new Error(`Enclave RPC error (${method}): ${env.error}`);
  }
  if (env.kind !== 'plaintext') {
    throw new Error(`Enclave RPC error (${method}): expected plaintext result`);
  }
  return (await RPC_METHODS[method].result.parseAsync(env.result)) as RpcResult<M>;
}

export async function parseInnerResult<M extends RpcMethod>(method: M, result: unknown): Promise<RpcResult<M>> {
  return (await RPC_METHODS[method].result.parseAsync(result)) as RpcResult<M>;
}

// Re-parse the params blob with the method-specific schema (the request envelope leaves params
// as `unknown` so dispatch can pick the right schema).
export async function parseParams<M extends RpcMethod>(method: M, params: unknown): Promise<RpcParams<M>> {
  return (await RPC_METHODS[method].params.parseAsync(params)) as RpcParams<M>;
}
