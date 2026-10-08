import { defineAttribute } from './metric_definition.js';

export const HTTP_REQUEST_METHOD = defineAttribute({
  name: 'http.request.method',
  description: 'Normalized HTTP request method.',
  valueType: 'string',
  allowedValues: ['GET', 'POST', 'OPTIONS', 'other'] as const,
  privacy: 'A fixed protocol enum; it contains no request or user identifiers.',
});

export const HTTP_ROUTE = defineAttribute({
  name: 'http.route',
  description: 'Fixed HTTP endpoint label handled by an Oxide service.',
  valueType: 'string',
  allowedValues: ['/rpc', '/health', 'other'] as const,
  privacy: 'Only fixed endpoint labels (/rpc, /health, other); raw paths and query strings are excluded.',
});

export const HTTP_RESPONSE_STATUS_CODE = defineAttribute({
  name: 'http.response.status_code',
  description: 'HTTP response status code.',
  valueType: 'number',
  validate: value => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599,
  cardinalityLimit: 500,
  privacy: 'The bounded HTTP status code domain contains no private data.',
});

export const TEE_ROUTER_OUTCOME = defineAttribute({
  name: 'oxide.tee_router.outcome',
  description: 'Normalized outcome of a tee-router request.',
  valueType: 'string',
  allowedValues: [
    'success',
    'tee_unknown',
    'no_tee_routable',
    'tee_unreachable',
    'request_too_large',
    'budget_denied',
    'client_aborted',
    'invalid_request',
    'internal_error',
  ] as const,
  privacy: 'A fixed operational enum; target identifiers and error messages are excluded.',
});

export const TEE_ROUTER_DISCOVERY_FAILURE_KIND = defineAttribute({
  name: 'oxide.tee_router.discovery_failure.kind',
  description: 'Normalized category of target discovery failure.',
  valueType: 'string',
  allowedValues: ['cloud_map_error', 'invalid_instance'] as const,
  privacy: 'A fixed failure enum; AWS responses and target identifiers are excluded.',
});

export const TEE_ROUTER_UPSTREAM_FAILURE_KIND = defineAttribute({
  name: 'oxide.tee_router.upstream_failure.kind',
  description: 'Normalized category of upstream proxy failure.',
  valueType: 'string',
  allowedValues: [
    'connect_timeout',
    'request_timeout',
    'connection_error',
    'request_too_large',
    'stream_error',
  ] as const,
  privacy: 'A fixed failure enum; upstream addresses, TEE identities, and error messages are excluded.',
});

export const RELAYER_SUBSYSTEM = defineAttribute({
  name: 'oxide.relayer.subsystem',
  description: 'Relayer subsystem that produced the measurement.',
  valueType: 'string',
  allowedValues: ['l1_operation'] as const,
  privacy: 'A fixed subsystem enum; it contains no user or transaction identifiers.',
});

export const RELAYER_OUTCOME = defineAttribute({
  name: 'oxide.relayer.outcome',
  description: 'Normalized outcome of one relayer work item check.',
  valueType: 'string',
  allowedValues: ['waiting', 'submitted', 'confirmed', 'settled', 'deferred', 'failed', 'dropped', 'blocked'] as const,
  privacy: 'A fixed operational enum; SIPA, operation, and withdrawal identifiers are excluded.',
});

export const RELAYER_DEFER_REASON = defineAttribute({
  name: 'oxide.relayer.defer_reason',
  description: 'Persisted reason a deferred relayer work item stayed pending.',
  valueType: 'string',
  allowedValues: [
    'unprofitable',
    'screening_error',
    'simulation_reverted',
    'completion_error',
    'broadcast_failed',
    'gas_price_above_max',
    'other',
  ] as const,
  privacy: 'A fixed reason enum; error messages and work item identifiers are excluded.',
});

export const RELAYER_STREAM = defineAttribute({
  name: 'oxide.relayer.stream',
  description: 'Watched log stream behind a relayer cursor heartbeat.',
  valueType: 'string',
  allowedValues: ['l1_operation_broadcaster', 'l1_operation_transfer_discovery'] as const,
  privacy: 'A fixed stream enum matching the persisted cursor sources; addresses are excluded.',
});

export const RESOLVER_OUTCOME = defineAttribute({
  name: 'oxide.resolver.outcome',
  description: 'Normalized outcome of one CCIP resolve request.',
  valueType: 'string',
  allowedValues: [
    'success',
    'invalid_request',
    'unexpected_sender',
    'rate_limited',
    'limiter_unavailable',
    'watcher_unavailable',
    'unknown_name',
    'nonce_exhausted',
    'proof_error',
    'store_error',
    'internal_error',
  ] as const,
  privacy: 'A fixed operational enum; names, addresses, IPs, and error messages are excluded.',
});

export const RESOLVER_BROADCAST_OUTCOME = defineAttribute({
  name: 'oxide.resolver.broadcast_outcome',
  description:
    'Outcome of one attempt to process a funded SIPA: a broadcast on L2, a sanctions block, or a screen that cannot complete.',
  valueType: 'string',
  allowedValues: ['sent', 'failed', 'dropped', 'blocked', 'unscreenable'] as const,
  privacy: 'A fixed operational enum; SIPA addresses and tx hashes are excluded.',
});

export const RESOLVER_SIPA_STATE = defineAttribute({
  name: 'oxide.resolver.sipa_state',
  description: 'Lifecycle state of a resolution in the resolver store.',
  valueType: 'string',
  allowedValues: ['unfunded', 'funded', 'broadcasted', 'blocked'] as const,
  privacy: 'A fixed state enum; resolution identifiers are excluded.',
});

export const L1_OBSERVER_TOKEN_SYMBOL = defineAttribute({
  name: 'oxide.l1_observer.token_symbol',
  description:
    'ERC-20 symbol of the token escrowed by the observed portals, or its address when metadata is unavailable.',
  valueType: 'string',
  validate: value =>
    typeof value === 'string' && (/^[A-Za-z0-9._-]{1,16}$/.test(value) || /^0x[0-9a-fA-F]{40}$/.test(value)),
  cardinalityLimit: 1,
  privacy: 'The value is public ERC-20 contract metadata or a public contract address; it contains no user data.',
});

export const L1_OBSERVER_DEPLOYMENT_LABEL = defineAttribute({
  name: 'oxide.l1_observer.deployment_label',
  description: 'Label of the deployment-env manifest entry an observed L2 value belongs to.',
  valueType: 'string',
  validate: value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(value),
  cardinalityLimit: 100,
  privacy: 'The label names a public manifest entry; it contains no user data.',
});

export const L1_OBSERVER_CHECK_NAME = defineAttribute({
  name: 'oxide.l1_observer.check_name',
  description: 'The L2 check of the L1 observer that a failure belongs to.',
  valueType: 'string',
  allowedValues: ['nodes', 'l2_tips', 'withdrawals', 'sipa_sweeps'] as const,
  privacy: 'A fixed enum of check names; it contains no user data.',
});

export const ATTRIBUTE_DEFINITIONS = [
  HTTP_REQUEST_METHOD,
  HTTP_ROUTE,
  HTTP_RESPONSE_STATUS_CODE,
  TEE_ROUTER_OUTCOME,
  TEE_ROUTER_DISCOVERY_FAILURE_KIND,
  TEE_ROUTER_UPSTREAM_FAILURE_KIND,
  RELAYER_SUBSYSTEM,
  RELAYER_OUTCOME,
  RELAYER_DEFER_REASON,
  RELAYER_STREAM,
  RESOLVER_OUTCOME,
  RESOLVER_BROADCAST_OUTCOME,
  RESOLVER_SIPA_STATE,
  L1_OBSERVER_TOKEN_SYMBOL,
  L1_OBSERVER_DEPLOYMENT_LABEL,
  L1_OBSERVER_CHECK_NAME,
] as const;
