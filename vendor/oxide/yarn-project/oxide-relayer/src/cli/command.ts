import { enumConfigHelper } from '@aztec/foundation/config';
import { EthAddress } from '@aztec/foundation/eth-address';

import { Command } from 'commander';

import type { PredicateScreenerConfig } from '../l1_operations/predicate_screener.js';
import { toProverRunConfig } from '../prover/cli.js';
import {
  type CommanderRunOptions,
  type L1OperationsSubmissionConfig,
  RELAYER_MODES,
  type RelayerMode,
  type RunConfig,
  type SignerBackend,
} from './config.js';
import { RUN_OPTIONS, addOptions } from './options.js';

/**
 * Build the public `oxide-relayer` CLI.
 *
 * Runtime callers should use Commander directly (`program.parseAsync()`), which defaults to `process.argv`.
 * The injected runner keeps process startup thin and lets tests capture the normalized config without
 * starting the long-running relayer loop.
 */
export function createCliProgram(run: (config: RunConfig) => Promise<void> | void): Command {
  const program = new Command();
  program
    .name('oxide-relayer')
    .description('Oxide relayer')
    .showHelpAfterError()
    .action(() => {
      program.help();
    })
    .addCommand(
      createRunCommand().action(async (options: CommanderRunOptions) => {
        const config = runOptionsToConfig(options);
        await run(config);
      }),
    );
  return program;
}

/** Build the `run` subcommand from the declarative option table. */
function createRunCommand(): Command {
  const command = new Command('run')
    .description('watch Oxide state and submit profitable L1 relayer transactions')
    .allowExcessArguments(false);

  addOptions(command, RUN_OPTIONS);
  return command;
}

/**
 * Convert Commander's raw option bag into the stable relayer config.
 *
 * This is where cross-field rules live: state backend support, signer defaulting, and submission disable flag.
 */
// Environment only: a command-line option would put the key in argv, readable by any process.
function aztecNodeApiKeyFromEnv(): string | undefined {
  return process.env.AZTEC_NODE_API_KEY?.trim() || process.env.OXIDE_AZTEC_NODE_API_KEY?.trim() || undefined;
}

function runOptionsToConfig(opts: CommanderRunOptions): RunConfig {
  const disableSubmission = opts.disableSubmission ?? false;
  const privateKeyEnvVar = opts.privateKeyEnv!;
  const stateBackend = opts.stateBackend!;
  if (stateBackend !== 'sqlite') {
    throw new Error(`unsupported --state-backend '${stateBackend}'. Only sqlite is implemented in this package.`);
  }

  const modes = parseModes(opts.modes!);
  const prover = toProverRunConfig(opts, modes);

  const l1OperationsSubmission =
    modes.includes('l1-operations') && !disableSubmission ? toL1OperationsSubmissionConfig(opts) : undefined;

  return {
    deploymentEnvManifestUrl:
      opts.deploymentEnvManifest ?? missing('--deployment-env-manifest or OXIDE_DEPLOYMENT_ENV_MANIFEST_URL'),
    portal: opts.portal ? EthAddress.fromString(opts.portal) : missing('--portal or OXIDE_PORTAL'),
    readL1RpcUrl: opts.readL1Rpc ?? missing('--read-l1-rpc, READ_L1_RPC_URL, L1_RPC_URL, or ETHEREUM_HOST'),
    flashbotsBlockRange: opts.flashbotsBlockRange!,
    l1MinPriorityFeeGwei: opts.l1MinPriorityFeeGwei,
    aztecNodeUrl: opts.aztecNode ?? missing('--aztec-node, AZTEC_NODE_URL, or OXIDE_AZTEC_NODE_URL'),
    aztecNodeApiKey: aztecNodeApiKeyFromEnv(),
    ...prover,
    modes,
    signer: {
      backend: opts.signer ?? defaultSignerBackend(privateKeyEnvVar),
      privateKeyEnvVar,
      keystorePath: opts.keystore,
      keystorePassword: opts.keystorePassword,
      keystorePasswordFile: opts.keystorePasswordFile,
    },
    state: {
      backend: 'sqlite',
      sqlitePath: opts.sqlitePath ?? opts.state!,
    },
    workerId: opts.workerId ?? `${process.pid}@${process.env.HOSTNAME ?? 'localhost'}`,
    leaseTtlMs: opts.leaseTtlMs!,
    sdnUrl: opts.sdnUrl,
    logScanWindow: BigInt(opts.logScanWindow!),
    disableSubmission,
    allowUnprofitable: opts.allowUnprofitable!,
    l1OperationsPollIntervalMs: opts.l1OperationsPollIntervalMs!,
    l1OperationsSubmission,
    fpcFundingPollIntervalMs: opts.fpcFundingPollIntervalMs!,
    predicate: toPredicateConfig(opts),
  };
}

/**
 * Build the Predicate sanctions-screening config, or `undefined` when the feature is off. Screening is opt-in:
 * it stays off unless a Predicate option is set, and once any is set the api key, verification hash, and chain
 * are all required.
 */
function toPredicateConfig(opts: CommanderRunOptions): PredicateScreenerConfig | undefined {
  const { predicateApiKey, predicateVerificationHash, predicateChain, predicateBaseUrl, predicateTimeoutMs } = opts;
  const configured =
    predicateApiKey !== undefined ||
    predicateVerificationHash !== undefined ||
    predicateChain !== undefined ||
    predicateBaseUrl !== undefined ||
    predicateTimeoutMs !== undefined;
  if (!configured) {
    return undefined;
  }
  if (!predicateApiKey || !predicateVerificationHash || !predicateChain) {
    throw new Error(
      'sanctions screening requires --predicate-api-key, --predicate-verification-hash, and --predicate-chain ' +
        '(or their OXIDE_RELAYER_PREDICATE_* env vars).',
    );
  }
  return {
    apiKey: predicateApiKey,
    verificationHash: predicateVerificationHash,
    chain: predicateChain,
    baseUrl: predicateBaseUrl,
    timeoutMs: predicateTimeoutMs,
  };
}

function toL1OperationsSubmissionConfig(opts: CommanderRunOptions): L1OperationsSubmissionConfig {
  return {
    retryBackoffMs: opts.l1OperationsRetryBackoffMs!,
    maxRetries: opts.l1OperationsMaxRetries!,
  };
}

function defaultSignerBackend(privateKeyEnvVar: string): SignerBackend {
  return process.env[privateKeyEnvVar] ? 'env' : 'keystore';
}

/** Parse and deduplicate the comma-separated mode list from CLI/env input. */
function parseModes(value: string): RelayerMode[] {
  const modes = parseCsv(value).map(mode => parseEnumValue(mode, RELAYER_MODES, 'relayer mode'));
  if (modes.length === 0) {
    throw new Error('--modes must include at least one mode.');
  }
  return [...new Set(modes)];
}

/** Parse comma-separated CLI/env list values. Empty segments are ignored so trailing commas are harmless. */
function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function parseEnumValue<const T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  try {
    return enumConfigHelper([...allowed]).parseEnv!(value) as T[number];
  } catch {
    throw new Error(`invalid ${label} '${value}'. Expected one of: ${allowed.join(', ')}.`);
  }
}

function missing(label: string): never {
  throw new Error(`missing required config: ${label}`);
}
