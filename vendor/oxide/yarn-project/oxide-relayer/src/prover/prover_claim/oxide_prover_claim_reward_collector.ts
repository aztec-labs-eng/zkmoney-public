import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Logger } from '@aztec-labs/foundation/log';

import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import type { RegisteredTeeSigner } from '@oxide/oxide-client/types.js';
import { createNodeClient } from '@oxide/oxide-lib/aztec_node_client.js';

import type { PublicClient } from 'viem';

import type { L1TxQueue } from '../../l1/l1_tx_queue.js';
import type { PriceOracle } from '../../price_oracle/price_oracle.js';
import { FinalizationRequestSource } from '../finalization_request_source.js';
import { FinalizationRequestWatcher } from '../finalization_request_watcher.js';
import {
  ClaimBatchSubmitterOptions,
  ProverClaimRewardCollector,
  TrackerOptions,
} from '../prover_claim_reward_collector/index.js';
import { createRollupContract } from '../rollup.js';
import { ProverClaimAdaptor } from './adaptor.js';
import { createClaimPortalConfig } from './portal_config.js';

export interface CollectorPortal {
  portalAddress: EthAddress;
  proverSubsidyAddress: EthAddress;
  /** The Broadcaster that the finalization requests of this portal come through. */
  broadcasterAddress: AztecAddress;
  /** TEE signer used to co-sign the withdrawal finalization embedded in each claim on this portal. */
  signer: RegisteredTeeSigner;
}

export interface OxideProverClaimRewardCollectorConfig {
  /** Address whose recorded first-prover captures are claimed, and the rewards recipient. */
  proverId: EthAddress;
  /** The portals to collect rewards from. */
  portals: CollectorPortal[];
  client: PublicClient;
  /**
   * Queue to submit through. The host shares one signer across subsystems, so every send goes on the one
   * queue and nonces cannot race. Its sender must be `proverId`.
   */
  l1TxQueue: Pick<L1TxQueue, 'enqueue' | 'address' | 'maxFeePerGasCap'>;
  nodeUrl: string;
  nodeApiKey?: string;
  priceOracle: PriceOracle;
  /** Minimum batch profit in USD, scaled to 18 decimals: a batch below it is not worth a tx. */
  minBatchProfit?: bigint;
  trackerOptions?: Partial<TrackerOptions>;
  claimBatchSubmitterOptions?: ClaimBatchSubmitterOptions;
  log?: Logger;
}

export class OxideProverClaimRewardCollector {
  private constructor(
    private readonly collector: ProverClaimRewardCollector,
    private readonly adaptors: ProverClaimAdaptor[],
    private readonly requestWatchers: FinalizationRequestWatcher[],
  ) {}

  static async create(config: OxideProverClaimRewardCollectorConfig): Promise<OxideProverClaimRewardCollector> {
    const l1Client = config.client;
    const node = createNodeClient({ url: config.nodeUrl, apiKey: config.nodeApiKey });
    if (config.portals.length === 0) {
      throw new Error('Prover claim collector needs at least one portal');
    }
    const contracts = config.portals.map(entry => new OxidePortalContract(l1Client, entry.portalAddress));
    const rollup = createRollupContract(l1Client, await contracts[0].getRollup());
    // The claims are built only after the proof lands. The watchers read each finalization request before then, while
    // the node still serves the initiation tx.
    const requestSources = await Promise.all(
      config.portals.map(
        async (entry, i) =>
          new FinalizationRequestSource(node, await contracts[i].getPortalDomain(), entry.broadcasterAddress),
      ),
    );
    const requestWatchers = requestSources.map(requestSource => new FinalizationRequestWatcher(node, requestSource));
    const portals = await Promise.all(
      config.portals.map((entry, i) =>
        createClaimPortalConfig({
          portal: contracts[i],
          proverSubsidy: entry.proverSubsidyAddress,
          adaptorDeps: { node, portal: contracts[i], requestSource: requestSources[i], rollup, signer: entry.signer },
        }),
      ),
    );
    const adaptors = portals.map(b => b.adaptor);

    const collector = await ProverClaimRewardCollector.create({
      proverId: config.proverId,
      rollup,
      client: config.client,
      l1TxQueue: config.l1TxQueue,
      node,
      portals,
      priceOracle: config.priceOracle,
      minBatchProfit: config.minBatchProfit,
      trackerOptions: config.trackerOptions,
      claimBatchSubmitterOptions: config.claimBatchSubmitterOptions,
      log: config.log,
    });

    return new OxideProverClaimRewardCollector(collector, adaptors, requestWatchers);
  }

  async start(): Promise<void> {
    await Promise.all(this.requestWatchers.map(watcher => watcher.start()));
    await this.collector.start();
  }

  async stop(): Promise<void> {
    this.adaptors.forEach(adaptor => adaptor.stop());
    await this.collector.stop();
    await Promise.all(this.requestWatchers.map(watcher => watcher.stop()));
  }
}
