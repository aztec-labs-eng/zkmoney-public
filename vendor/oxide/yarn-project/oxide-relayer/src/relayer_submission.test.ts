/**
 * The relayer's L1 client against two fake JSON-RPC endpoints: which methods reach the submission relay, and
 * which reach the normal read RPC. Plus the chain-driven wiring of client and tx config around them.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, mainnet, sepolia } from 'viem/chains';

import { PUBLIC_MEMPOOL_TIMEOUTS } from './l1_submission_rpc.js';
import { DEFAULT_L1_MIN_PRIORITY_FEE_GWEI } from './l1_tx_utils_config.js';
import { createRelayerL1Client, createRelayerSubmission } from './relayer_submission.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const RAW_TX = `0x${'ab'.repeat(64)}` as const;
const TX_HASH = `0x${'cd'.repeat(32)}`;

/** Records the JSON-RPC methods it is asked for and answers each with a canned result. */
class FakeRpc {
  readonly methods: string[] = [];
  url = '';

  private readonly server = http.createServer((req, res) => void this.handle(req, res));

  async start(): Promise<this> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const { id, method } = JSON.parse(Buffer.concat(chunks).toString());
    this.methods.push(method);
    const result = method === 'eth_sendRawTransaction' ? TX_HASH : '0x7a69';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }
}

describe('createRelayerL1Client', () => {
  const endpoints: FakeRpc[] = [];

  const startRpc = async (): Promise<FakeRpc> => {
    const rpc = await new FakeRpc().start();
    endpoints.push(rpc);
    return rpc;
  };

  afterEach(async () => {
    await Promise.all(endpoints.splice(0).map(rpc => rpc.stop()));
  });

  it('sends raw transactions to the submission RPC and everything else to the read RPC', async () => {
    const read = await startRpc();
    const submission = await startRpc();
    const client = createRelayerL1Client(read.url, submission.url, ACCOUNT, foundry);

    await client.getChainId();
    await client.getTransactionCount({ address: ACCOUNT.address, blockTag: 'pending' });
    await expect(client.sendRawTransaction({ serializedTransaction: RAW_TX })).resolves.toBe(TX_HASH);

    expect(submission.methods).toEqual(['eth_sendRawTransaction']);
    expect(read.methods).toEqual(['eth_chainId', 'eth_getTransactionCount']);
  });

  it('keeps every method on the one RPC when no submission RPC is configured', async () => {
    const read = await startRpc();
    const client = createRelayerL1Client(read.url, undefined, ACCOUNT, foundry);

    await client.getChainId();
    await expect(client.sendRawTransaction({ serializedTransaction: RAW_TX })).resolves.toBe(TX_HASH);

    expect(read.methods).toEqual(['eth_chainId', 'eth_sendRawTransaction']);
  });
});

describe('createRelayerSubmission', () => {
  const READ_RPC = 'https://eth-mainnet.example.com/v2/key';

  // The client is built against the real Protect host here, which sends nothing until a tx is submitted.
  it('takes the drop window as its expiry on a chain with a Protect endpoint', () => {
    const submission = createRelayerSubmission({
      chainId: 1,
      flashbotsBlockRange: 5,
      readL1RpcUrl: READ_RPC,
      account: ACCOUNT,
      chain: mainnet,
    });

    expect(submission.submissionHost).toBe('rpc.flashbots.net');
    // The window plus the 4-slot missed-slot budget, and no fee bumps on top of it.
    expect(submission.txUtilsConfig).toMatchObject({
      txTimeoutMs: 108_000,
      stallTimeMs: 108_000,
      maxSpeedUpAttempts: 0,
      cancelTxOnTimeout: false,
    });
  });

  it('carries the default priority fee floor when the operator sets none', () => {
    const submission = createRelayerSubmission({
      chainId: 1,
      flashbotsBlockRange: 5,
      readL1RpcUrl: READ_RPC,
      account: ACCOUNT,
      chain: mainnet,
    });

    expect(submission.txUtilsConfig).toMatchObject({
      minimumPriorityFeePerGas: DEFAULT_L1_MIN_PRIORITY_FEE_GWEI,
    });
  });

  it('lets the operator floor override the policy default', () => {
    const submission = createRelayerSubmission({
      chainId: 1,
      flashbotsBlockRange: 5,
      l1MinPriorityFeeGwei: 3.5,
      readL1RpcUrl: READ_RPC,
      account: ACCOUNT,
      chain: mainnet,
    });

    expect(submission.txUtilsConfig).toMatchObject({ minimumPriorityFeePerGas: 3.5 });
  });

  it('reports no submission host on a chain with no Protect endpoint, so the log shows there is no split', () => {
    const submission = createRelayerSubmission({
      chainId: 31337,
      flashbotsBlockRange: 5,
      readL1RpcUrl: READ_RPC,
      account: ACCOUNT,
      chain: foundry,
    });

    expect(submission.submissionHost).toBeUndefined();
    expect(submission.txUtilsConfig).toMatchObject({ ...PUBLIC_MEMPOOL_TIMEOUTS });
  });
  it('submits Sepolia through the read RPC with the block window as its expiry, so there is no split', () => {
    const submission = createRelayerSubmission({
      chainId: 11155111,
      flashbotsBlockRange: 5,
      readL1RpcUrl: READ_RPC,
      account: ACCOUNT,
      chain: sepolia,
    });

    expect(submission.submissionHost).toBeUndefined();
    expect(submission.protectTxStatusUrl).toBeUndefined();
    expect(submission.txUtilsConfig).toMatchObject({ txTimeoutMs: 108_000, stallTimeMs: 108_000 });
  });
});
