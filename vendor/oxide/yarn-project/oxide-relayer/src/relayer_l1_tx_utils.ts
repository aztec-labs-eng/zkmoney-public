import {
  type GasPrice,
  type L1BlobInputs,
  type L1SignerSource,
  type L1TxConfig,
  type L1TxRequest,
  type L1TxState,
  L1TxUtils,
  type L1TxUtilsConfig,
  type SigningCallback,
  TxUtilsState,
  resolveSignerSource,
} from '@aztec/ethereum/l1-tx-utils';
import type { ViemClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import type { Hex, TransactionReceipt } from 'viem';

const PROTECT_TX_STATUS_TIMEOUT_MS = 5_000;

/** A broadcast transaction and the monitor that observes its terminal result. */
export interface SentL1Tx {
  txHash: Hex;
  state: L1TxState;
  settled: Promise<TransactionReceipt>;
}

export interface ProtectTxStatus {
  status: string;
  simError?: string;
  isRevert?: boolean;
}

export interface RelayerL1TxUtilsOptions {
  client: ViemClient;
  address: EthAddress;
  signer: SigningCallback;
  config?: Partial<L1TxUtilsConfig>;
  protectTxStatusUrl?: string;
}

/**
 * L1 transaction utility for relayer flows that share one signer.
 *
 * Broadcasts are serialized for nonce safety, but transaction monitors do not block later broadcasts.
 */
export class RelayerL1TxUtils extends L1TxUtils {
  /** Resolves when the in-flight broadcast finishes. The next send waits on this, not on mining. */
  private lastBroadcast: Promise<void> = Promise.resolve();
  private gasPriceOverride: GasPrice | undefined;
  private readonly protectTxStatusUrl: string | undefined;

  constructor(options: RelayerL1TxUtilsOptions) {
    super(options.client, options.address, options.signer, undefined, undefined, options.config, false);
    this.protectTxStatusUrl = options.protectTxStatusUrl;
  }

  hasProtectTxStatusEndpoint(): boolean {
    return this.protectTxStatusUrl !== undefined;
  }

  async getProtectTxStatus(txHash: Hex): Promise<ProtectTxStatus | undefined> {
    if (!this.protectTxStatusUrl) {
      return undefined;
    }
    const response = await fetch(`${this.protectTxStatusUrl}${txHash}`, {
      signal: AbortSignal.timeout(PROTECT_TX_STATUS_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Protect tx-status request failed with HTTP ${response.status}`);
    }
    return (await response.json()) as ProtectTxStatus;
  }

  override getGasPrice(
    gasConfigOverrides?: L1TxUtilsConfig,
    isBlobTx: boolean = false,
    attempt: number = 0,
    previousGasPrice?: GasPrice,
  ): Promise<GasPrice> {
    if (this.gasPriceOverride && attempt === 0 && previousGasPrice === undefined) {
      return Promise.resolve(this.gasPriceOverride);
    }
    return super.getGasPrice(gasConfigOverrides, isBlobTx, attempt, previousGasPrice);
  }

  override sendTransaction(
    request: L1TxRequest,
    gasConfigOverrides?: L1TxConfig,
    blobInputs?: L1BlobInputs,
    stateChange?: TxUtilsState,
  ): Promise<SentL1Tx> {
    return this.sendInOrder(() => super.sendTransaction(request, gasConfigOverrides, blobInputs, stateChange));
  }

  sendTransactionWithGasPrice(
    request: L1TxRequest,
    gasConfigOverrides: L1TxConfig | undefined,
    gasPrice: GasPrice,
  ): Promise<SentL1Tx> {
    return this.sendInOrder(async () => {
      this.gasPriceOverride = gasPrice;
      try {
        return await super.sendTransaction(request, gasConfigOverrides);
      } finally {
        this.gasPriceOverride = undefined;
      }
    });
  }

  /**
   * Broadcasts one transaction after the previous broadcast, then returns while the monitor still runs.
   * A failed broadcast also releases the next sender.
   */
  private async sendInOrder(broadcast: () => Promise<{ txHash: Hex; state: L1TxState }>): Promise<SentL1Tx> {
    const previousBroadcast = this.lastBroadcast;
    let markBroadcastDone = () => {};
    this.lastBroadcast = new Promise<void>(resolve => {
      markBroadcastDone = resolve;
    });

    await previousBroadcast;
    try {
      const { txHash, state } = await broadcast();
      const settled = this.monitorTransaction(state);
      // Callers observe monitor failures through `settled`. This catch only prevents an unhandled rejection.
      void settled.catch(() => {});
      return { txHash, state, settled };
    } finally {
      markBroadcastDone();
    }
  }
}

export function createRelayerL1TxUtils(
  wallet: L1SignerSource,
  config?: Partial<L1TxUtilsConfig>,
  protectTxStatusUrl?: string,
): RelayerL1TxUtils {
  const { client, address, signingCallback } = resolveSignerSource(wallet);
  return new RelayerL1TxUtils({
    client,
    address,
    signer: signingCallback,
    config: { ...config, cancelTxOnTimeout: false },
    protectTxStatusUrl,
  });
}
