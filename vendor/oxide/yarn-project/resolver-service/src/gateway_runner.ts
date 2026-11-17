import { redactedHttp } from '@oxide/oxide-lib/redacted_http.js';

import { createPublicClient } from 'viem';

import type { ResolverConfig } from './config.js';
import { createStore } from './create_store.js';
import { type RunningGateway, startGateway } from './gateway.js';
import { createRateLimiter } from './memory_rate_limiter.js';
import type { ResolverTelemetry } from './resolver_telemetry.js';

/** The CCIP gateway with its nonce store and rate limiter. */
export type RunningGatewayService = {
  gateway: RunningGateway;
  stop: () => Promise<void>;
};

export async function runGateway(
  config: ResolverConfig,
  telemetry?: ResolverTelemetry,
): Promise<RunningGatewayService> {
  const store = await createStore(config);
  try {
    const rateLimiter = await createRateLimiter(config.requestsPerHour, config.redisUrl, config.dbSchema);
    const publicClient = createPublicClient({ transport: redactedHttp(config.l1RpcUrl) });
    const gateway = await startGateway(config, store, rateLimiter, publicClient, { telemetry }).catch(err => {
      rateLimiter.close();
      throw err;
    });
    return {
      gateway,
      stop: async () => {
        await gateway.close();
        rateLimiter.close();
        await store.close();
      },
    };
  } catch (err) {
    await store.close();
    throw err;
  }
}
