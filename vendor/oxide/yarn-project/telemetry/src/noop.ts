import type {
  CounterMetricDefinition,
  GaugeMetricDefinition,
  HistogramMetricDefinition,
  ObservableGaugeMetricDefinition,
  UpDownCounterMetricDefinition,
} from './metric_definition.js';
import type {
  Counter,
  Gauge,
  Histogram,
  Meter,
  ObservableCallback,
  ObservableHandle,
  TelemetryClient,
  UpDownCounter,
} from './telemetry_client.js';

const NOOP_COUNTER = { add: () => undefined };
const NOOP_GAUGE = { record: () => undefined };
const NOOP_OBSERVABLE_HANDLE: ObservableHandle = { close: () => undefined };

class NoopMeter implements Meter {
  public createCounter<const Definition extends CounterMetricDefinition>(_definition: Definition): Counter<Definition> {
    return NOOP_COUNTER;
  }

  public createUpDownCounter<const Definition extends UpDownCounterMetricDefinition>(
    _definition: Definition,
  ): UpDownCounter<Definition> {
    return NOOP_COUNTER;
  }

  public createGauge<const Definition extends GaugeMetricDefinition>(_definition: Definition): Gauge<Definition> {
    return NOOP_GAUGE;
  }

  public createHistogram<const Definition extends HistogramMetricDefinition>(
    _definition: Definition,
  ): Histogram<Definition> {
    return NOOP_GAUGE;
  }

  public createObservableGauge<const Definition extends ObservableGaugeMetricDefinition>(
    _definition: Definition,
    _callback: ObservableCallback<Definition>,
  ): ObservableHandle {
    return NOOP_OBSERVABLE_HANDLE;
  }
}

const NOOP_METER = new NoopMeter();

export const NOOP_TELEMETRY_CLIENT: TelemetryClient = {
  isEnabled: () => false,
  getMeter: () => NOOP_METER,
  flush: () => Promise.resolve(),
  stop: () => Promise.resolve(),
};
