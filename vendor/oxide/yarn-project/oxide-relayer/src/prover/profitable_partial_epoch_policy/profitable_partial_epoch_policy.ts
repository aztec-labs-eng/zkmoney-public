import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';

import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import type { SubmitEpochProofGasModel } from '@oxide/oxide-client/partial_epoch_proof_profit.js';

import type { PublicClient } from 'viem';

import { ChainlinkPriceOracle } from '../../price_oracle/chainlink_price_oracle.js';
import { ProverClaimDiscoverer } from '../prover_claim_lib/prover_claim_discoverer.js';
import { createRollupContract } from '../rollup.js';
import { Binding } from '../types.js';
import * as config from './config.js';
import { EpochProfitTracker } from './epoch_profit_tracker.js';
import {
  EarlySubmitPolicy,
  EarlySubmitPortalConfig,
  PartialProofDecision,
  PartialProofPolicy,
  PartialProofPolicyInput,
} from './types.js';

export interface ProfitablePartialEpochPolicyCreateOptions {
  portal?: OxidePortalContract;
  portalAddress?: EthAddress;
  portals: EarlySubmitPortalConfig[];
  priceOracle: ChainlinkPriceOracle;
  l1Client?: PublicClient;
  earlySubmitPolicy?: Partial<EarlySubmitPolicy>;
  submitEpochProofGasModel?: SubmitEpochProofGasModel;
}

export interface ProfitablePartialEpochPolicyOptions extends Omit<
  ProfitablePartialEpochPolicyCreateOptions,
  'l1Client' | 'portalAddress'
> {
  binding: Binding;
  portal: OxidePortalContract;
}

/**
 * Partial-proof policy that submits a proof for an epoch's canonical prefix only when proving it and
 * claiming its prover-tipped messages is profitable.
 */
export class ProfitablePartialEpochPolicy implements PartialProofPolicy {
  readonly tracker: EpochProfitTracker;

  constructor(options: ProfitablePartialEpochPolicyOptions) {
    const discoverer = new ProverClaimDiscoverer({ binding: options.binding, portals: options.portals });

    this.tracker = new EpochProfitTracker({
      discoverer,
      portal: options.portal,
      portals: options.portals,
      priceOracle: options.priceOracle,
      getEffectiveGasPriceWei: () => options.portal.client.getGasPrice(),
      minEpochProfit: options.earlySubmitPolicy?.minEpochProfit ?? config.EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT,
      minEpochProfitMarginBps:
        options.earlySubmitPolicy?.minEpochProfitMarginBps ?? config.EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT_MARGIN_BPS,
      provingCostPerCheckpoint:
        options.earlySubmitPolicy?.provingCostPerCheckpoint ?? config.EARLY_SUBMIT_POLICY__PROVING_COST_PER_CHECKPOINT,
      submitEpochProofGasModel: options.submitEpochProofGasModel ?? config.ROLLUP__SUBMIT_EPOCH_PROOF_GAS_MODEL,
    });
  }

  static async create(options: ProfitablePartialEpochPolicyCreateOptions): Promise<ProfitablePartialEpochPolicy> {
    let portal = options.portal;
    if (!portal) {
      if (!options.l1Client) {
        throw new Error('l1Client is required when portal is not provided');
      }
      if (!options.portalAddress) {
        throw new Error('portalAddress is required when portal is not provided');
      }
      portal = new OxidePortalContract(options.l1Client, options.portalAddress);
    }

    const l1Client = portal.client;
    const rollup = createRollupContract(l1Client, await portal.getRollup());
    const [rollupVersion, chainId, epochDuration] = await Promise.all([
      rollup.getVersion(),
      l1Client.getChainId(),
      rollup.getEpochDuration(),
    ]);
    const binding = {
      rollupVersion: new Fr(rollupVersion),
      chainId: new Fr(chainId),
      epochDuration,
    };

    return new ProfitablePartialEpochPolicy({
      ...options,
      portal,
      binding,
    });
  }

  shouldSubmit(input: PartialProofPolicyInput): Promise<PartialProofDecision> {
    return this.tracker.evaluate(input.epoch, input.checkpoints);
  }
}
