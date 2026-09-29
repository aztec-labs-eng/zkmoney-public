import { OFAC_SDN_LIST_URL } from '@oxide/watcher-lib/sanctions';

import { describe, expect, it } from '@jest/globals';

import { DEFAULT_LOG_SCAN_WINDOW } from '../l1_operations/l1_operation_relayer.js';
import { REQUIRED_ARGS, parseRunConfig } from './test_run_config.js';

describe('createCliProgram', () => {
  it('rejects the removed prover-claims mode', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--modes', 'prover-claims'], {})).rejects.toThrow(
      /invalid relayer mode/,
    );
  });

  it('parses public docker one-liner flags', async () => {
    const config = await parseRunConfig(
      [
        ...REQUIRED_ARGS,
        '--signer',
        'keystore',
        '--keystore',
        '/data/relayer.json',
        '--keystore-password-file',
        '/run/secrets/password',
        '--modes',
        'l1-operations,fpc-funding',
      ],
      {},
    );

    expect(config.signer.backend).toBe('keystore');
    expect(config.signer.keystorePath).toBe('/data/relayer.json');
    expect(config.aztecNodeUrl).toBe('https://aztec.example');
    expect(config.modes).toEqual(['l1-operations', 'fpc-funding']);
    expect(config.state.sqlitePath).toBe('/data/oxide-relayer-{portal}.sqlite3');
    expect(config.disableSubmission).toBe(false);
    expect(config.l1OperationsSubmission).toBeDefined();
    expect(config.allowUnprofitable).toBe(false);
  });

  it('requires --portal or OXIDE_PORTAL', async () => {
    await expect(
      parseRunConfig([], {
        OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.v4.json',
        READ_L1_RPC_URL: 'https://rpc.example',
        AZTEC_NODE_URL: 'https://aztec.example',
        DISABLE_SUBMISSION: '1',
      }),
    ).rejects.toThrow(/--portal or OXIDE_PORTAL/);
  });

  it('falls back to environment config', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
      DISABLE_SUBMISSION: '1',
    });

    expect(config.deploymentEnvManifestUrl).toBe('https://manifest.example/dev.json');
    expect(config.portal.toString()).toBe('0x0000000000000000000000000000000000000001');
    expect(config.readL1RpcUrl).toBe('https://rpc.example');
    expect(config.aztecNodeUrl).toBe('https://aztec.example');
    expect(config.signer.backend).toBe('env');
    expect(config.disableSubmission).toBe(true);
  });

  it('accepts no command-line option for the Aztec node API key, so it cannot reach argv', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--aztec-node-api-key', 'leaked-value'], {})).rejects.toThrow(
      /unknown option '--aztec-node-api-key'/,
    );
  });

  it('reads the Aztec node API key from the environment', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      AZTEC_NODE_API_KEY: 'a-key-value',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
    });

    expect(config.aztecNodeApiKey).toBe('a-key-value');
  });

  it('falls back to OXIDE_AZTEC_NODE_API_KEY for the Aztec node API key', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      OXIDE_AZTEC_NODE_API_KEY: 'a-fallback-key',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
    });

    expect(config.aztecNodeApiKey).toBe('a-fallback-key');
  });

  it('leaves the Aztec node API key unset when the environment holds none', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
    });

    expect(config.aztecNodeApiKey).toBeUndefined();
  });

  it('reads the L1 RPC from the legacy L1_RPC_URL env var', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      L1_RPC_URL: 'https://legacy-rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
    });

    expect(config.readL1RpcUrl).toBe('https://legacy-rpc.example');
  });

  it('parses false boolean env values as false', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      OXIDE_AZTEC_NODE_URL: 'https://aztec-fallback.example',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
      DISABLE_SUBMISSION: 'false',
    });

    expect(config.aztecNodeUrl).toBe('https://aztec-fallback.example');
    expect(config.disableSubmission).toBe(false);
  });

  it('parses explicit false boolean CLI values as false', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--disable-submission', 'false'], {});

    expect(config.disableSubmission).toBe(false);
  });

  it('parses valueless boolean CLI flags as true', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--disable-submission'], {});

    expect(config.disableSubmission).toBe(true);
  });

  it('rejects the removed deposits mode and its flags', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--modes', 'deposits'], {})).rejects.toThrow(
      /invalid relayer mode 'deposits'/,
    );
    await expect(parseRunConfig([...REQUIRED_ARGS, '--resolver-scope', 'allowlist'], {})).rejects.toThrow(
      /unknown option '--resolver-scope'/,
    );
    await expect(parseRunConfig([...REQUIRED_ARGS, '--min-profit', '1'], {})).rejects.toThrow(
      /unknown option '--min-profit'/,
    );
  });

  it('rejects unknown options through Commander', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--bogus'], {})).rejects.toThrow(/unknown option '--bogus'/);
  });

  it('rejects the subsidy manager flags: the manifest entry is the only source', async () => {
    const address = '0x2222222222222222222222222222222222222222';
    await expect(parseRunConfig([...REQUIRED_ARGS, '--deposit-subsidy-manager', address], {})).rejects.toThrow(
      /unknown option '--deposit-subsidy-manager'/,
    );
    await expect(parseRunConfig([...REQUIRED_ARGS, '--withdrawal-subsidy-manager', address], {})).rejects.toThrow(
      /unknown option '--withdrawal-subsidy-manager'/,
    );
  });

  it('omits the L1 operation submission policy when the mode is off', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--modes', 'fpc-funding'], {});
    expect(config.l1OperationsSubmission).toBeUndefined();
  });

  it('omits the L1 operation submission policy when submission is disabled', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--modes', 'l1-operations', '--disable-submission'], {});
    expect(config.l1OperationsSubmission).toBeUndefined();
  });

  it('parses the unprofitable opt-in', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--allow-unprofitable'], {});
    expect(config.allowUnprofitable).toBe(true);
  });

  it('leaves sanctions screening off when no Predicate options are set', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(config.predicate).toBeUndefined();
  });

  it('builds the sanctions screening config from Predicate flags', async () => {
    const config = await parseRunConfig(
      [
        ...REQUIRED_ARGS,
        '--predicate-api-key',
        'secret-key',
        '--predicate-verification-hash',
        'x-managed-policy-abc',
        '--predicate-chain',
        'ethereum-mainnet',
        '--predicate-base-url',
        'https://staging.predicate.test',
        '--predicate-timeout-ms',
        '2000',
      ],
      {},
    );
    expect(config.predicate).toEqual({
      apiKey: 'secret-key',
      verificationHash: 'x-managed-policy-abc',
      chain: 'ethereum-mainnet',
      baseUrl: 'https://staging.predicate.test',
      timeoutMs: 2000,
    });
  });

  it('builds the sanctions screening config from Predicate env vars', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS], {
      OXIDE_RELAYER_PREDICATE_API_KEY: 'env-key',
      OXIDE_RELAYER_PREDICATE_VERIFICATION_HASH: 'x-managed-policy-env',
      OXIDE_RELAYER_PREDICATE_CHAIN: 'ethereum-sepolia',
    });
    expect(config.predicate).toMatchObject({
      apiKey: 'env-key',
      verificationHash: 'x-managed-policy-env',
      chain: 'ethereum-sepolia',
    });
  });

  it('rejects a partial Predicate config', async () => {
    await expect(
      parseRunConfig([...REQUIRED_ARGS, '--predicate-verification-hash', 'x-managed-policy-abc'], {}),
    ).rejects.toThrow(/predicate-api-key/);
  });

  it('defaults the Flashbots block range and accepts CLI/env overrides', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.flashbotsBlockRange).toBe(5);

    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--flashbots-block-range', '10'], {});
    expect(fromFlag.flashbotsBlockRange).toBe(10);

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], { OXIDE_RELAYER_FLASHBOTS_BLOCK_RANGE: '25' });
    expect(fromEnv.flashbotsBlockRange).toBe(25);
  });

  it('rejects a non-positive Flashbots block range', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--flashbots-block-range', '0'], {})).rejects.toThrow(
      /positive integer/,
    );
  });

  it('defaults the L1 priority fee floor and accepts CLI/env overrides', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.l1MinPriorityFeeGwei).toBe(0.1);

    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--l1-min-priority-fee-gwei', '2.5'], {});
    expect(fromFlag.l1MinPriorityFeeGwei).toBe(2.5);

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], { OXIDE_RELAYER_L1_MIN_PRIORITY_FEE_GWEI: '0.25' });
    expect(fromEnv.l1MinPriorityFeeGwei).toBe(0.25);
  });

  it('rejects a non-positive or non-numeric L1 priority fee floor', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--l1-min-priority-fee-gwei', '0'], {})).rejects.toThrow(
      /positive decimal gwei/,
    );
    await expect(parseRunConfig([...REQUIRED_ARGS, '--l1-min-priority-fee-gwei', 'fast'], {})).rejects.toThrow(
      /positive decimal gwei/,
    );
  });

  it('rejects an L1 priority fee floor that rounds down to no tip at all', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--l1-min-priority-fee-gwei', '0.0000000001'], {})).rejects.toThrow(
      /at least one wei/,
    );
    await expect(
      parseRunConfig([...REQUIRED_ARGS], { OXIDE_RELAYER_L1_MIN_PRIORITY_FEE_GWEI: '0.0000000001' }),
    ).rejects.toThrow(/at least one wei/);
  });

  it('defaults the L1 operations poll interval and accepts CLI/env overrides', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.l1OperationsPollIntervalMs).toBe(10_000);

    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--l1-operations-poll-interval-ms', '60000'], {});
    expect(fromFlag.l1OperationsPollIntervalMs).toBe(60_000);

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], {
      OXIDE_RELAYER_L1_OPERATIONS_POLL_INTERVAL_MS: '30000',
    });
    expect(fromEnv.l1OperationsPollIntervalMs).toBe(30_000);
  });

  it('defaults the SDN list URL to the OFAC export and accepts CLI/env overrides', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.sdnUrl).toBe(OFAC_SDN_LIST_URL);

    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--sdn-url', 'http://sdn.flag/SDN.XML'], {});
    expect(fromFlag.sdnUrl).toBe('http://sdn.flag/SDN.XML');

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], { OXIDE_RELAYER_SDN_URL: 'http://sdn.env/SDN.XML' });
    expect(fromEnv.sdnUrl).toBe('http://sdn.env/SDN.XML');
  });

  it('defaults the log scan window and accepts CLI/env overrides', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.logScanWindow).toBe(DEFAULT_LOG_SCAN_WINDOW);

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], { OXIDE_RELAYER_LOG_SCAN_WINDOW: '500' });
    expect(fromEnv.logScanWindow).toBe(500n);
  });
});
