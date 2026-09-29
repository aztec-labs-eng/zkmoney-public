import type { Logger } from '@aztec/foundation/log';

import type {
  AnyAttributeDefinition,
  AnyMetricDefinition,
  AttributeValue,
  MetricAttributes,
} from './metric_definition.js';

type SanitizedAttributes = Record<string, AttributeValue>;

function hasExpectedType(attribute: AnyAttributeDefinition, value: unknown): value is AttributeValue {
  return typeof value === attribute.valueType && (typeof value !== 'number' || Number.isFinite(value));
}

export class MeasurementValidator {
  private readonly diagnostics = new Set<string>();
  private readonly cardinality = new Map<string, Set<string>>();

  public constructor(private readonly log: Logger) {}

  public sanitize<Definition extends AnyMetricDefinition>(
    metric: Definition,
    value: number,
    attributes?: MetricAttributes<Definition>,
  ): SanitizedAttributes | undefined {
    if (!Number.isFinite(value) || (metric.valueType === 'int' && !Number.isInteger(value))) {
      this.warn(metric.name, 'measurement', 'invalid_value');
      return undefined;
    }
    if (metric.kind === 'counter' && value < 0) {
      this.warn(metric.name, 'measurement', 'negative_counter');
      return undefined;
    }

    const input: Record<string, unknown> = attributes ?? {};
    const definitions = [...metric.requiredAttributes, ...metric.optionalAttributes];
    const known = new Map(definitions.map(definition => [definition.name, definition]));

    for (const key of Object.keys(input)) {
      if (!known.has(key)) {
        this.warn(metric.name, 'attributes', 'unknown_attribute');
        return undefined;
      }
    }

    for (const attribute of metric.requiredAttributes) {
      if (!Object.hasOwn(input, attribute.name)) {
        this.warn(metric.name, attribute.name, 'missing_attribute');
        return undefined;
      }
    }

    const output: SanitizedAttributes = {};
    for (const attribute of definitions) {
      if (!Object.hasOwn(input, attribute.name)) {
        continue;
      }
      const value = input[attribute.name];
      if (!hasExpectedType(attribute, value)) {
        this.warn(metric.name, attribute.name, 'invalid_type');
        return undefined;
      }
      if (attribute.allowedValues && !attribute.allowedValues.includes(value)) {
        this.warn(metric.name, attribute.name, 'outside_allowed_domain');
        return undefined;
      }
      if (attribute.validate && !attribute.validate(value)) {
        this.warn(metric.name, attribute.name, 'outside_allowed_domain');
        return undefined;
      }
      if (attribute.cardinalityLimit && !this.acceptCardinality(metric.name, attribute, value)) {
        this.warn(metric.name, attribute.name, 'cardinality_limit');
        return undefined;
      }
      output[attribute.name] = value;
    }

    return output;
  }

  private acceptCardinality(metricName: string, attribute: AnyAttributeDefinition, value: AttributeValue): boolean {
    const key = `${metricName}:${attribute.name}`;
    const values = this.cardinality.get(key) ?? new Set<string>();
    this.cardinality.set(key, values);
    const encoded = `${typeof value}:${String(value)}`;
    if (values.has(encoded)) {
      return true;
    }
    if (values.size >= attribute.cardinalityLimit!) {
      return false;
    }
    values.add(encoded);
    return true;
  }

  private warn(metric: string, attribute: string, reason: string): void {
    const key = `${metric}:${attribute}:${reason}`;
    if (this.diagnostics.has(key)) {
      return;
    }
    this.diagnostics.add(key);
    this.log.warn(`Dropping invalid telemetry measurement`, { metric, attribute, reason });
  }
}
