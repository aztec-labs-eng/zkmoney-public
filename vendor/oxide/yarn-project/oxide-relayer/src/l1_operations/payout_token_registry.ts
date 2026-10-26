import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';

import { depositPayoutTokenFor, depositTokensFor } from '@oxide/l1-contracts';
import { addressKey } from '@oxide/watcher-lib/address-key';

import type { ExtensiblePriceOracle } from '../price_oracle/price_oracle.js';

/** What an L1-operations worker needs: whether it accepts a payout token. The answer can change while it runs. */
export interface PayoutTokenFilter {
  accepts(token: EthAddress): boolean;
}

/** Makes each accepted token priceable, and refuses a token that it cannot price. */
type PayoutTokenPricer = Pick<ExtensiblePriceOracle, 'addToken'>;

export class PayoutTokenRegistry implements PayoutTokenFilter {
  /** The accepted tokens, by `addressKey`. */
  private readonly tokens = new Set<string>();
  /** True when the tokens are a configured list: `addDeployment` then adds no deployment tokens. */
  private ignoresDeploymentTokens = false;

  private constructor(
    private readonly pricer: PayoutTokenPricer,
    private readonly chainId: bigint,
    private readonly log: Logger,
  ) {}

  /**
   * Creates the registry. It adds each accepted token to `pricer`, so the workers can price gas in it.
   * @param `configuredTokens` If given, it is the fixed set of payout tokens and no more tokens will be added. When
   * it is undefined, the registry starts empty and every deployment's token should be added with `addDeployment`.
   */
  static async create(
    pricer: PayoutTokenPricer,
    configuredTokens: EthAddress[] | undefined,
    context: { chainId: bigint; log: Logger },
  ): Promise<PayoutTokenRegistry> {
    const registry = new PayoutTokenRegistry(pricer, context.chainId, context.log);
    if (configuredTokens) {
      if (configuredTokens.length === 0) {
        throw new Error('the configured payout tokens must contain at least one token');
      }
      await Promise.all(configuredTokens.map(token => pricer.addToken(token)));
      configuredTokens.forEach(token => registry.tokens.add(addressKey(token)));
      registry.ignoresDeploymentTokens = true;
    }
    return registry;
  }

  /**
   * Registers a deployment's token and the tokens that its deposit sweeps pay out in. Throws when the pricer refuses a
   * new token. Does nothing when a configured list is given.
   */
  async addDeployment(deployment: { label: string; token: EthAddress }): Promise<void> {
    if (this.ignoresDeploymentTokens) {
      return;
    }

    const added = this.tokensOf(deployment.token).filter(token => !this.accepts(token));
    await Promise.all(
      added.map(token =>
        this.pricer.addToken(token).catch((error: unknown) => {
          throw new Error(`deployment ${deployment.label}: ${error instanceof Error ? error.message : String(error)}`);
        }),
      ),
    );
    for (const token of added) {
      this.tokens.add(addressKey(token));
      this.log.info(
        `accepting ${token.toString()} as a payout token for every worker, from deployment ${deployment.label}`,
      );
    }
  }

  accepts(token: EthAddress): boolean {
    return this.tokens.has(addressKey(token));
  }

  /** The accepted tokens as lowercase addresses. */
  list(): string[] {
    return [...this.tokens];
  }

  /** A deployment's token and the tokens that its deposit sweeps pay out in. */
  private tokensOf(token: EthAddress): EthAddress[] {
    const sweeps = depositTokensFor(this.chainId, token).map(sent => depositPayoutTokenFor(this.chainId, sent));
    return unique([token, ...sweeps]);
  }
}

function unique(tokens: EthAddress[]): EthAddress[] {
  return tokens.filter((token, index) => tokens.findIndex(other => other.equals(token)) === index);
}
