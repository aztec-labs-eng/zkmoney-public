export * as Attributes from './attributes.js';
export type { TelemetryConfig } from './config.js';
export * as Metrics from './metrics.js';
export { getTelemetry, initTelemetry } from './start.js';
export type {
  Counter,
  Gauge,
  Histogram,
  Meter,
  ObservableHandle,
  TelemetryClient,
  UpDownCounter,
} from './telemetry_client.js';
