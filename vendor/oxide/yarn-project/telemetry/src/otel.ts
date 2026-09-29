import { type Logger, createLogger } from '@aztec/foundation/log';

import { type Attributes as OtelAttributes, type Meter as OtelMeter, ValueType } from '@opentelemetry/api';
import { AggregationTemporalityPreference, OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import type { IResource } from '@opentelemetry/resources';
import { MeterProvider, type MetricReader, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

import type { ResolvedTelemetryConfig } from './config.js';
import { MeasurementValidator } from './measurement_validator.js';
import type {
  AnyMetricDefinition,
  CounterMetricDefinition,
  GaugeMetricDefinition,
  HistogramMetricDefinition,
  ObservableGaugeMetricDefinition,
  UpDownCounterMetricDefinition,
} from './metric_definition.js';
import { METRIC_DEFINITIONS } from './metrics.js';
import { NOOP_TELEMETRY_CLIENT } from './noop.js';
import { buildResource } from './resource.js';
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

export interface OpenTelemetryDependencies {
  readonly reader?: MetricReader;
  readonly resource?: IResource;
  readonly logger?: Logger;
  readonly metricDefinitions?: readonly AnyMetricDefinition[];
}

const NOOP_ADD_INSTRUMENT = { add: (_value: number, _attributes?: OtelAttributes) => undefined };
const NOOP_RECORD_INSTRUMENT = { record: (_value: number, _attributes?: OtelAttributes) => undefined };
const NOOP_OBSERVABLE_INSTRUMENT = {
  addCallback: (_callback: unknown) => undefined,
  removeCallback: (_callback: unknown) => undefined,
};

function options(definition: AnyMetricDefinition) {
  return {
    description: definition.description,
    unit: definition.unit,
    valueType: definition.valueType === 'int' ? ValueType.INT : ValueType.DOUBLE,
  };
}

class OpenTelemetryMeter implements Meter {
  private readonly instruments = new Map<string, unknown>();

  public constructor(
    private readonly meter: OtelMeter,
    private readonly validator: MeasurementValidator,
    private readonly log: Logger,
    private readonly registeredMetrics: ReadonlySet<AnyMetricDefinition>,
  ) {}

  public createCounter<const Definition extends CounterMetricDefinition>(definition: Definition): Counter<Definition> {
    const instrument = this.cached(
      `counter:${definition.name}`,
      definition,
      () => this.meter.createCounter(definition.name, options(definition)),
      NOOP_ADD_INSTRUMENT,
    );
    return {
      add: (value, ...attributes) => {
        const sanitized = this.validator.sanitize(definition, value, attributes[0]);
        if (sanitized) {
          this.safeRecord(definition.name, () => instrument.add(value, sanitized as OtelAttributes));
        }
      },
    };
  }

  public createUpDownCounter<const Definition extends UpDownCounterMetricDefinition>(
    definition: Definition,
  ): UpDownCounter<Definition> {
    const instrument = this.cached(
      `up-down-counter:${definition.name}`,
      definition,
      () => this.meter.createUpDownCounter(definition.name, options(definition)),
      NOOP_ADD_INSTRUMENT,
    );
    return {
      add: (value, ...attributes) => {
        const sanitized = this.validator.sanitize(definition, value, attributes[0]);
        if (sanitized) {
          this.safeRecord(definition.name, () => instrument.add(value, sanitized as OtelAttributes));
        }
      },
    };
  }

  public createGauge<const Definition extends GaugeMetricDefinition>(definition: Definition): Gauge<Definition> {
    const instrument = this.cached(
      `gauge:${definition.name}`,
      definition,
      () => this.meter.createGauge(definition.name, options(definition)),
      NOOP_RECORD_INSTRUMENT,
    );
    return {
      record: (value, ...attributes) => {
        const sanitized = this.validator.sanitize(definition, value, attributes[0]);
        if (sanitized) {
          this.safeRecord(definition.name, () => instrument.record(value, sanitized as OtelAttributes));
        }
      },
    };
  }

  public createHistogram<const Definition extends HistogramMetricDefinition>(
    definition: Definition,
  ): Histogram<Definition> {
    const instrument = this.cached(
      `histogram:${definition.name}`,
      definition,
      () =>
        this.meter.createHistogram(definition.name, {
          description: definition.description,
          unit: definition.unit,
          valueType: definition.valueType === 'int' ? ValueType.INT : ValueType.DOUBLE,
          advice: { explicitBucketBoundaries: [...(definition.histogramBoundaries ?? [])] },
        }),
      NOOP_RECORD_INSTRUMENT,
    );
    return {
      record: (value, ...attributes) => {
        const sanitized = this.validator.sanitize(definition, value, attributes[0]);
        if (sanitized) {
          this.safeRecord(definition.name, () => instrument.record(value, sanitized as OtelAttributes));
        }
      },
    };
  }

  public createObservableGauge<const Definition extends ObservableGaugeMetricDefinition>(
    definition: Definition,
    callback: ObservableCallback<Definition>,
  ): ObservableHandle {
    const instrument = this.cached(
      `observable-gauge:${definition.name}`,
      definition,
      () => this.meter.createObservableGauge(definition.name, options(definition)),
      NOOP_OBSERVABLE_INSTRUMENT,
    );
    const wrappedCallback = async (result: { observe(value: number, attributes?: OtelAttributes): void }) => {
      try {
        await callback({
          observe: (value, ...attributes) => {
            const sanitized = this.validator.sanitize(definition, value, attributes[0]);
            if (sanitized) {
              result.observe(value, sanitized as OtelAttributes);
            }
          },
        });
      } catch {
        this.log.warn(`Telemetry observable callback failed`, { metric: definition.name });
      }
    };
    instrument.addCallback(wrappedCallback);

    let closed = false;
    return {
      close: () => {
        if (!closed) {
          instrument.removeCallback(wrappedCallback);
          closed = true;
        }
      },
    };
  }

  private cached<Value>(key: string, definition: AnyMetricDefinition, create: () => Value, fallback: Value): Value {
    const existing = this.instruments.get(key);
    if (existing) {
      return existing as Value;
    }
    if (!this.registeredMetrics.has(definition)) {
      this.log.warn(`Ignoring unregistered telemetry metric`, { metric: definition.name });
      this.instruments.set(key, fallback);
      return fallback;
    }
    try {
      const instrument = create();
      this.instruments.set(key, instrument);
      return instrument;
    } catch {
      this.log.warn(`Unable to create OpenTelemetry instrument`, { metric: definition.name });
      this.instruments.set(key, fallback);
      return fallback;
    }
  }

  private safeRecord(metric: string, record: () => void): void {
    try {
      record();
    } catch {
      this.log.warn(`OpenTelemetry rejected a metric measurement`, { metric });
    }
  }
}

class OpenTelemetryClient implements TelemetryClient {
  private readonly meters = new Map<string, Meter>();
  private readonly validator: MeasurementValidator;
  private stopPromise: Promise<void> | undefined;

  public constructor(
    private readonly provider: MeterProvider,
    private readonly log: Logger,
    private readonly registeredMetrics: ReadonlySet<AnyMetricDefinition>,
  ) {
    this.validator = new MeasurementValidator(log);
  }

  public isEnabled(): boolean {
    return !this.stopPromise;
  }

  public getMeter(scope: string): Meter {
    if (this.stopPromise) {
      return NOOP_TELEMETRY_CLIENT.getMeter(scope);
    }
    const existing = this.meters.get(scope);
    if (existing) {
      return existing;
    }
    try {
      const meter = new OpenTelemetryMeter(
        this.provider.getMeter(scope),
        this.validator,
        this.log,
        this.registeredMetrics,
      );
      this.meters.set(scope, meter);
      return meter;
    } catch {
      this.log.warn(`Unable to create OpenTelemetry meter`);
      return NOOP_TELEMETRY_CLIENT.getMeter(scope);
    }
  }

  public async flush(): Promise<void> {
    if (this.stopPromise) {
      return;
    }
    try {
      await this.provider.forceFlush();
    } catch {
      this.log.warn(`Unable to flush telemetry`);
    }
  }

  public stop(): Promise<void> {
    this.stopPromise ??= this.shutdown();
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    try {
      await this.provider.forceFlush();
    } catch {
      this.log.warn(`Unable to flush telemetry during shutdown`);
    }
    try {
      await this.provider.shutdown();
    } catch {
      this.log.warn(`Unable to shut down telemetry`);
    }
  }
}

export function createOpenTelemetryClient(
  config: ResolvedTelemetryConfig,
  dependencies: OpenTelemetryDependencies = {},
): TelemetryClient {
  const log = dependencies.logger ?? createLogger('oxide:telemetry');
  // Delta temporality for CloudWatch EMF. Up-down counters still export cumulatively per the OTel spec.
  const exporter = dependencies.reader
    ? undefined
    : new OTLPMetricExporter({
        temporalityPreference: AggregationTemporalityPreference.DELTA,
        ...(config.programmaticMetricsEndpoint ? { url: config.programmaticMetricsEndpoint } : {}),
      });
  const reader =
    dependencies.reader ??
    new PeriodicExportingMetricReader({
      exporter: exporter!,
      exportIntervalMillis: config.exportIntervalMs,
      exportTimeoutMillis: config.exportTimeoutMs,
    });
  const provider = new MeterProvider({
    resource: dependencies.resource ?? buildResource(config),
    readers: [reader],
  });
  return new OpenTelemetryClient(provider, log, new Set(dependencies.metricDefinitions ?? METRIC_DEFINITIONS));
}
