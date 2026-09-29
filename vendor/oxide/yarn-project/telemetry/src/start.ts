import { createLogger } from '@aztec/foundation/log';

import {
  type ResolvedTelemetryConfig,
  type TelemetryConfig,
  resolveTelemetryConfig,
  telemetryConfigFingerprint,
} from './config.js';
import { NOOP_TELEMETRY_CLIENT } from './noop.js';
import type { TelemetryClient } from './telemetry_client.js';

const log = createLogger('oxide:telemetry');

async function createClient(config: ResolvedTelemetryConfig): Promise<TelemetryClient> {
  const { createOpenTelemetryClient } = await import('./otel.js');
  return createOpenTelemetryClient(config);
}

let client: TelemetryClient = NOOP_TELEMETRY_CLIENT;
let initialization: Promise<TelemetryClient> | undefined;
let initialFingerprint: string | undefined;
let warnedAboutDifferentConfig = false;

export function getTelemetry(): TelemetryClient {
  return client;
}

export function initTelemetry(config: TelemetryConfig): Promise<TelemetryClient> {
  const resolved = resolveTelemetryConfig(config, process.env, message => log.warn(message));
  const fingerprint = telemetryConfigFingerprint(resolved);

  if (initialization) {
    if (initialFingerprint !== fingerprint && !warnedAboutDifferentConfig) {
      warnedAboutDifferentConfig = true;
      log.warn(`Ignoring telemetry reinitialization with different configuration`);
    }
    return initialization;
  }

  initialFingerprint = fingerprint;
  initialization = initialize(resolved);
  return initialization;
}

async function initialize(config: ResolvedTelemetryConfig): Promise<TelemetryClient> {
  if (!config.enabled) {
    return client;
  }
  try {
    client = await createClient(config);
  } catch {
    log.warn(`Telemetry initialization failed; continuing with telemetry disabled`);
    client = NOOP_TELEMETRY_CLIENT;
  }
  return client;
}
