import { createLogger } from '@aztec-labs/foundation/log';

import { initTelemetry } from '@oxide/telemetry';

import { loadAwsSecrets } from './aws_secrets.js';
import { loadConfig } from './config.js';
import { ResolverTelemetry } from './resolver_telemetry.js';

const log = createLogger('oxide:resolver');

type Stoppable = { stop: () => Promise<void> };

const TELEMETRY_STOP_MS = 5_000;
const SERVICE_NAMES = { gateway: 'oxide-resolver-gateway', local: 'oxide-resolver' };

let stopTelemetry: () => Promise<void> = () => Promise.resolve();

async function start(): Promise<Stoppable> {
  await loadAwsSecrets();
  const config = loadConfig();
  const telemetryClient = await initTelemetry({
    serviceName: SERVICE_NAMES[config.mode],
    // Lets each operator's alarms read only its own series.
    resourceAttributes: config.operatorId ? { 'oxide.resolver.operator_id': config.operatorId } : {},
  });
  stopTelemetry = () => telemetryClient.stop();
  const telemetry = new ResolverTelemetry(telemetryClient);
  const { runGateway } = await import('./gateway_runner.js');
  return runGateway(config, telemetry);
}

async function main(): Promise<void> {
  const service = await start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    await service.stop();
    await Promise.race([stopTelemetry(), new Promise<void>(resolve => setTimeout(resolve, TELEMETRY_STOP_MS).unref())]);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(err => {
  log.error(`fatal: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
