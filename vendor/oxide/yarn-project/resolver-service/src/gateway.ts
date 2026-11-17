// The CCIP HTTP service of the resolver.
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import { SipaIntent, encodeDepositIntentData, predictSIPA, readSIPAImplementation } from '@oxide/l1-contracts';
import { computeRecipientCommitment } from '@oxide/oxide-lib/recipient_commitment.js';
import { computeSharedSecretSalt, deriveRecoveryCommitment } from '@oxide/resolver-lib/resolution.js';
import { Secp256k1Point } from '@oxide/resolver-lib/secp256k1_point.js';
import { generateResolutionProof } from '@oxide/resolver-proof';
import { addressKey } from '@oxide/watcher-lib/address-key';

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import {
  type Address,
  type Hex,
  type PublicClient,
  bytesToHex,
  decodeFunctionData,
  encodeAbiParameters,
  getAbiItem,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from 'viem';

import type { ProxyKind, ResolverConfig } from './config.js';
import { dayFromTimestamp } from './day.js';
import type { RateLimiter } from './rate_limiter.js';
import { readRegistration, undepositableReason } from './registry_reads.js';
import type { ResolverStore } from './resolver_store.js';
import type { ResolveOutcome, ResolverTelemetry } from './resolver_telemetry.js';
import { sendJson } from './send_json.js';

const ADDR_RESOLVER_ABI = parseAbi(['function addr(bytes32 node) view returns (address)']);
// Minimal `resolve(bytes,bytes)` fragment — recovers the wrapped `addr(node)` call the sender forwarded.
const RESOLVE_ABI = parseAbi(['function resolve(bytes name, bytes data) view returns (bytes)']);

export type GatewayDeps = {
  config: ResolverConfig;
  store: ResolverStore;
  publicClient: PublicClient;
  rateLimiter: RateLimiter;
  log: ReturnType<typeof createLogger>;
  /** Resolution core; injectable so gateway tests can stub the proving path. */
  resolve: (deps: GatewayDeps, nameHash: Hex) => Promise<Hex>;
  telemetry?: ResolverTelemetry;
  /**
   * When true, flush metrics before the HTTP response (Lambda gateway mode). AWS may freeze the process as soon as
   * the response is sent, so a later flush may not run. Leave false for long-lived local mode, which exports on a timer.
   */
  flushAfterEachRequest: boolean;
  /** The last day for which this gateway pruned the nonce counters. */
  prunedDay?: number;
};

/** The deposit implementation that the on-chain resolver uses now. Read on each resolution, because the factory owner
 *  can point the deposit intent to a new implementation. Zero means that the factory has no deposit implementation:
 *  an address predicted from it would get no sweep. */
async function depositImplementation(deps: GatewayDeps): Promise<Address> {
  const implementation = await readSIPAImplementation(
    deps.publicClient,
    deps.config.sipaFactoryAddress.toString(),
    SipaIntent.Deposit,
  );
  if (/^0x0{40}$/i.test(implementation)) {
    throw new Error('SIPAFactory has no deposit implementation blessed');
  }
  return implementation;
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A resolve addressed to a module this gateway does not answer for. Separate from the other 4xx errors because the
 * client is not at fault: it takes the sender from the record ENS names, so a mismatch means the deployment and the
 * name disagree, and every ENS-rooted resolve fails until they agree.
 */
export class UnexpectedSenderError extends GatewayError {
  constructor(sender: Hex, expected: string) {
    super(400, `unexpected sender ${sender}`);
    this.expected = expected;
  }

  readonly expected: string;
}

/** Expected after a rollup migration for every account that has not migrated. */
export class UndepositablePortalError extends GatewayError {
  constructor(reason: string) {
    super(409, `name cannot receive deposits: ${reason}`);
  }
}

export class UnknownNameError extends GatewayError {
  constructor(reason: string) {
    super(404, reason);
  }
}

/** Wraps proof or store failures so {@link classifyResolveError} can map them to a metric outcome. */
export class ResolveStageError extends Error {
  constructor(
    readonly stage: 'proof' | 'store',
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Maps errors to the fixed {@link ResolveOutcome} values recorded in metrics. */
export function classifyResolveError(err: unknown): ResolveOutcome {
  if (err instanceof GatewayError) {
    if (err instanceof UnexpectedSenderError) {
      return 'unexpected_sender';
    }
    if (err instanceof UndepositablePortalError) {
      return 'undepositable_portal';
    }
    if (err.status === 429) {
      return 'rate_limited';
    }
    if (err.message === 'rate limiter unavailable') {
      return 'limiter_unavailable';
    }
    if (err instanceof UnknownNameError) {
      return 'unknown_name';
    }
    if (err.status < 500) {
      return 'invalid_request';
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('nonce space exhausted') || message.includes('nonce out of range')) {
    return 'nonce_exhausted';
  }
  if (err instanceof ResolveStageError) {
    return err.stage === 'proof' ? 'proof_error' : 'store_error';
  }
  return 'internal_error';
}

// Candidate tokens: any whitespace-delimited token that mentions infura — deliberately coarse so no key format,
// subdomain, path, or query-param variant slips through. The replace callback keeps non-URL prose.
const INFURA_TOKEN_RE = /\S*infura\S*/gi;

/**
 * Redacts anything that looks like an Infura URL from a message before it goes into a client-visible error body. A
 * viem transport error formats the full RPC URL, key included, and viem's own sanitizer (wevm/viem#4564) strips only
 * basic-auth credentials, not path-embedded keys. Only URL-shaped tokens (containing a path separator) are redacted;
 * prose that merely says "infura" stays, so client errors remain specific enough for users to report. The key is the
 * only leakable secret the resolver holds, so this redaction only targets Infura URLs.
 */
export function redactInfuraKeys(message: string): string {
  return message.replace(INFURA_TOKEN_RE, token => (token.includes('/') ? '<infura-url>' : token));
}

/** Recovers the queried `nameHash` from a CCIP `resolve(name, addr(node))` calldata blob. */
export function decodeNameHash(callData: Hex): Hex {
  try {
    const { args } = decodeFunctionData({ abi: RESOLVE_ABI, data: callData });
    return decodeFunctionData({ abi: ADDR_RESOLVER_ABI, data: args[1] }).args[0];
  } catch {
    throw new GatewayError(400, 'expected {data} to be resolve(bytes,bytes) calldata that wraps addr(bytes32)');
  }
}

/**
 * Drops the nonce counters of past days, at most once a day for each process. A failure is only logged: a stale
 * counter costs storage, not correctness, because the day is part of the key and never moves back.
 */
export function pruneNoncesOncePerDay(deps: GatewayDeps, day: number): void {
  if (deps.prunedDay !== undefined && deps.prunedDay >= day) {
    return;
  }
  deps.prunedDay = day;
  void deps.store.pruneNonces(day).then(
    dropped => dropped > 0 && deps.log.info(`pruned ${dropped} nonce counters`),
    err => deps.log.warn(`failed to prune nonce counters: ${(err as Error).message}`),
  );
}

/**
 * Core CCIP work: name → fresh nonce → resolution proof.
 * Returns the ABI-encoded `(bytes proof, bytes32[] publicInputs, address expectedSIPA)` the SIPAResolver's
 * `resolveWithProof` consumes.
 *
 * @dev `expectedSIPA` is the address that the gateway derived; the SIPAResolver reverts if its own derivation
 * disagrees, so registry updates between resolution and redemption cannot send funds to an address that the recipient
 * does not derive.
 */
export async function computeResolveResponse(deps: GatewayDeps, nameHash: Hex): Promise<Hex> {
  const { config, store, publicClient } = deps;

  // TODO: Cache both reads with short TTLs so resolves don't hit the L1 RPC per request.
  const [registration, block] = await Promise.all([
    readRegistration(publicClient, config.nameRegistryAddress.toString(), nameHash),
    publicClient.getBlock(),
  ]);
  if (typeof registration === 'string') {
    throw new UnknownNameError(registration);
  }
  const { userAddress, user, resolverOperator } = registration;

  // Checked before the nonce allocation, so a refused name spends no nonce.
  const undepositable = await undepositableReason(
    publicClient,
    resolverOperator.oxidePortal,
    user.rollupVersion,
    config.depositTokens.map(token => token.toString() as Address),
  );
  if (undepositable !== undefined) {
    throw new UndepositablePortalError(undepositable);
  }

  const day = dayFromTimestamp(block.timestamp);
  const nonce = await store.nextNonce(userAddress, day).catch(err => {
    throw new ResolveStageError('store', err);
  });
  pruneNoncesOncePerDay(deps, day);

  const userPublicKey = new Secp256k1Point(user.publicKey.x, user.publicKey.y);
  const userL2Address = AztecAddress.fromStringUnsafe(user.l2Address);
  const sharedSecretSalt = computeSharedSecretSalt(userPublicKey, config.resolverPrivateKey, day, nonce);
  const recipientCommitment = bytesToHex(
    (await computeRecipientCommitment(sharedSecretSalt, userL2Address)).toBuffer(),
  );
  const recoveryCommitment = deriveRecoveryCommitment(sharedSecretSalt, EthAddress.fromString(userAddress));

  // The deposit intent is the recipient commitment alone; the SIPA address commits to its keccak, not the raw word.
  const intentHash = keccak256(encodeDepositIntentData(recipientCommitment));
  const proofStart = performance.now();
  const proofPromise = generateResolutionProof(
    {
      day,
      nonce,
      userPublicKey,
      resolverPublicKey: config.resolverPublicKey,
      userL2Address,
      resolverPrivateKey: config.resolverPrivateKey,
    },
    {
      threads: config.proverThreads,
      noirExecuteBinaryPath: config.noirExecuteBinaryPath,
    },
  ).then(
    result => {
      deps.telemetry?.proofGenerated((performance.now() - proofStart) / 1000);
      return result;
    },
    err => {
      throw new ResolveStageError('proof', err);
    },
  );
  const [{ proof, publicInputs }, sipa] = await Promise.all([
    proofPromise,
    depositImplementation(deps).then(implementation =>
      predictSIPA(
        publicClient,
        config.sipaFactoryAddress.toString(),
        implementation,
        intentHash,
        recoveryCommitment.toString(),
        user.rollupVersion,
        true, // CCIP resolutions always produce resweepable SIPAs.
        resolverOperator.oxidePortal,
      ),
    ),
  ]);

  deps.log.info(`resolved sipa ${sipa} (day ${day}, nonce ${nonce})`);
  return encodeAbiParameters(parseAbiParameters('bytes,bytes32[],address'), [bytesToHex(proof), publicInputs, sipa]);
}

/**
 * The address the rate limiter buckets by. What is authoritative depends on the ingress:
 *   - `apigw`     → last X-Forwarded-For entry, the one API Gateway appended (earlier entries are client-forgeable)
 *   - `cloudfront`→ CloudFront-Viewer-Address, which CloudFront sets itself and strips any client-supplied version
 *                   of. XFF is now a two-hop chain and its last entry is only API Gateway's view of the CloudFront
 *                   edge, so trusting it would collapse every viewer under one POP into one bucket
 *   - `none`      → socket peer address; every forwarded-for header is ignored as client-controlled
 * A missing header falls back to the socket address (never to a spoofable entry, never to `unknown`-except-as-a-last-
 * resort).
 */
function clientIp(req: IncomingMessage, proxyKind: ProxyKind): string {
  if (proxyKind === 'cloudfront') {
    const raw = req.headers['cloudfront-viewer-address'];
    const header = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (typeof header === 'string' && header.length > 0) {
      // Shape: "<ipv4>:<port>" or "[<ipv6>]:<port>". Strip the trailing `:port` and any brackets.
      return header.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    }
    return req.socket.remoteAddress ?? 'unknown';
  }
  if (proxyKind === 'apigw') {
    const forwarded = req.headers['x-forwarded-for'];
    const header = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
    if (typeof header === 'string') {
      const entries = header
        .split(',')
        .map(e => e.trim())
        .filter(e => e.length > 0);
      if (entries.length > 0) {
        return entries[entries.length - 1];
      }
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Parses `{sender}` / `{data}` out of an EIP-3668 GET (`/{sender}/{data}.json`) or POST body.
 *
 * TODO: For prod replace this hand-rolled parsing with a standard framework with more validation, e.g. Express
 * + body-parser.
 */
export async function parseRequest(req: IncomingMessage): Promise<{ sender: Hex; data: Hex }> {
  if (req.method === 'GET') {
    const segments = (req.url ?? '').split('/').filter(s => s.length > 0);
    if (segments.length !== 2) {
      throw new GatewayError(400, 'expected /{sender}/{data}.json');
    }
    return {
      sender: segments[0] as Hex,
      data: segments[1].replace(/\.json$/, '') as Hex,
    };
  }
  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let body: { sender?: unknown; data?: unknown } | null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = null;
    }
    if (typeof body?.sender !== 'string' || typeof body.data !== 'string') {
      throw new GatewayError(400, 'expected JSON {sender, data}');
    }
    return { sender: body.sender as Hex, data: body.data as Hex };
  }
  throw new GatewayError(405, 'method not allowed');
}

/** Spends one rate-limit token. Limiter errors are 503, not 429 — no limit was exceeded, the check was unavailable. */
async function checkRateLimit(deps: GatewayDeps, ip: string, nameHash: Hex): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await deps.rateLimiter.allow(ip, nameHash);
  } catch (err) {
    deps.log.error(`rate limiter check failed: ${(err as Error).message}`);
    // Fail closed: an unreachable limiter must never become a bypass.
    throw new GatewayError(503, 'rate limiter unavailable');
  }
  if (!allowed) {
    throw new GatewayError(429, 'rate limit exceeded');
  }
}

/** Accepts only the Resolver module this gateway answers for. `sender` is client-supplied, so this is a fail-fast
 *  check for a mismatched module, not a security control. */
function checkSender(deps: GatewayDeps, sender: Hex): void {
  const expected = deps.config.resolverAddress.toString();
  if (addressKey(sender) !== addressKey(expected)) {
    throw new UnexpectedSenderError(sender, expected);
  }
}

async function handle(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }
  const startedAt = performance.now();
  let status: number;
  let body: unknown;
  let outcome: ResolveOutcome;
  try {
    const { sender, data } = await parseRequest(req);
    const nameHash = decodeNameHash(data);
    // Throttle per (IP, name): one IP gets a bounded number of resolves for any single name. Runs before the
    // sender check so the check's cache-miss RPC read is rate-limited too.
    await checkRateLimit(deps, clientIp(req, deps.config.proxyKind), nameHash);
    checkSender(deps, sender);
    const response = await deps.resolve(deps, nameHash);
    status = 200;
    body = { data: response };
    outcome = 'success';
  } catch (err) {
    status = err instanceof GatewayError ? err.status : 500;
    outcome = classifyResolveError(err);
    if (status >= 500) {
      deps.log.error(`gateway error: ${(err as Error).message}`);
    } else if (err instanceof UnexpectedSenderError) {
      // Logged although it is a 4xx: the client is not at fault, and this names both sides of the mismatch that
      // makes every ENS-rooted resolve fail.
      deps.log.error(`${err.message}; this gateway answers for ${err.expected}`);
    }
    body = { message: redactInfuraKeys((err as Error).message) };
  }
  deps.telemetry?.resolveCompleted(outcome, (performance.now() - startedAt) / 1000);
  // Flush here, before the response. After sendJson the Lambda can freeze and a later flush would be lost.
  if (deps.flushAfterEachRequest) {
    await deps.telemetry?.flushBounded();
  }
  sendJson(res, status, body);
}

export type RunningGateway = {
  server: Server;
  port: number;
  close: () => Promise<void>;
};

/** Builds the gateway deps and starts the HTTP listener. */
export async function startGateway(
  config: ResolverConfig,
  store: ResolverStore,
  rateLimiter: RateLimiter,
  publicClient: PublicClient,
  overrides: Partial<Pick<GatewayDeps, 'resolve' | 'telemetry' | 'flushAfterEachRequest' | 'log'>> = {},
): Promise<RunningGateway> {
  // Assert the `resolve` selector exists in the bound ABI so a stale build fails loudly here, not per-request.
  getAbiItem({ abi: RESOLVE_ABI, name: 'resolve' });
  const deps: GatewayDeps = {
    config,
    store,
    publicClient,
    rateLimiter,
    log: createLogger('oxide:resolver:gateway'),
    resolve: computeResolveResponse,
    // True only for Lambda. Local mode exports on a timer and must not wait on a flush per request.
    flushAfterEachRequest: config.mode === 'gateway',
    ...overrides,
  };

  const server = createServer((req, res) => {
    void handle(deps, req, res).catch(err => {
      deps.log.error(`gateway error: ${(err as Error).message}`);
      try {
        sendJson(res, 500, {
          message: redactInfuraKeys((err as Error).message),
        });
      } catch {
        // response already sent
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, config.httpHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.httpPort;
  deps.log.info(`gateway listening on http://${config.httpHost}:${port}`);

  return {
    server,
    port,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}
