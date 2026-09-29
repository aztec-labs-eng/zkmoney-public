export type AttributeValue = string | number | boolean;
export type AttributeValueType = 'string' | 'number' | 'boolean';
export type MetricKind = 'counter' | 'gauge' | 'histogram' | 'observable-gauge' | 'up-down-counter';
export type MetricValueType = 'double' | 'int';

const METRIC_DEFINITION = Symbol('oxide.telemetry.metric-definition');

export interface AttributeDefinition<Name extends string = string, Value extends AttributeValue = AttributeValue> {
  readonly name: Name;
  readonly description: string;
  readonly valueType: AttributeValueType;
  readonly allowedValues?: readonly Value[];
  readonly validate?: (value: AttributeValue) => boolean;
  readonly cardinalityLimit?: number;
  readonly privacy: string;
  /** Type-only marker used to retain the attribute's narrow value type. */
  readonly _value?: Value;
}

export type AnyAttributeDefinition = AttributeDefinition<string, AttributeValue>;

export interface AttributeDefinitionOptions<Name extends string, Value extends AttributeValue> {
  readonly name: Name;
  readonly description: string;
  readonly valueType: AttributeValueType;
  readonly allowedValues?: readonly Value[];
  readonly validate?: (value: AttributeValue) => boolean;
  readonly cardinalityLimit?: number;
  readonly privacy: string;
}

export function defineAttribute<const Name extends string, const Value extends AttributeValue>(
  options: AttributeDefinitionOptions<Name, Value>,
): AttributeDefinition<Name, Value> {
  return options;
}

export interface MetricDefinition<
  Kind extends MetricKind = MetricKind,
  Required extends readonly AnyAttributeDefinition[] = readonly AnyAttributeDefinition[],
  Optional extends readonly AnyAttributeDefinition[] = readonly AnyAttributeDefinition[],
> {
  readonly [METRIC_DEFINITION]: true;
  readonly kind: Kind;
  readonly name: `oxide.${string}`;
  readonly description: string;
  readonly unit: string;
  readonly valueType: MetricValueType;
  readonly requiredAttributes: Required;
  readonly optionalAttributes: Optional;
  readonly histogramBoundaries?: readonly number[];
}

export type AnyMetricDefinition = MetricDefinition<
  MetricKind,
  readonly AnyAttributeDefinition[],
  readonly AnyAttributeDefinition[]
>;
export type CounterMetricDefinition = MetricDefinition<
  'counter',
  readonly AnyAttributeDefinition[],
  readonly AnyAttributeDefinition[]
>;
export type GaugeMetricDefinition = MetricDefinition<
  'gauge',
  readonly AnyAttributeDefinition[],
  readonly AnyAttributeDefinition[]
>;
export type HistogramMetricDefinition = MetricDefinition<
  'histogram',
  readonly AnyAttributeDefinition[],
  readonly AnyAttributeDefinition[]
>;
export type ObservableGaugeMetricDefinition = MetricDefinition<
  'observable-gauge',
  readonly AnyAttributeDefinition[],
  readonly AnyAttributeDefinition[]
>;
export type UpDownCounterMetricDefinition = MetricDefinition<
  'up-down-counter',
  readonly AnyAttributeDefinition[],
  readonly AnyAttributeDefinition[]
>;

export function defineMetric<
  const Kind extends MetricKind,
  const Required extends readonly AnyAttributeDefinition[],
  const Optional extends readonly AnyAttributeDefinition[],
>(
  definition: Omit<MetricDefinition<Kind, Required, Optional>, typeof METRIC_DEFINITION>,
): MetricDefinition<Kind, Required, Optional> {
  return { ...definition, [METRIC_DEFINITION]: true };
}

type DefinitionValue<Definition> = Definition extends AttributeDefinition<string, infer Value> ? Value : never;

type AttributeRecord<Definitions extends readonly AnyAttributeDefinition[]> = {
  [Definition in Definitions[number] as Definition['name']]: DefinitionValue<Definition>;
};

export type MetricAttributes<Definition extends AnyMetricDefinition> = AttributeRecord<
  Definition['requiredAttributes']
> &
  Partial<AttributeRecord<Definition['optionalAttributes']>>;

export type AttributeArgs<Definition extends AnyMetricDefinition> = Definition['requiredAttributes']['length'] extends 0
  ? [attributes?: MetricAttributes<Definition>]
  : [attributes: MetricAttributes<Definition>];

function isNamespacePrefix(left: string, right: string): boolean {
  return right.startsWith(`${left}.`);
}

export function validateRegistry(
  attributes: readonly AnyAttributeDefinition[],
  metrics: readonly AnyMetricDefinition[],
): void {
  const attributeNames = new Set<string>();
  for (const attribute of attributes) {
    if (attributeNames.has(attribute.name)) {
      throw new Error(`Duplicate telemetry attribute: ${attribute.name}`);
    }
    attributeNames.add(attribute.name);

    if (!attribute.description.trim() || !attribute.privacy.trim()) {
      throw new Error(`Telemetry attribute ${attribute.name} requires a description and privacy rationale`);
    }
    if (!attribute.allowedValues?.length && (!attribute.validate || !attribute.cardinalityLimit)) {
      throw new Error(`Telemetry attribute ${attribute.name} requires a finite domain or bounded validator`);
    }
    if (attribute.cardinalityLimit !== undefined && attribute.cardinalityLimit < 1) {
      throw new Error(`Telemetry attribute ${attribute.name} has an invalid cardinality limit`);
    }
  }

  const metricNames = new Set<string>();
  for (const metric of metrics) {
    if (metricNames.has(metric.name)) {
      throw new Error(`Duplicate telemetry metric: ${metric.name}`);
    }
    metricNames.add(metric.name);

    if (!metric.description.trim() || !metric.unit.trim()) {
      throw new Error(`Telemetry metric ${metric.name} requires a description and unit`);
    }
    if (metric.kind === 'histogram') {
      const boundaries = metric.histogramBoundaries;
      if (
        !boundaries?.length ||
        boundaries.some((value, index) => value <= 0 || (index > 0 && value <= boundaries[index - 1]!))
      ) {
        throw new Error(`Telemetry histogram ${metric.name} requires positive, ascending boundaries`);
      }
    } else if (metric.histogramBoundaries !== undefined) {
      throw new Error(`Only telemetry histograms may define boundaries: ${metric.name}`);
    }

    const required = new Set(metric.requiredAttributes.map(attribute => attribute.name));
    for (const attribute of metric.optionalAttributes) {
      if (required.has(attribute.name)) {
        throw new Error(`Telemetry metric ${metric.name} repeats attribute ${attribute.name}`);
      }
    }
  }

  const names = [...attributeNames, ...metricNames];
  for (let index = 0; index < names.length; index++) {
    for (let otherIndex = index + 1; otherIndex < names.length; otherIndex++) {
      const left = names[index]!;
      const right = names[otherIndex]!;
      if (isNamespacePrefix(left, right) || isNamespacePrefix(right, left)) {
        throw new Error(`Telemetry registry namespace collision: ${left} and ${right}`);
      }
    }
  }
}
