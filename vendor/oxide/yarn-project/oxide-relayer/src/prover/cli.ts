import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import { InvalidArgumentError } from 'commander';

import { parseEthAddresses } from '../cli/parse.js';
import type { EarlySubmitPolicy } from './profitable_partial_epoch_policy/types.js';

/** Environment variables of the epoch-proofs mode. */
export const PROVER_ENV_VARS = [
  'OXIDE_RELAYER_PROVER_NODE_URL',
  'OXIDE_RELAYER_PROVER_NODE_API_KEY',
  'OXIDE_RELAYER_PROVER_PAYOUT_TOKENS',
  'OXIDE_RELAYER_EARLY_PROOF_MIN_PROFIT',
  'OXIDE_RELAYER_EARLY_PROOF_MIN_PROFIT_MARGIN_BPS',
  'OXIDE_RELAYER_EARLY_PROOF_PROVING_COST_PER_CHECKPOINT',
] as const;

/** A `run` option of the epoch-proofs mode, in the shape of the relayer option table (`cli/options.ts`). */
interface ProverOptionSpec {
  flags: string;
  description: string;
  env: (typeof PROVER_ENV_VARS)[number];
  parseVal?: (value: string | boolean) => unknown;
  url?: boolean;
}

/** The `run` options of the epoch-proofs mode. */
export const PROVER_RUN_OPTIONS: readonly ProverOptionSpec[] = [
  {
    flags: '--prover-node-url <url>',
    description: 'ProverNode RPC URL used to request early epoch proofs; required by the epoch-proofs mode',
    env: 'OXIDE_RELAYER_PROVER_NODE_URL',
    url: true,
  },
  {
    flags: '--prover-payout-tokens <addresses>',
    description:
      'comma-separated tokens that the prover accepts tips in; the prover collects from every manifest entry of the ' +
      "pinned rollup whose portal pays in one of them; default: the pinned portal's underlying only",
    env: 'OXIDE_RELAYER_PROVER_PAYOUT_TOKENS',
  },
  {
    flags: '--early-proof-min-profit <amount>',
    description: 'minimum partial-epoch proof profit in USD scaled by 10^18 (default 0)',
    env: 'OXIDE_RELAYER_EARLY_PROOF_MIN_PROFIT',
    parseVal: value => parseNonNegativeIntString(value, 'early proof min profit'),
  },
  {
    flags: '--early-proof-min-profit-margin-bps <bps>',
    description: 'minimum partial-epoch proof profit margin in basis points of the reward value (default 0)',
    env: 'OXIDE_RELAYER_EARLY_PROOF_MIN_PROFIT_MARGIN_BPS',
    parseVal: value => parseNonNegativeIntString(value, 'early proof min profit margin'),
  },
  {
    flags: '--early-proof-proving-cost-per-checkpoint <amount>',
    description: 'off-chain proving cost per checkpoint in USD scaled by 10^18 (default 0)',
    env: 'OXIDE_RELAYER_EARLY_PROOF_PROVING_COST_PER_CHECKPOINT',
    parseVal: value => parseNonNegativeIntString(value, 'early proof proving cost per checkpoint'),
  },
];

/** Raw Commander options of the epoch-proofs mode. */
export interface ProverCommanderOptions {
  proverNodeUrl?: string;
  proverPayoutTokens?: string;
  earlyProofMinProfit?: string;
  earlyProofMinProfitMarginBps?: string;
  earlyProofProvingCostPerCheckpoint?: string;
}

/** Normalized config of the epoch-proofs mode. */
export interface ProverRunConfig {
  proverNodeUrl?: string;
  /** API key of the prover node's admin API, sent as `x-api-key`. */
  proverNodeApiKey?: string;
  /**
   * The tokens that the prover accepts tips in. When it is set, the prover collects from every manifest entry of the
   * pinned rollup whose portal pays in one of them. When it is unset, the prover collects from the pinned portal only.
   */
  proverPayoutTokens?: EthAddress[];
  /** Early-proof profitability policy (min profit, profit margin, per-checkpoint proving cost). Unset fields
   *  use the defaults in `profitable_partial_epoch_policy/config.ts`. */
  earlyProofPolicy?: Partial<EarlySubmitPolicy>;
}

/**
 * Validate the epoch-proofs options against the enabled modes, and normalize them. The prover node API key comes
 * from the environment only: a command-line option would put the key in argv, readable by any process.
 */
export function toProverRunConfig(opts: ProverCommanderOptions, modes: readonly string[]): ProverRunConfig {
  if (modes.includes('epoch-proofs') && !opts.proverNodeUrl) {
    throw new Error(
      '--prover-node-url or OXIDE_RELAYER_PROVER_NODE_URL is required when the epoch-proofs mode is enabled.',
    );
  }

  const { earlyProofMinProfit, earlyProofMinProfitMarginBps, earlyProofProvingCostPerCheckpoint } = opts;
  return {
    proverNodeUrl: opts.proverNodeUrl,
    proverNodeApiKey: process.env.OXIDE_RELAYER_PROVER_NODE_API_KEY?.trim() || undefined,
    proverPayoutTokens:
      opts.proverPayoutTokens === undefined
        ? undefined
        : parseEthAddresses(opts.proverPayoutTokens, '--prover-payout-tokens'),
    earlyProofPolicy: {
      minEpochProfit: earlyProofMinProfit === undefined ? undefined : BigInt(earlyProofMinProfit),
      minEpochProfitMarginBps:
        earlyProofMinProfitMarginBps === undefined ? undefined : BigInt(earlyProofMinProfitMarginBps),
      provingCostPerCheckpoint:
        earlyProofProvingCostPerCheckpoint === undefined ? undefined : BigInt(earlyProofProvingCostPerCheckpoint),
    },
  };
}

/** Validate a non-negative integer and return it as a string (bigint defaults crash Commander help). */
function parseNonNegativeIntString(value: string | boolean, label: string): string {
  if (typeof value === 'boolean') {
    throw new InvalidArgumentError(`${label} must be a non-negative integer.`);
  }
  const trimmed = value.trim();
  let parsed: bigint;
  try {
    parsed = BigInt(trimmed);
  } catch {
    throw new InvalidArgumentError(`${label} must be a non-negative integer.`);
  }
  if (parsed < 0n) {
    throw new InvalidArgumentError(`${label} must be a non-negative integer.`);
  }
  return parsed.toString();
}
