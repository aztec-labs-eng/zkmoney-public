export const RESOURCE_ATTRIBUTE_NAMES = ['deployment.environment.name', 'service.instance.id'] as const;

export type AdditionalResourceAttribute = (typeof RESOURCE_ATTRIBUTE_NAMES)[number];

export interface TelemetryConfig {
  /** Stable service name, for example `oxide-tee-router`. */
  readonly serviceName: string;
  readonly serviceVersion?: string;
  /** Explicit OTLP/HTTP metrics URL. Standard OTEL exporter env vars are preferred in deployments. */
  readonly metricsEndpoint?: string;
  readonly exportIntervalMs?: number;
  readonly exportTimeoutMs?: number;
  readonly resourceAttributes?: Partial<Record<AdditionalResourceAttribute, string>>;
}

export interface ResolvedTelemetryConfig {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly programmaticMetricsEndpoint?: string;
  readonly endpointConfigured: boolean;
  readonly exportIntervalMs: number;
  readonly exportTimeoutMs: number;
  readonly resourceAttributes: Partial<Record<AdditionalResourceAttribute, string>>;
}

const DEFAULT_EXPORT_INTERVAL_MS = 60_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 30_000;

function positiveInteger(
  explicit: number | undefined,
  environment: string | undefined,
  fallback: number,
  variableName: string,
  warn: (message: string) => void,
): number {
  const value = explicit ?? (environment === undefined ? undefined : Number(environment));
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    warn(`Ignoring invalid ${variableName}; expected a positive integer`);
    return fallback;
  }
  return value;
}

function isSdkDisabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function validEndpoint(endpoint: string | undefined, warn: (message: string) => void): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    return url.toString();
  } catch {
    warn(`Ignoring invalid programmatic OTLP metrics endpoint`);
    return undefined;
  }
}

export function resolveTelemetryConfig(
  config: TelemetryConfig,
  environment: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = () => undefined,
): ResolvedTelemetryConfig {
  const serviceName = config.serviceName.trim() || environment.OTEL_SERVICE_NAME?.trim();
  const programmaticMetricsEndpoint = validEndpoint(config.metricsEndpoint, warn);
  const environmentEndpointConfigured = Boolean(
    environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim() || environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim(),
  );
  const exportIntervalMs = positiveInteger(
    config.exportIntervalMs,
    environment.OTEL_METRIC_EXPORT_INTERVAL,
    DEFAULT_EXPORT_INTERVAL_MS,
    'OTEL_METRIC_EXPORT_INTERVAL',
    warn,
  );
  const configuredTimeout = positiveInteger(
    config.exportTimeoutMs,
    environment.OTEL_METRIC_EXPORT_TIMEOUT,
    DEFAULT_EXPORT_TIMEOUT_MS,
    'OTEL_METRIC_EXPORT_TIMEOUT',
    warn,
  );
  const exportTimeoutMs = Math.min(configuredTimeout, exportIntervalMs);
  if (configuredTimeout > exportIntervalMs) {
    warn(`Clamping metric export timeout to the export interval`);
  }
  if (!serviceName) {
    warn(`Telemetry is disabled because serviceName is empty`);
  }

  const endpointConfigured = Boolean(programmaticMetricsEndpoint || environmentEndpointConfigured);
  return {
    enabled: Boolean(serviceName && endpointConfigured && !isSdkDisabled(environment.OTEL_SDK_DISABLED)),
    serviceName: serviceName ?? 'unknown-oxide-service',
    serviceVersion: config.serviceVersion,
    programmaticMetricsEndpoint,
    endpointConfigured,
    exportIntervalMs,
    exportTimeoutMs,
    resourceAttributes: { ...config.resourceAttributes },
  };
}

export function telemetryConfigFingerprint(config: ResolvedTelemetryConfig): string {
  return JSON.stringify({
    enabled: config.enabled,
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    programmaticMetricsEndpoint: config.programmaticMetricsEndpoint,
    endpointConfigured: config.endpointConfigured,
    exportIntervalMs: config.exportIntervalMs,
    exportTimeoutMs: config.exportTimeoutMs,
    resourceAttributes: Object.entries(config.resourceAttributes).sort(([left], [right]) => left.localeCompare(right)),
  });
}
