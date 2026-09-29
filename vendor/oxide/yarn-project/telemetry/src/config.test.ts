import { describe, expect, it } from '@jest/globals';

import { resolveTelemetryConfig } from './config.js';

describe('resolveTelemetryConfig', () => {
  it('is disabled without a configured endpoint', () => {
    const config = resolveTelemetryConfig({ serviceName: 'oxide-test' }, {});
    expect(config.enabled).toBe(false);
  });

  it('uses standard OTEL environment configuration', () => {
    const config = resolveTelemetryConfig(
      { serviceName: 'oxide-test' },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_METRIC_EXPORT_INTERVAL: '15000',
        OTEL_METRIC_EXPORT_TIMEOUT: '5000',
      },
    );
    expect(config.enabled).toBe(true);
    expect(config.exportIntervalMs).toBe(15_000);
    expect(config.exportTimeoutMs).toBe(5_000);
  });
});
