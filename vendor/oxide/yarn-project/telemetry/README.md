# @oxide/telemetry

Oxide's metrics-only OpenTelemetry client. It exposes a typed API over the shared metric registry in this package and
exports OTLP/HTTP when an endpoint is configured.
With no endpoint configured, or with `OTEL_SDK_DISABLED=true`, it returns a no-op client.

## Using the client

```ts
import { Attributes, Metrics, initTelemetry } from '@oxide/telemetry';

const telemetry = await initTelemetry({
  serviceName: 'oxide-tee-router',
  serviceVersion,
});

const meter = telemetry.getMeter('oxide-tee-router');
const requests = meter.createCounter(Metrics.TEE_ROUTER_REQUEST_COUNT);

requests.add(1, {
  [Attributes.HTTP_ROUTE.name]: '/rpc',
  [Attributes.HTTP_RESPONSE_STATUS_CODE.name]: 200,
  [Attributes.TEE_ROUTER_OUTCOME.name]: 'success',
});
```

Initialize once during service startup. Call `flush()` when a best-effort export is useful and `stop()` during
graceful shutdown. Initialization, recording, flushing, and stopping contain telemetry failures rather than throwing
them into application request or shutdown paths.

## Configuration

Configure deployments with the standard OpenTelemetry environment variables. Where two variables are listed, the
metrics-specific variable takes precedence over the general one:

- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (full URL), or `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL, exporter
  appends `/v1/metrics`)
- `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, or `OTEL_EXPORTER_OTLP_HEADERS`
- `OTEL_EXPORTER_OTLP_METRICS_TIMEOUT`, or `OTEL_EXPORTER_OTLP_TIMEOUT`
- `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`
- `OTEL_METRIC_EXPORT_INTERVAL` (default: 60 seconds)
- `OTEL_METRIC_EXPORT_TIMEOUT` (default: 30 seconds)
- `OTEL_SDK_DISABLED`

`initTelemetry` also accepts programmatic options (`metricsEndpoint`, `exportIntervalMs`, `exportTimeoutMs`). These
exist for tests and special setups, and they take precedence over the environment variables. A programmatic endpoint
must be an HTTP(S) OTLP metrics URL.

Resources always identify `service.namespace=oxide`, the service name, and a generated service instance ID. Service
version and the allowlisted `deployment.environment.name` may also be supplied.

## CloudWatch representation

The exporter uses delta temporality, fixed in this package (posting interval diff rather than total values). The backend is CloudWatch EMF (through the env's
collector), where delta preserves the first observation of rare counters and makes histogram statistics
per-interval. Two consequences to know when you read the data in CloudWatch:

- Histograms arrive as interval count/sum/min/max statistic sets, not buckets. CloudWatch cannot compute p95/p99
  from them. Use Average, Minimum, Maximum, and SampleCount; percentile needs are a dashboard-delivery concern.
- "Current value" signals must be gauges. Do not use up-down counters: awsemf renders their running totals as
  per-interval deltas, which turns a level into a rate of change.

## Adding metrics

Metric and attribute definitions live in `src/metrics.ts` and `src/attributes.ts`. New definitions need:

- a stable dotted `oxide.<component>.<signal>` metric name, description, unit, value type, and instrument kind
- required and optional attributes with a privacy and cardinality note
- finite string/boolean attribute domains, or a validator with an explicit cardinality ceiling
- ascending explicit boundaries for histograms

Do not add raw paths, request IDs, account/TEE/task identifiers, IP addresses, error messages, transaction hashes, or
other unbounded or private values as metric attributes. Use structured logs for those and correlate by time and service.

Upstream failure logs: the tee-router warn log on upstream failure includes the failing enclave's `teeAddress` so
operators know which host broke. The normal per-request completion log omits it.

The wrappers validate measurements again at runtime. Missing, unknown, wrong-type, out-of-domain, or
over-cardinality attributes drop the whole measurement and log a warning without the rejected value.
