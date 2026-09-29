import type { EthAddress } from '@aztec/foundation/eth-address';

import type { PredicateScreenerConfig } from '../l1_operations/predicate_screener.js';
import type { ProverCommanderOptions, ProverRunConfig } from '../prover/cli.js';

/** Relayer subsystems the operator can enable from the public `run` command. */
export const RELAYER_MODES = ['l1-operations', 'fpc-funding', 'epoch-proofs'] as const;
export type RelayerMode = (typeof RELAYER_MODES)[number];

/** Signer backends implemented in this scaffold. Remote signer backends can extend this union later. */
export const SIGNER_BACKENDS = ['env', 'keystore'] as const;
export type SignerBackend = (typeof SIGNER_BACKENDS)[number];

/**
 * Operator-local policy for executing broadcast L1 operations. Only present when the l1-operations mode is
 * enabled and submission is not disabled.
 *
 * Operations submit through the deployment env manifest's published OperationExecutor for the version. Wherever
 * the chain has a Flashbots Protect endpoint (see `l1_submission_rpc.ts`) submission goes through it, so lost
 * races and unprofitable executions revert for free.
 */
export interface L1OperationsSubmissionConfig {
  /** Backoff before re-checking a deferred operation. */
  retryBackoffMs: number;
  /** Failed executor simulations before an operation is dropped. */
  maxRetries: number;
}

/**
 * Fully normalized runtime config for the relayer.
 *
 * Commander owns CLI/env collection; this type is the boundary the rest of the relayer should depend on.
 */
export interface RunConfig extends ProverRunConfig {
  deploymentEnvManifestUrl: string;
  /** The deployment this relayer serves: the portal of one entry of the v4 manifest. */
  portal: EthAddress;
  /**
   * L1 RPC for every read, and for submission too on a chain with no Flashbots Protect endpoint. Rejected when
   * it points at Protect: submission picks its own endpoint and takes no configuration (`l1_submission_rpc.ts`).
   */
  readL1RpcUrl: string;
  /** Protect drop window in blocks of 12s; the local tx expiry derives from it on mainnet and Sepolia. */
  flashbotsBlockRange: number;
  l1MinPriorityFeeGwei?: number;
  aztecNodeUrl: string;
  aztecNodeApiKey?: string;
  modes: RelayerMode[];
  signer: SignerConfig;
  state: StateConfig;
  workerId: string;
  leaseTtlMs: number;
  sdnUrl?: string;
  /** Blocks per L1 `eth_getLogs` call of the balance watcher's transfer scan. */
  logScanWindow?: bigint;
  disableSubmission: boolean;
  /** Submit even when unprofitable. */
  allowUnprofitable: boolean;
  /** Interval between L1 operation poll cycles (broadcast sync, quote, submission). */
  l1OperationsPollIntervalMs?: number;
  /** Present only when the l1-operations mode is enabled and submission is not disabled. */
  l1OperationsSubmission?: L1OperationsSubmissionConfig;
  /** Interval between FPC funder bounty checks. */
  fpcFundingPollIntervalMs?: number;
  predicate?: PredicateScreenerConfig;
}

/** Local L1 signing configuration. The signer is not loaded when `disableSubmission` is true. */
export interface SignerConfig {
  backend: SignerBackend;
  privateKeyEnvVar: string;
  keystorePath?: string;
  keystorePassword?: string;
  keystorePasswordFile?: string;
}

/** State backend selection. SQLite is the public Docker/default backend for this ticket. */
export interface StateConfig {
  backend: 'sqlite';
  sqlitePath: string;
}

/** Raw Commander option object before relayer cross-field validation is applied. */
export interface CommanderRunOptions extends ProverCommanderOptions {
  deploymentEnvManifest?: string;
  portal?: string;
  readL1Rpc?: string;
  flashbotsBlockRange?: number;
  l1MinPriorityFeeGwei?: number;
  aztecNode?: string;
  modes?: string;
  signer?: SignerBackend;
  privateKeyEnv?: string;
  keystore?: string;
  keystorePassword?: string;
  keystorePasswordFile?: string;
  stateBackend?: string;
  state?: string;
  sqlitePath?: string;
  workerId?: string;
  leaseTtlMs?: number;
  sdnUrl?: string;
  logScanWindow?: number;
  disableSubmission?: boolean;
  l1OperationsPollIntervalMs?: number;
  fpcFundingPollIntervalMs?: number;
  l1OperationsRetryBackoffMs?: number;
  l1OperationsMaxRetries?: number;
  allowUnprofitable?: boolean;
  predicateApiKey?: string;
  predicateVerificationHash?: string;
  predicateChain?: string;
  predicateBaseUrl?: string;
  predicateTimeoutMs?: number;
}
