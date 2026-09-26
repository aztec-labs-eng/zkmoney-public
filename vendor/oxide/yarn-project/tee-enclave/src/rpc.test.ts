import { FrameReader, MAX_MESSAGE_SIZE, frame } from '@oxide/oxide-lib/framing.js';

import { afterEach, describe, expect, it } from '@jest/globals';
import * as net from 'node:net';

import { type EnclaveDispatcher, processFrame, startRpcServer } from './rpc.js';

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
