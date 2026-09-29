import type {
  AttributeArgs,
  CounterMetricDefinition,
  GaugeMetricDefinition,
  HistogramMetricDefinition,
  ObservableGaugeMetricDefinition,
  UpDownCounterMetricDefinition,
} from './metric_definition.js';

export interface Counter<Definition extends CounterMetricDefinition> {
  add(value: number, ...attributes: AttributeArgs<Definition>): void;
}

export interface UpDownCounter<Definition extends UpDownCounterMetricDefinition> {
  add(value: number, ...attributes: AttributeArgs<Definition>): void;
}

export interface Gauge<Definition extends GaugeMetricDefinition> {
  record(value: number, ...attributes: AttributeArgs<Definition>): void;
}

export interface Histogram<Definition extends HistogramMetricDefinition> {
  record(value: number, ...attributes: AttributeArgs<Definition>): void;
}

export interface ObservableResult<Definition extends ObservableGaugeMetricDefinition> {
  observe(value: number, ...attributes: AttributeArgs<Definition>): void;
}

export type ObservableCallback<Definition extends ObservableGaugeMetricDefinition> = (
  result: ObservableResult<Definition>,
) => void | Promise<void>;

export interface ObservableHandle {
  close(): void;
}

export interface Meter {
  createCounter<const Definition extends CounterMetricDefinition>(definition: Definition): Counter<Definition>;
  createUpDownCounter<const Definition extends UpDownCounterMetricDefinition>(
    definition: Definition,
  ): UpDownCounter<Definition>;
  createGauge<const Definition extends GaugeMetricDefinition>(definition: Definition): Gauge<Definition>;
  createHistogram<const Definition extends HistogramMetricDefinition>(definition: Definition): Histogram<Definition>;
  createObservableGauge<const Definition extends ObservableGaugeMetricDefinition>(
    definition: Definition,
    callback: ObservableCallback<Definition>,
  ): ObservableHandle;
}

export interface TelemetryClient {
  isEnabled(): boolean;
  getMeter(scope: string): Meter;
  flush(): Promise<void>;
  stop(): Promise<void>;
}
