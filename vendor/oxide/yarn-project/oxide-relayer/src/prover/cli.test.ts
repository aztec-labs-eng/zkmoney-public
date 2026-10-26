import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { REQUIRED_ARGS, parseRunConfig } from '../cli/test_run_config.js';

describe('epoch-proofs CLI', () => {
  it('accepts the epoch-proofs mode when a prover node URL is given', async () => {
    const config = await parseRunConfig(
      [...REQUIRED_ARGS, '--modes', 'epoch-proofs', '--prover-node-url', 'https://prover.example'],
      {},
    );

    expect(config.modes).toEqual(['epoch-proofs']);
  });

  it('rejects the epoch-proofs mode without a prover node URL', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--modes', 'epoch-proofs'], {})).rejects.toThrow(/prover-node-url/);
  });

  it('parses the optional prover node URL from CLI flags', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--prover-node-url', 'https://prover.example'], {});

    expect(config.proverNodeUrl).toBe('https://prover.example');
  });

  it('reads the prover node URL from the environment', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS], {
      OXIDE_RELAYER_PROVER_NODE_URL: 'https://prover.example',
    });

    expect(config.proverNodeUrl).toBe('https://prover.example');
  });

  it('reads the prover node API key from the environment', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS], {
      OXIDE_RELAYER_PROVER_NODE_API_KEY: 'a-prover-key',
    });

    expect(config.proverNodeApiKey).toBe('a-prover-key');
  });

  it('parses the early-proof profitability policy from CLI flags', async () => {
    const config = await parseRunConfig(
      [
        ...REQUIRED_ARGS,
        '--early-proof-min-profit',
        '1000',
        '--early-proof-min-profit-margin-bps',
        '500',
        '--early-proof-proving-cost-per-checkpoint',
        '250',
      ],
      {},
    );

    expect(config.earlyProofPolicy).toEqual({
      minEpochProfit: 1000n,
      minEpochProfitMarginBps: 500n,
      provingCostPerCheckpoint: 250n,
    });
  });

  it('leaves the early-proof policy unset when no knob is given', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS], {});

    expect(config.earlyProofPolicy).toEqual({});
  });

  it('leaves the prover payout tokens unset when none are given', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS], {});

    expect(config.proverPayoutTokens).toBeUndefined();
  });

  it('reads the prover payout tokens from the environment', async () => {
    const [usds, susds] = [EthAddress.random(), EthAddress.random()];
    const config = await parseRunConfig([...REQUIRED_ARGS], {
      OXIDE_RELAYER_PROVER_PAYOUT_TOKENS: `${usds}, ${susds},`,
    });

    expect(config.proverPayoutTokens).toEqual([usds, susds]);
  });

  it('rejects an invalid prover payout token', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--prover-payout-tokens', '0x1234'], {})).rejects.toThrow(
      /invalid address: 0x1234/,
    );
  });
});
