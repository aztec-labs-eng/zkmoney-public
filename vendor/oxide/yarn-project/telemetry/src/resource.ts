import {
  Resource,
  detectResourcesSync,
  envDetectorSync,
  serviceInstanceIdDetectorSync,
} from '@opentelemetry/resources';
import {
  SEMRESATTRS_SERVICE_INSTANCE_ID,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
  SEMRESATTRS_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import type { ResolvedTelemetryConfig } from './config.js';

const DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';
const ALLOWED_ENVIRONMENT_ATTRIBUTES = new Set([
  DEPLOYMENT_ENVIRONMENT_NAME,
  SEMRESATTRS_SERVICE_INSTANCE_ID,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
  SEMRESATTRS_SERVICE_VERSION,
]);

export function buildResource(config: ResolvedTelemetryConfig): Resource {
  const detected = detectResourcesSync({ detectors: [envDetectorSync, serviceInstanceIdDetectorSync] });
  const filtered = Object.fromEntries(
    Object.entries(detected.attributes).filter(
      ([key, value]) => ALLOWED_ENVIRONMENT_ATTRIBUTES.has(key) && typeof value === 'string',
    ),
  );

  return new Resource({
    ...filtered,
    ...config.resourceAttributes,
    [SEMRESATTRS_SERVICE_NAMESPACE]: 'oxide',
    [SEMRESATTRS_SERVICE_NAME]: config.serviceName,
    ...(config.serviceVersion ? { [SEMRESATTRS_SERVICE_VERSION]: config.serviceVersion } : {}),
  });
}
