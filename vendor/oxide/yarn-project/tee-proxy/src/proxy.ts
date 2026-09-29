// HTTP → TCP-loopback proxy. Sits between the public-facing HTTP endpoint and the enclave's
// framed-JSON listener. Pure passthrough — never decrypts anything, only moves bytes.
//
// Wire contract:
//   POST /rpc        body = framed enclave RPC bytes (4-byte BE length + JSON), one frame per
//                    request. Response body = one framed response.
//   GET  /health     200 OK (liveness; doesn't actually probe the enclave).
//   OPTIONS *        204, CORS preflight (browser POSTs of application/octet-stream always preflight).
//
// Every response carries `access-control-allow-origin: *` — the endpoint is already open to the world
// and payloads are HPKE-sealed, so any web origin may call it.
//
// Topology:
//   client → HTTP → proxy → TCP loopback → socat (oxide-tee-vsock-bridge.service)
//                 → VSOCK → enclave. Node lacks native AF_VSOCK, so socat does the VSOCK leg.
//
// One TCP socket per HTTP request — same lifecycle the enclave's RPC server already expects.
// Runtime deps: zero. Just Node 24's built-ins.
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import * as net from 'node:net';
import { pipeline } from 'node:stream/promises';

import { FrameReader, MAX_MESSAGE_SIZE, frame } from './framing.js';

const HTTP_PORT = parseInt(process.env.OXIDE_PROXY_HTTP_PORT ?? '8080', 10);
const TCP_HOST = process.env.OXIDE_PROXY_TCP_HOST ?? '127.0.0.1';
const TCP_PORT = parseInt(process.env.OXIDE_PROXY_TCP_PORT ?? '5001', 10);
// A max-size operation costs the enclave tens of seconds of verification; leave queueing headroom on top.
const REQUEST_TIMEOUT_MS = parseInt(process.env.OXIDE_PROXY_TIMEOUT_MS ?? '180000', 10);
// One frame per body: 4-byte length header + payload.
const MAX_BODY_BYTES = MAX_MESSAGE_SIZE + 4;

function connectToEnclave(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: TCP_HOST, port: TCP_PORT }, () => resolve(sock));
    sock.once('error', err => reject(err));
  });
}

/** Forwards chunks unchanged, failing the stream if the body outgrows what the enclave can frame. */
async function* capped(body: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`request body too large: ${total} > ${MAX_BODY_BYTES}`);
    }
    yield chunk;
  }
}

/** Reads the enclave's reply, resolving the framed bytes to hand back verbatim. */
async function readReply(enclave: net.Socket, signal: AbortSignal): Promise<Buffer> {
  const abort = () => enclave.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const reader = new FrameReader();
    for await (const chunk of enclave) {
      const [payload] = reader.push(chunk as Buffer);
      if (payload) {
        return frame(payload);
      }
    }
    throw new Error('enclave connection closed before response');
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Streams one HTTP request to the enclave and returns the enclave's reply. */
async function proxyRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const clientGone = new AbortController();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([clientGone.signal, timeout]);
  res.once('close', () => clientGone.abort());

  const enclave = await connectToEnclave();
  try {
    // `end: false` — the enclave answers on the same socket, so its write side must stay open.
    await pipeline(req, capped, enclave, { end: false, signal });
    const reply = await readReply(enclave, signal);
    res.setHeader('content-type', 'application/octet-stream');
    send(res, 200, reply);
  } catch (err) {
    if (timeout.aborted) {
      throw new Error(`enclave RPC timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    if (clientGone.signal.aborted) {
      throw new Error('client disconnected');
    }
    throw err;
  } finally {
    enclave.destroy();
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.statusCode = status;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-length', String(buf.length));
  res.end(buf);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET, POST');
    // x-oxide-tee is the fleet router's identity header; the proxy ignores it but must admit it
    // through preflight so browser clients built for the fleet also work against a bare host.
    res.setHeader('access-control-allow-headers', 'content-type, x-oxide-tee');
    res.setHeader('access-control-max-age', '86400');
    return send(res, 204, '');
  }
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, 'OK\n');
  }
  if (req.method !== 'POST' || req.url !== '/rpc') {
    return send(res, 404, 'not found\n');
  }
  try {
    await proxyRpc(req, res);
  } catch (err) {
    // A client that hung up mid-request leaves nothing to reply to.
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    send(res, 502, `proxy error: ${(err as Error).message}\n`);
  }
}

const server = createServer((req, res) => {
  void handle(req, res).catch(err => {
    try {
      send(res, 500, `internal error: ${(err as Error).message}\n`);
    } catch {
      // response already sent / socket closed
    }
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`[oxide-tee proxy] listening on :${HTTP_PORT} → tcp ${TCP_HOST}:${TCP_PORT}`);
});
server.on('error', err => {
  console.error('[oxide-tee proxy] server error:', err);
  process.exit(1);
});
