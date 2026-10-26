import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createProverNodeAdminClient } from '@aztec-labs/stdlib/interfaces/server';

import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import type {
  ClaimProverTipsGasModel,
  SubmitEpochProofGasModel,
} from '@oxide/oxide-client/partial_epoch_proof_profit.js';
import { createNodeClient } from '@oxide/oxide-lib/aztec_node_client.js';

import type { PublicClient } from 'viem';

import type { PriceOracle } from '../../price_oracle/price_oracle.js';
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
  /**
   * The portals whose claims make a proof profitable. They must all settle on the rollup that the prover node
   * proves. The rollup records the first prover of a proof once for all of them. The first one gives the rollup.
   * `broadcasterAddress` is the Broadcaster that the finalization requests of the portal come through.
   */
  portals: { portalAddress: EthAddress; proverSubsidyAddress: EthAddress; broadcasterAddress: AztecAddress }[];
  l1Client: PublicClient;
  priceOracle: PriceOracle;
  /** Epoch-level early-submit thresholds for the whole partial epoch. */
  earlySubmitPolicy?: Partial<EarlySubmitPolicy>;
  submitEpochProofGasModel?: SubmitEpochProofGasModel;
  claimProverTipsGasModel?: ClaimProverTipsGasModel;
  maxFeePerGasCap?: bigint;
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

    if (config.portals.length === 0) {
      throw new Error('Early proof starter needs at least one portal');
    }
    const contracts = config.portals.map(entry => new OxidePortalContract(config.l1Client, entry.portalAddress));
    const portals = await Promise.all(
      config.portals.map((entry, i) =>
        createPortalConfig({
          portal: contracts[i],
          proverSubsidy: entry.proverSubsidyAddress,
          node,
          broadcaster: entry.broadcasterAddress,
        }),
      ),
    );

    const policy = await ProfitablePartialEpochPolicy.create({
      portal: contracts[0],
      portals,
      priceOracle: config.priceOracle,
      earlySubmitPolicy: config.earlySubmitPolicy,
      submitEpochProofGasModel: config.submitEpochProofGasModel,
      claimProverTipsGasModel: config.claimProverTipsGasModel,
      maxFeePerGasCap: config.maxFeePerGasCap,
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
