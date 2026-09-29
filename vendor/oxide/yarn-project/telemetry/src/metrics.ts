import {
  ATTRIBUTE_DEFINITIONS,
  HTTP_RESPONSE_STATUS_CODE,
  HTTP_ROUTE,
  L1_OBSERVER_TOKEN_SYMBOL,
  RELAYER_DEFER_REASON,
  RELAYER_OUTCOME,
  RELAYER_STREAM,
  RELAYER_SUBSYSTEM,
  RESOLVER_BROADCAST_OUTCOME,
  RESOLVER_OUTCOME,
  RESOLVER_SIPA_STATE,
  TEE_ROUTER_DISCOVERY_FAILURE_KIND,
  TEE_ROUTER_OUTCOME,
  TEE_ROUTER_UPSTREAM_FAILURE_KIND,
} from './attributes.js';
import { defineMetric, validateRegistry } from './metric_definition.js';

const REQUEST_ATTRIBUTES = [HTTP_ROUTE, HTTP_RESPONSE_STATUS_CODE, TEE_ROUTER_OUTCOME] as const;

export const TEE_ROUTER_REQUEST_COUNT = defineMetric({
  kind: 'counter',
  name: 'oxide.tee_router.request.count',
  description: 'Number of requests completed by tee-router.',
  unit: '{request}',
  valueType: 'int',
  requiredAttributes: REQUEST_ATTRIBUTES,
  optionalAttributes: [],
});

export const TEE_ROUTER_REQUEST_DURATION = defineMetric({
  kind: 'histogram',
  name: 'oxide.tee_router.request.duration',
  description: 'End-to-end duration of requests handled by tee-router.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: REQUEST_ATTRIBUTES,
  optionalAttributes: [],
  histogramBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 180, 200],
});

// An observable gauge, not an up-down counter: awsemf renders cumulative sums as per-interval deltas,
// which would turn "current active requests" into "change in active requests". No route attribute —
// only /rpc requests are counted.
export const TEE_ROUTER_REQUEST_ACTIVE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.tee_router.request.active',
  description: 'Number of tee-router requests currently in progress.',
  unit: '{request}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const TEE_ROUTER_TARGET_ROUTABLE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.tee_router.target.routable',
  description: 'Number of currently routable tee-router targets.',
  unit: '{target}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const TEE_ROUTER_DISCOVERY_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.tee_router.discovery.age',
  description: 'Age of the most recent successful target discovery result.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const TEE_ROUTER_DISCOVERY_FAILURE = defineMetric({
  kind: 'counter',
  name: 'oxide.tee_router.discovery.failure',
  description: 'Number of target discovery failures.',
  unit: '{failure}',
  valueType: 'int',
  requiredAttributes: [TEE_ROUTER_DISCOVERY_FAILURE_KIND] as const,
  optionalAttributes: [],
});

export const TEE_ROUTER_UPSTREAM_FAILURE = defineMetric({
  kind: 'counter',
  name: 'oxide.tee_router.upstream.failure',
  description: 'Number of tee-router upstream proxy failures.',
  unit: '{failure}',
  valueType: 'int',
  requiredAttributes: [TEE_ROUTER_UPSTREAM_FAILURE_KIND] as const,
  optionalAttributes: [],
});

// The registrar is a short-lived Lambda that reads each balance once per run and flushes.
export const TEE_REGISTRAR_ETH_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.tee_registrar.eth_balance',
  description: 'ETH balance of the shared registrar key, in whole ETH. Pays L1 registration gas.',
  unit: '{eth}',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const TEE_REGISTRAR_FEE_JUICE_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.tee_registrar.fee_juice_balance',
  description: "Fee-juice balance of the version's operator account, in whole units. Pays L2 signer consumes.",
  unit: '{fee_juice}',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

// ── Relayer ───────────────────────────────────────────────────────────────────
// The relayer is a long-running service; levels are observable gauges read at each export.

export const RELAYER_L1_OPERATION_COUNT = defineMetric({
  kind: 'counter',
  name: 'oxide.relayer.l1_operation.count',
  description: 'L1 operation work item checks, by outcome.',
  unit: '{operation}',
  valueType: 'int',
  requiredAttributes: [RELAYER_OUTCOME] as const,
  optionalAttributes: [RELAYER_DEFER_REASON] as const,
});

export const RELAYER_L1_OPERATION_PENDING = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.relayer.l1_operation.pending',
  description: 'L1 operations currently pending, due or backed off.',
  unit: '{operation}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RELAYER_L1_OPERATION_WAITING = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.relayer.l1_operation.waiting',
  description: 'L1 operations held until their condition fires; never simulated while waiting.',
  unit: '{operation}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RELAYER_WATCHER_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.relayer.watcher.age',
  description: 'Age of the most recent successful poll of a watched log stream.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [RELAYER_STREAM] as const,
  optionalAttributes: [],
});

// Realized cost from mined receipts (gasUsed * effectiveGasPrice), including reverted txs. Cancellation
// txs are not counted.
export const RELAYER_GAS_SPENT = defineMetric({
  kind: 'counter',
  name: 'oxide.relayer.gas.spent',
  description: 'ETH spent on mined relayer L1 transactions, in whole ETH.',
  unit: '{eth}',
  valueType: 'double',
  requiredAttributes: [RELAYER_SUBSYSTEM] as const,
  optionalAttributes: [],
});

export const RELAYER_ETH_BALANCE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.relayer.eth_balance',
  description: 'ETH balance of the relayer signer, in whole ETH. Pays all relayer L1 gas.',
  unit: '{eth}',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RELAYER_SDN_LIST_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.relayer.sdn_list.age',
  description:
    'Age of the OFAC SDN list the relayer screens L1 operations against, since its last successful download.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

// ── Resolver ──────────────────────────────────────────────────────────────────
// Two processes share the oxide.resolver.* prefix and split on service.name: the CCIP gateway
// (oxide-resolver-gateway, a Lambda that flushes per invocation) and the singleton deposit watcher
// (oxide-resolver-watcher, a long-running service).

export const RESOLVER_RESOLVE_COUNT = defineMetric({
  kind: 'counter',
  name: 'oxide.resolver.resolve.count',
  description: 'CCIP resolve requests completed by the gateway, by outcome.',
  unit: '{resolve}',
  valueType: 'int',
  requiredAttributes: [RESOLVER_OUTCOME] as const,
  optionalAttributes: [],
});

export const RESOLVER_RESOLVE_DURATION = defineMetric({
  kind: 'histogram',
  name: 'oxide.resolver.resolve.duration',
  description: 'End-to-end duration of CCIP resolve requests.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [RESOLVER_OUTCOME] as const,
  optionalAttributes: [],
  histogramBoundaries: [0.1, 0.25, 0.5, 1, 2, 3, 4, 5, 7.5, 10, 15, 20, 30],
});

// Proof generation dominates resolve latency in profiling (~96% of wall time).
export const RESOLVER_PROOF_DURATION = defineMetric({
  kind: 'histogram',
  name: 'oxide.resolver.proof.duration',
  description: 'Duration of resolution proof generation.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
  histogramBoundaries: [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30],
});

export const RESOLVER_WATCHER_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.watcher.age',
  description: 'Age of the most recent successful deposit-watcher poll.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_SCAN_LAG = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.scan.lag',
  description: 'L1 blocks between the chain tip and the scan cursor at the start of the latest poll.',
  unit: '{block}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_SIPA_FUNDED = defineMetric({
  kind: 'counter',
  name: 'oxide.resolver.sipa.funded',
  description: 'Resolved SIPAs observed to receive a deposit.',
  unit: '{sipa}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_BROADCAST_COUNT = defineMetric({
  kind: 'counter',
  name: 'oxide.resolver.broadcast.count',
  description: 'SIPA broadcast attempts on L2, by outcome.',
  unit: '{broadcast}',
  valueType: 'int',
  requiredAttributes: [RESOLVER_BROADCAST_OUTCOME] as const,
  optionalAttributes: [],
});

export const RESOLVER_RESOLUTIONS = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.resolutions',
  description: 'Resolutions in the store, by lifecycle state. funded = the unbroadcast backlog.',
  unit: '{resolution}',
  valueType: 'int',
  requiredAttributes: [RESOLVER_SIPA_STATE] as const,
  optionalAttributes: [],
});

export const RESOLVER_SIPA_EXPIRED = defineMetric({
  kind: 'counter',
  name: 'oxide.resolver.sipa.expired',
  description: 'Resolutions pruned because they were never funded inside the watch window.',
  unit: '{sipa}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_FEE_JUICE_BALANCE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.fee_juice_balance',
  description: "Fee-juice balance of the resolver's L2 account, in whole units. Pays SIPA broadcasts.",
  unit: '{fee_juice}',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_SDN_LIST_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.sdn_list.age',
  description: 'Age of the OFAC SDN list the watcher screens SIPA funders against, since its last successful download.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_PORTAL_ESCROW_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal_escrow_balance',
  description: 'Total balance held by known Oxide portals, in underlying token units.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SIPA_DEPLOYED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.sipa.deployed',
  description: 'Number of clone deployments through the environment SIPA factory.',
  unit: '{sipa}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_ACCOUNT_DEPLOYED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.account.deployed',
  description: 'Number of account clones deployed through the environment account factory.',
  unit: '{account}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_PORTAL_FROZEN = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.frozen',
  description: 'Number of current Oxide portals that are frozen.',
  unit: '{portal}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_DEPOSIT_SUBSIDY_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.deposit_subsidy.balance',
  description: 'Total token balance available from current deposit subsidy contracts.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_SUBSIDY_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.withdrawal_subsidy.balance',
  description: 'Total token balance available from current withdrawal subsidy contracts.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_PROVER_SUBSIDY_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.prover_subsidy.balance',
  description: 'Total token balance available from current prover subsidy contracts.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_FPC_FUNDER_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.fpc_funder.balance',
  description: 'Total input-token balance held by current FPC funders.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_FPC_FUNDER_BOUNTY = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.fpc_funder.bounty',
  description: 'Total caller bounty currently offered by current FPC funders.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_DEPOSIT_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.deposit.count',
  description: 'Portal deposits observed after the L1 event cursor was initialized.',
  unit: '{deposit}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_DEPOSIT_VOLUME = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.deposit.volume',
  description: 'Net portal deposit volume observed after the L1 event cursor was initialized.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.withdrawal.count',
  description: 'Portal withdrawals observed after the L1 event cursor was initialized.',
  unit: '{withdrawal}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_VOLUME = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.withdrawal.volume',
  description: 'Net portal withdrawal volume observed after the L1 event cursor was initialized.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_REFUND_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.refund.count',
  description: 'Portal refunds observed after the L1 event cursor was initialized.',
  unit: '{refund}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_REFUND_VOLUME = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.refund.volume',
  description: 'Net portal refund volume observed after the L1 event cursor was initialized.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_TIP_RELEASED_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.tip_released.count',
  description: 'Portal tip releases observed after the L1 event cursor was initialized.',
  unit: '{release}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_TIP_RELEASED_VOLUME = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.tip_released.volume',
  description: 'Portal tip volume released after the L1 event cursor was initialized.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_REGISTRATION_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.registration.count',
  description: 'Registrations observed after the L1 event cursor was initialized.',
  unit: '{registration}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_REGISTRATION_FEES = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.registration.fees',
  description: 'Registration fees applied after the L1 event cursor was initialized.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const TELEMETRY_E2E_VERIFICATION = defineMetric({
  kind: 'gauge',
  name: 'oxide.telemetry.e2e_verification',
  description: 'Datapoints sent to verify the metrics pipeline end to end.',
  unit: '{datapoint}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const METRIC_DEFINITIONS = [
  TEE_ROUTER_REQUEST_COUNT,
  TEE_ROUTER_REQUEST_DURATION,
  TEE_ROUTER_REQUEST_ACTIVE,
  TEE_ROUTER_TARGET_ROUTABLE,
  TEE_ROUTER_DISCOVERY_AGE,
  TEE_ROUTER_DISCOVERY_FAILURE,
  TEE_ROUTER_UPSTREAM_FAILURE,
  TEE_REGISTRAR_ETH_BALANCE,
  TEE_REGISTRAR_FEE_JUICE_BALANCE,
  RELAYER_L1_OPERATION_COUNT,
  RELAYER_L1_OPERATION_PENDING,
  RELAYER_L1_OPERATION_WAITING,
  RELAYER_WATCHER_AGE,
  RELAYER_GAS_SPENT,
  RELAYER_ETH_BALANCE,
  RELAYER_SDN_LIST_AGE,
  RESOLVER_RESOLVE_COUNT,
  RESOLVER_RESOLVE_DURATION,
  RESOLVER_PROOF_DURATION,
  RESOLVER_WATCHER_AGE,
  RESOLVER_SCAN_LAG,
  RESOLVER_SIPA_FUNDED,
  RESOLVER_BROADCAST_COUNT,
  RESOLVER_RESOLUTIONS,
  RESOLVER_SIPA_EXPIRED,
  RESOLVER_FEE_JUICE_BALANCE,
  RESOLVER_SDN_LIST_AGE,
  L1_OBSERVER_PORTAL_ESCROW_BALANCE,
  L1_OBSERVER_SIPA_DEPLOYED,
  L1_OBSERVER_ACCOUNT_DEPLOYED,
  L1_OBSERVER_PORTAL_FROZEN,
  L1_OBSERVER_DEPOSIT_SUBSIDY_BALANCE,
  L1_OBSERVER_WITHDRAWAL_SUBSIDY_BALANCE,
  L1_OBSERVER_PROVER_SUBSIDY_BALANCE,
  L1_OBSERVER_FPC_FUNDER_BALANCE,
  L1_OBSERVER_FPC_FUNDER_BOUNTY,
  L1_OBSERVER_DEPOSIT_COUNT,
  L1_OBSERVER_DEPOSIT_VOLUME,
  L1_OBSERVER_WITHDRAWAL_COUNT,
  L1_OBSERVER_WITHDRAWAL_VOLUME,
  L1_OBSERVER_REFUND_COUNT,
  L1_OBSERVER_REFUND_VOLUME,
  L1_OBSERVER_TIP_RELEASED_COUNT,
  L1_OBSERVER_TIP_RELEASED_VOLUME,
  L1_OBSERVER_REGISTRATION_COUNT,
  L1_OBSERVER_REGISTRATION_FEES,
  TELEMETRY_E2E_VERIFICATION,
] as const;

validateRegistry(ATTRIBUTE_DEFINITIONS, METRIC_DEFINITIONS);
