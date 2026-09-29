import { type EnvVar, enumConfigHelper, getValueFromEnvWithFallback } from '@aztec/foundation/config';
import { schemas } from '@aztec/foundation/schemas';

import { OFAC_SDN_LIST_URL } from '@oxide/watcher-lib/sanctions';

import { type Command, InvalidArgumentError } from 'commander';

import { DEFAULT_FPC_FUNDING_POLL_INTERVAL_MS } from '../fpc_funding/fpc_funder_caller.js';
import {
  DEFAULT_L1_OPERATIONS_POLL_INTERVAL_MS,
  DEFAULT_LOG_SCAN_WINDOW,
} from '../l1_operations/l1_operation_relayer.js';
import { DEFAULT_FLASHBOTS_BLOCK_RANGE } from '../l1_submission_rpc.js';
import { DEFAULT_L1_MIN_PRIORITY_FEE_GWEI } from '../l1_tx_utils_config.js';
import { PROVER_ENV_VARS, PROVER_RUN_OPTIONS } from '../prover/cli.js';
import { SIGNER_BACKENDS } from './config.js';

const DEFAULT_SQLITE_PATH = '/data/oxide-relayer-{portal}.sqlite3';
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_L1_OPERATIONS_RETRY_BACKOFF_MS = 30_000;
const DEFAULT_L1_OPERATIONS_MAX_RETRIES = 10;

export const RELAYER_ENV_VARS = [
  'OXIDE_DEPLOYMENT_ENV_MANIFEST_URL',
  'OXIDE_PORTAL',
  'READ_L1_RPC_URL',
  'L1_RPC_URL',
  'ETHEREUM_HOST',
  'OXIDE_RELAYER_FLASHBOTS_BLOCK_RANGE',
  'OXIDE_RELAYER_L1_MIN_PRIORITY_FEE_GWEI',
  'AZTEC_NODE_URL',
  'OXIDE_AZTEC_NODE_URL',
  'AZTEC_NODE_API_KEY',
  'OXIDE_AZTEC_NODE_API_KEY',
  ...PROVER_ENV_VARS,
  'OXIDE_RELAYER_MODES',
  'OXIDE_RELAYER_SIGNER',
  'OXIDE_RELAYER_PRIVATE_KEY_ENV',
  'OXIDE_RELAYER_KEYSTORE',
  'OXIDE_RELAYER_KEYSTORE_PASSWORD',
  'OXIDE_RELAYER_KEYSTORE_PASSWORD_FILE',
  'OXIDE_RELAYER_STATE_BACKEND',
  'OXIDE_RELAYER_STATE_PATH',
  'OXIDE_RELAYER_SQLITE_PATH',
  'OXIDE_RELAYER_WORKER_ID',
  'OXIDE_RELAYER_LEASE_TTL_MS',
  'OXIDE_RELAYER_SDN_URL',
  'OXIDE_RELAYER_LOG_SCAN_WINDOW',
  'DISABLE_SUBMISSION',
  'OXIDE_RELAYER_L1_OPERATIONS_POLL_INTERVAL_MS',
  'OXIDE_RELAYER_FPC_FUNDING_POLL_INTERVAL_MS',
  'OXIDE_RELAYER_L1_OPERATIONS_RETRY_BACKOFF_MS',
  'OXIDE_RELAYER_L1_OPERATIONS_MAX_RETRIES',
  'OXIDE_RELAYER_ALLOW_UNPROFITABLE',
  'OXIDE_RELAYER_PREDICATE_API_KEY',
  'OXIDE_RELAYER_PREDICATE_VERIFICATION_HASH',
  'OXIDE_RELAYER_PREDICATE_CHAIN',
  'OXIDE_RELAYER_PREDICATE_BASE_URL',
  'OXIDE_RELAYER_PREDICATE_TIMEOUT_MS',
] as const;

export type RelayerEnvVar = (typeof RELAYER_ENV_VARS)[number];

export interface CliOptionSpec {
  flags: string;
  description: string;
  env?: RelayerEnvVar;
  fallback?: RelayerEnvVar[];
  defaultValue?: unknown;
  parseVal?: (value: string | boolean) => unknown;
}

export const RUN_OPTIONS: readonly CliOptionSpec[] = [
  {
    flags: '--deployment-env-manifest <url>',
    description: 'deployment env manifest URL',
    env: 'OXIDE_DEPLOYMENT_ENV_MANIFEST_URL',
  },
  { flags: '--portal <address>', description: 'portal of the manifest deployment to run', env: 'OXIDE_PORTAL' },
  {
    flags: '--read-l1-rpc <url>',
    description: 'L1 RPC URL used for every read; must not be a Flashbots Protect endpoint',
    env: 'READ_L1_RPC_URL',
    fallback: ['L1_RPC_URL', 'ETHEREUM_HOST'],
  },
  {
    flags: '--flashbots-block-range <blocks>',
    description: 'Protect drop window in blocks of 12s; the local tx expiry derives from it on mainnet and Sepolia',
    env: 'OXIDE_RELAYER_FLASHBOTS_BLOCK_RANGE',
    defaultValue: DEFAULT_FLASHBOTS_BLOCK_RANGE,
    parseVal: value => parsePositiveInteger(value, 'Flashbots block range'),
  },
  {
    flags: '--l1-min-priority-fee-gwei <gwei>',
    description: 'floor for the L1 priority fee; a market tip above it still wins',
    env: 'OXIDE_RELAYER_L1_MIN_PRIORITY_FEE_GWEI',
    defaultValue: DEFAULT_L1_MIN_PRIORITY_FEE_GWEI,
    parseVal: value => parsePositiveGwei(value, 'L1 priority fee'),
  },
  {
    flags: '--aztec-node <url>',
    description: 'Aztec node URL',
    env: 'AZTEC_NODE_URL',
    fallback: ['OXIDE_AZTEC_NODE_URL'],
  },
  ...PROVER_RUN_OPTIONS,
  {
    flags: '--modes <list>',
    description: 'comma-separated modes',
    env: 'OXIDE_RELAYER_MODES',
    defaultValue: 'l1-operations',
  },
  {
    flags: '--signer <backend>',
    description: `signer backend (${SIGNER_BACKENDS.join('|')})`,
    env: 'OXIDE_RELAYER_SIGNER',
    parseVal: parseEnum(SIGNER_BACKENDS, 'signer backend'),
  },
  {
    flags: '--private-key-env <name>',
    description: 'env var containing the raw L1 private key',
    env: 'OXIDE_RELAYER_PRIVATE_KEY_ENV',
    defaultValue: 'L1_PRIVATE_KEY',
  },
  { flags: '--keystore <path>', description: 'JSON keystore path', env: 'OXIDE_RELAYER_KEYSTORE' },
  {
    flags: '--keystore-password <password>',
    description: 'JSON keystore password',
    env: 'OXIDE_RELAYER_KEYSTORE_PASSWORD',
  },
  {
    flags: '--keystore-password-file <path>',
    description: 'file containing the JSON keystore password',
    env: 'OXIDE_RELAYER_KEYSTORE_PASSWORD_FILE',
  },
  {
    flags: '--state-backend <backend>',
    description: 'state backend',
    env: 'OXIDE_RELAYER_STATE_BACKEND',
    defaultValue: 'sqlite',
    parseVal: parseEnum(['sqlite'] as const, 'state backend'),
  },
  {
    flags: '--state <path>',
    description: "state path; {portal} expands to the pinned deployment's portal",
    env: 'OXIDE_RELAYER_STATE_PATH',
    defaultValue: DEFAULT_SQLITE_PATH,
  },
  { flags: '--sqlite-path <path>', description: 'SQLite database path', env: 'OXIDE_RELAYER_SQLITE_PATH' },
  { flags: '--worker-id <id>', description: 'worker id for state-store leases', env: 'OXIDE_RELAYER_WORKER_ID' },
  {
    flags: '--lease-ttl-ms <ms>',
    description: 'work lease TTL in milliseconds',
    env: 'OXIDE_RELAYER_LEASE_TTL_MS',
    defaultValue: DEFAULT_LEASE_TTL_MS,
    parseVal: value => parsePositiveInteger(value, 'lease TTL'),
  },
  {
    flags: '--sdn-url <url>',
    description: 'OFAC SDN list (SDN.XML) that L1 operations screen addresses against',
    env: 'OXIDE_RELAYER_SDN_URL',
    defaultValue: OFAC_SDN_LIST_URL,
  },
  {
    flags: '--log-scan-window <blocks>',
    description: "blocks per L1 eth_getLogs call of the balance watcher's transfer scan",
    env: 'OXIDE_RELAYER_LOG_SCAN_WINDOW',
    defaultValue: Number(DEFAULT_LOG_SCAN_WINDOW),
    parseVal: value => parsePositiveInteger(value, 'log scan window'),
  },
  {
    flags: '--disable-submission [value]',
    description: 'disable L1 signing and broadcasting',
    env: 'DISABLE_SUBMISSION',
    defaultValue: false,
    parseVal: value => parseBoolean(value, 'DISABLE_SUBMISSION'),
  },
  {
    flags: '--l1-operations-poll-interval-ms <ms>',
    description: 'interval between L1 operation poll cycles',
    env: 'OXIDE_RELAYER_L1_OPERATIONS_POLL_INTERVAL_MS',
    defaultValue: DEFAULT_L1_OPERATIONS_POLL_INTERVAL_MS,
    parseVal: value => parsePositiveInteger(value, 'L1 operations poll interval'),
  },
  {
    flags: '--fpc-funding-poll-interval-ms <ms>',
    description: 'interval between FPC funder bounty checks',
    env: 'OXIDE_RELAYER_FPC_FUNDING_POLL_INTERVAL_MS',
    defaultValue: DEFAULT_FPC_FUNDING_POLL_INTERVAL_MS,
    parseVal: value => parsePositiveInteger(value, 'FPC funding poll interval'),
  },
  {
    flags: '--l1-operations-retry-backoff-ms <ms>',
    description: 'backoff before re-checking a deferred L1 operation',
    env: 'OXIDE_RELAYER_L1_OPERATIONS_RETRY_BACKOFF_MS',
    defaultValue: DEFAULT_L1_OPERATIONS_RETRY_BACKOFF_MS,
    parseVal: value => parsePositiveInteger(value, 'L1 operations retry backoff'),
  },
  {
    flags: '--l1-operations-max-retries <n>',
    description: 'failed executor simulations before an L1 operation is dropped',
    env: 'OXIDE_RELAYER_L1_OPERATIONS_MAX_RETRIES',
    defaultValue: DEFAULT_L1_OPERATIONS_MAX_RETRIES,
    parseVal: value => parsePositiveInteger(value, 'L1 operations max retries'),
  },
  {
    flags: '--allow-unprofitable [value]',
    description: 'submit even when unprofitable',
    env: 'OXIDE_RELAYER_ALLOW_UNPROFITABLE',
    defaultValue: false,
    parseVal: value => parseBoolean(value, 'OXIDE_RELAYER_ALLOW_UNPROFITABLE'),
  },
  {
    flags: '--predicate-api-key <key>',
    description: 'Predicate API key; setting it (with verification hash and chain) enables sanctions screening',
    env: 'OXIDE_RELAYER_PREDICATE_API_KEY',
  },
  {
    flags: '--predicate-verification-hash <hash>',
    description: 'Predicate managed policy id sent as verification_hash',
    env: 'OXIDE_RELAYER_PREDICATE_VERIFICATION_HASH',
  },
  {
    flags: '--predicate-chain <name>',
    description: 'Predicate chain name, e.g. ethereum-mainnet',
    env: 'OXIDE_RELAYER_PREDICATE_CHAIN',
  },
  {
    flags: '--predicate-base-url <url>',
    description: 'Predicate API base URL (defaults to the public endpoint)',
    env: 'OXIDE_RELAYER_PREDICATE_BASE_URL',
  },
  {
    flags: '--predicate-timeout-ms <ms>',
    description: 'per-request timeout for Predicate screening',
    env: 'OXIDE_RELAYER_PREDICATE_TIMEOUT_MS',
    parseVal: value => parsePositiveInteger(value, 'predicate timeout'),
  },
];

/** Apply the relayer's declarative option table to a Commander command. */
export function addOptions(command: Command, options: readonly CliOptionSpec[]): void {
  for (const opt of options) {
    const defaultValue = getDefaultOrEnvValue(opt);
    if (opt.parseVal) {
      command.option(opt.flags, optionDescription(opt), opt.parseVal, defaultValue);
    } else if (defaultValue !== undefined) {
      command.option(opt.flags, optionDescription(opt), defaultValue as string | boolean | string[]);
    } else {
      command.option(opt.flags, optionDescription(opt));
    }
  }
}

function getDefaultOrEnvValue(opt: CliOptionSpec): unknown {
  return getValueFromEnvWithFallback(
    asAztecEnvVar(opt.env),
    opt.parseVal,
    opt.defaultValue,
    asAztecEnvVars(opt.fallback),
  );
}

function optionDescription(opt: CliOptionSpec): string {
  const details = [opt.env ? `$${opt.env}` : undefined, ...(opt.fallback ?? []).map(name => `$${name}`)].filter(
    Boolean,
  );
  return details.length === 0 ? opt.description : `${opt.description} (${details.join(', ')})`;
}

function parseBoolean(value: string | boolean, source: string): boolean {
  const result = schemas.Boolean.safeParse(value);
  if (!result.success) {
    throw new InvalidArgumentError(`${source} must be one of: true, false, 1, 0.`);
  }
  return result.data;
}

function parsePositiveInteger(value: string | boolean, label: string): number {
  const result = schemas.Integer.safeParse(value);
  if (!result.success || result.data <= 0) {
    throw new InvalidArgumentError(`${label} must be a positive integer.`);
  }
  return result.data;
}

function parsePositiveGwei(value: string | boolean, label: string): number {
  const gwei = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(gwei) || Math.trunc(gwei * 1e9) < 1) {
    throw new InvalidArgumentError(`${label} must be a positive decimal gwei amount of at least one wei.`);
  }
  return gwei;
}

function parseEnum<const T extends readonly string[]>(
  values: T,
  label: string,
): (value: string | boolean) => T[number] {
  const parse = enumConfigHelper([...values]).parseEnv!;
  return value => {
    if (typeof value !== 'string') {
      throw new InvalidArgumentError(`invalid ${label} '${String(value)}'. Expected one of: ${values.join(', ')}.`);
    }
    try {
      return parse(value) as T[number];
    } catch {
      throw new InvalidArgumentError(`invalid ${label} '${value}'. Expected one of: ${values.join(', ')}.`);
    }
  };
}

function asAztecEnvVar(name: RelayerEnvVar | undefined): EnvVar | undefined {
  return name as EnvVar | undefined;
}

function asAztecEnvVars(names: readonly RelayerEnvVar[] | undefined): EnvVar[] | undefined {
  return names?.map(name => name as EnvVar);
}
