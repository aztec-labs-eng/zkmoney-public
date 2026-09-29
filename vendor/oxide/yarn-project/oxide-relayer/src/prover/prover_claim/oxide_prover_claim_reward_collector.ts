import { RollupContract } from '@aztec/ethereum/contracts/rollup';
import { EthAddress } from '@aztec/foundation/eth-address';
import { Logger } from '@aztec/foundation/log';

import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import { createNodeClient } from '@oxide/oxide-lib/aztec_node_client.js';
import { TeeSigner } from '@oxide/oxide-lib/types.js';

import type { L1SubmissionBatcher } from '../../l1_submission_batcher.js';
import { ChainlinkPriceOracle } from '../../price_oracle/chainlink_price_oracle.js';
import type { RelayerL1TxUtils } from '../../relayer_l1_tx_utils.js';
import {
  ClaimBatchSubmitterOptions,
  ProverClaimRewardCollector,
  TrackerOptions,
} from '../prover_claim_reward_collector/index.js';
import { ProverClaimAdaptor } from './adaptor.js';
import { createClaimPortalConfig } from './portal_config.js';

export interface OxideProverClaimRewardCollectorConfig {
  /** Address whose recorded first-prover captures are claimed, and the rewards recipient. */
  proverId: EthAddress;
  portalAddress: EthAddress;
  proverSubsidyAddress: EthAddress;
  /**
   * Tx utils to submit through. The host shares one signer across subsystems, so every send goes on the one
   * queue and nonces cannot race. Its sender must be `proverId`.
   */
  l1TxUtils: RelayerL1TxUtils;
  l1SubmissionBatcher?: L1SubmissionBatcher;
  nodeUrl: string;
  nodeApiKey?: string;
  /** TEE signer used to co-sign the withdrawal finalization embedded in each claim. */
  signer: TeeSigner;
  priceOracle: ChainlinkPriceOracle;
  /** Minimum batch profit in the oracle's common quote currency: a batch below it is not worth a tx. */
  minBatchProfit?: bigint;
  trackerOptions?: Partial<TrackerOptions>;
  claimBatchSubmitterOptions?: ClaimBatchSubmitterOptions;
  log?: Logger;
}

export class OxideProverClaimRewardCollector {
  private constructor(
    private readonly collector: ProverClaimRewardCollector,
    private readonly adaptors: ProverClaimAdaptor[],
  ) {}

  static async create(config: OxideProverClaimRewardCollectorConfig): Promise<OxideProverClaimRewardCollector> {
    const l1Client = config.l1TxUtils.client;
    const node = createNodeClient({ url: config.nodeUrl, apiKey: config.nodeApiKey });
    const portal = new OxidePortalContract(l1Client, config.portalAddress);
    const rollup = new RollupContract(l1Client, await portal.getRollup());
    const portals = [
      await createClaimPortalConfig({
        portal,
        proverSubsidy: config.proverSubsidyAddress,
        adaptorDeps: { node, portal, rollup, signer: config.signer },
      }),
    ];
    const adaptors = portals.map(b => b.adaptor);

    const collector = await ProverClaimRewardCollector.create({
      proverId: config.proverId,
      portal,
      rollup,
      l1TxUtils: config.l1TxUtils,
      l1SubmissionBatcher: config.l1SubmissionBatcher,
      node,
      portals,
      priceOracle: config.priceOracle,
      minBatchProfit: config.minBatchProfit,
      trackerOptions: config.trackerOptions,
      claimBatchSubmitterOptions: config.claimBatchSubmitterOptions,
      log: config.log,
    });

    return new OxideProverClaimRewardCollector(collector, adaptors);
  }

  async start(): Promise<void> {
    await this.collector.start();
  }

  async stop(): Promise<void> {
    this.adaptors.forEach(adaptor => adaptor.stop());
    await this.collector.stop();
  }
}
