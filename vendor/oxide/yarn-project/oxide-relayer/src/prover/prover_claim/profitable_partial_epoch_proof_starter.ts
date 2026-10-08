import { BlockNumber } from '@aztec/foundation/branded-types';
import { EthAddress } from '@aztec/foundation/eth-address';
import { createProverNodeAdminClient } from '@aztec/stdlib/interfaces/server';

import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import type { SubmitEpochProofGasModel } from '@oxide/oxide-client/partial_epoch_proof_profit.js';
import { createNodeClient } from '@oxide/oxide-lib/aztec_node_client.js';

import type { PublicClient } from 'viem';

import { ChainlinkPriceOracle } from '../../price_oracle/chainlink_price_oracle.js';
import { PartialEpochProofStarter } from '../partial_epoch_proof_starter/index.js';
import { EarlySubmitPolicy, ProfitablePartialEpochPolicy } from '../profitable_partial_epoch_policy/index.js';
import { ProverClaimDiscoveryAdaptor } from './adaptor.js';
import { createPortalConfig } from './portal_config.js';

export interface ProfitablePartialEpochProofStarterConfig {
  nodeUrl: string;
  nodeApiKey?: string;
  /** Full ProverNode RPC endpoint. */
  proverNodeUrl: string;
  /** API key of the prover node's admin API, sent as `x-api-key`. */
  proverNodeApiKey?: string;
  portalAddress: EthAddress;
  proverSubsidyAddress: EthAddress;
  l1Client: PublicClient;
  priceOracle: ChainlinkPriceOracle;
  /** Epoch-level early-submit thresholds for the whole partial epoch. */
  earlySubmitPolicy?: Partial<EarlySubmitPolicy>;
  submitEpochProofGasModel?: SubmitEpochProofGasModel;
  fromBlock?: BlockNumber;
  pollingIntervalMS?: number;
  onError?: (error: unknown) => void | Promise<void>;
}

export class ProfitablePartialEpochProofStarter {
  private constructor(
    readonly policy: ProfitablePartialEpochPolicy,
    readonly starter: PartialEpochProofStarter,
    private readonly adaptors: ProverClaimDiscoveryAdaptor[],
  ) {}

  static async create(config: ProfitablePartialEpochProofStarterConfig): Promise<ProfitablePartialEpochProofStarter> {
    const node = createNodeClient({ url: config.nodeUrl, apiKey: config.nodeApiKey });
    // Hosted prover nodes serve their API under the `prover` namespace (prover_getJobs), like the
    // node's `node_*`.
    const proverNode = createProverNodeAdminClient(config.proverNodeUrl, {}, undefined, config.proverNodeApiKey);

    const portals = [
      await createPortalConfig({
        portal: new OxidePortalContract(config.l1Client, config.portalAddress),
        proverSubsidy: config.proverSubsidyAddress,
      }),
    ];

    const policy = await ProfitablePartialEpochPolicy.create({
      portalAddress: config.portalAddress,
      l1Client: config.l1Client,
      portals,
      priceOracle: config.priceOracle,
      earlySubmitPolicy: config.earlySubmitPolicy,
      submitEpochProofGasModel: config.submitEpochProofGasModel,
    });

    const starter = await PartialEpochProofStarter.create({
      node,
      l1Client: config.l1Client,
      partialProofPolicy: policy,
      proverNode,
      fromBlock: config.fromBlock,
      pollingIntervalMS: config.pollingIntervalMS,
      onError: config.onError,
    });

    return new ProfitablePartialEpochProofStarter(
      policy,
      starter,
      portals.map(portal => portal.adaptor),
    );
  }

  async start(): Promise<void> {
    await this.starter.start();
  }

  async stop(): Promise<void> {
    await this.starter.stop();
    this.adaptors.forEach(adaptor => adaptor.stop());
  }
}
