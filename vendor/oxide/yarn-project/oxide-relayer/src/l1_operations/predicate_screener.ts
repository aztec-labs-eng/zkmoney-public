import { EthAddress } from '@aztec/foundation/eth-address';
import { Logger, createLogger } from '@aztec/foundation/log';

const SANCTIONS_SCREENER__BASE_URL = 'https://api.predicate.io';
const SANCTIONS_SCREENER__TIMEOUT_MS = 5_000;

export interface PredicateScreenerConfig {
  /** Predicate `x-api-key`. */
  apiKey: string;
  /** Managed policy id (`x-managed-policy-…`) sent as `verification_hash`; defines what counts as sanctioned. */
  verificationHash: string;
  /** Predicate chain name, e.g. `ethereum-mainnet`, sent as `chain`. */
  chain: string;
  /** Predicate API base. Default SANCTIONS_SCREENER__BASE_URL. */
  baseUrl?: string;
  /** Per-request timeout. Default SANCTIONS_SCREENER__TIMEOUT_MS. */
  timeoutMs?: number;
  log?: Logger;
}

interface Verdict {
  compliant: boolean;
  expiresAt: number;
}

export class PredicateScreener {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private readonly cache = new Map<string, Verdict>();

  constructor(private readonly config: PredicateScreenerConfig) {
    this.baseUrl = config.baseUrl ?? SANCTIONS_SCREENER__BASE_URL;
    this.timeoutMs = config.timeoutMs ?? SANCTIONS_SCREENER__TIMEOUT_MS;
    this.log = config.log ?? createLogger('atlatl:predicate-screener');
  }

  async isCompliant(address: EthAddress): Promise<boolean> {
    const key = address.toString().toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.compliant;
    }

    const { compliant, expiresAt } = await this.attest(address);
    // Cache the verdict until the attestation expires.
    this.cache.set(key, { compliant, expiresAt });
    return compliant;
  }

  private async attest(address: EthAddress): Promise<{ compliant: boolean; expiresAt: number }> {
    const response = await fetch(`${this.baseUrl}/v2/attestation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.config.apiKey },
      body: JSON.stringify({
        // eslint-disable-next-line camelcase
        verification_hash: this.config.verificationHash,
        from: address.toString(),
        chain: this.config.chain,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Predicate attestation returned ${response.status}`);
    }
    const body = (await response.json()) as { is_compliant: boolean; attestation: { expiration: number } };
    // Predicate reports the expiry in unix seconds.
    return { compliant: body.is_compliant, expiresAt: body.attestation.expiration * 1000 };
  }
}
