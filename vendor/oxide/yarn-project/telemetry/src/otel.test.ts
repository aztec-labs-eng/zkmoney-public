import { createLogger } from '@aztec/foundation/log';

import { describe, expect, it } from '@jest/globals';
import { Resource } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MetricReader,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

import { HTTP_RESPONSE_STATUS_CODE, HTTP_ROUTE, TEE_ROUTER_OUTCOME } from './attributes.js';
import { resolveTelemetryConfig } from './config.js';
import {
  METRIC_DEFINITIONS,
  TEE_ROUTER_REQUEST_COUNT,
  TEE_ROUTER_REQUEST_DURATION,
  TEE_ROUTER_TARGET_ROUTABLE,
} from './metrics.js';
import { createOpenTelemetryClient } from './otel.js';

const REQUEST_ATTRIBUTES = {
  [HTTP_ROUTE.name]: '/rpc',
  [HTTP_RESPONSE_STATUS_CODE.name]: 200,
  [TEE_ROUTER_OUTCOME.name]: 'success',
} as const;

class FailingMetricReader extends MetricReader {
  protected onForceFlush(): Promise<void> {
    return Promise.reject(new Error('flush failed'));
  }

  protected onShutdown(): Promise<void> {
    return Promise.reject(new Error('shutdown failed'));
  }
}

function findMetric(resourceMetrics: ResourceMetrics, name: string) {
  return resourceMetrics.scopeMetrics.flatMap(scope => scope.metrics).find(metric => metric.descriptor.name === name);
}

describe('OpenTelemetry metrics client', () => {
  it('exports registered instruments with attributes and histogram boundaries', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const client = createOpenTelemetryClient(
      resolveTelemetryConfig({ serviceName: 'oxide-test', metricsEndpoint: 'http://collector:4318/v1/metrics' }, {}),
      {
        reader,
        resource: new Resource({ 'service.namespace': 'oxide', 'service.name': 'oxide-test' }),
        logger: createLogger('oxide:telemetry:test'),
        metricDefinitions: [...METRIC_DEFINITIONS],
      },
    );
    const meter = client.getMeter('oxide-test');
    meter.createCounter(TEE_ROUTER_REQUEST_COUNT).add(1, REQUEST_ATTRIBUTES);
    meter.createHistogram(TEE_ROUTER_REQUEST_DURATION).record(0.25, REQUEST_ATTRIBUTES);
    const observable = meter.createObservableGauge(TEE_ROUTER_TARGET_ROUTABLE, result => result.observe(3));
    await client.flush();

    const exported = exporter.getMetrics().at(-1)!;
    expect(exported.resource.attributes['service.name']).toBe('oxide-test');

    const count = findMetric(exported, TEE_ROUTER_REQUEST_COUNT.name);
    expect(count?.dataPointType).toBe(DataPointType.SUM);
    expect(count?.dataPoints[0]?.attributes).toEqual(REQUEST_ATTRIBUTES);
    expect(count?.dataPoints[0]?.value).toBe(1);

    const duration = findMetric(exported, TEE_ROUTER_REQUEST_DURATION.name);
    expect(duration?.dataPointType).toBe(DataPointType.HISTOGRAM);
    if (duration?.dataPointType === DataPointType.HISTOGRAM) {
      expect(duration.dataPoints[0]?.value.buckets.boundaries).toEqual(TEE_ROUTER_REQUEST_DURATION.histogramBoundaries);
    }

    expect(findMetric(exported, TEE_ROUTER_TARGET_ROUTABLE.name)?.dataPoints[0]?.value).toBe(3);

    observable.close();
    await client.stop();
  });

  it('drops invalid measurements before they reach the SDK', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const client = createOpenTelemetryClient(
      resolveTelemetryConfig({ serviceName: 'oxide-test', metricsEndpoint: 'http://collector:4318/v1/metrics' }, {}),
      { reader, resource: new Resource({ 'service.name': 'oxide-test' }) },
    );
    client
      .getMeter('oxide-test')
      .createCounter(TEE_ROUTER_REQUEST_COUNT)
      .add(1, { ...REQUEST_ATTRIBUTES, ['request_id']: 'must-not-export' } as never);
    await client.flush();
    const exported = exporter.getMetrics().at(-1)!;
    expect(findMetric(exported, TEE_ROUTER_REQUEST_COUNT.name)).toBeUndefined();
    await client.stop();
  });

  it('contains reader flush and shutdown failures', async () => {
    const client = createOpenTelemetryClient(
      resolveTelemetryConfig({ serviceName: 'oxide-test', metricsEndpoint: 'http://collector:4318/v1/metrics' }, {}),
      { reader: new FailingMetricReader(), resource: new Resource({ 'service.name': 'oxide-test' }) },
    );
    await expect(client.flush()).resolves.toBeUndefined();
    await expect(client.stop()).resolves.toBeUndefined();
  });
});
