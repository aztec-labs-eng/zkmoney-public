export const CHECKPOINT_SOURCE__POLLING_INTERVAL_MS = 1_000;

// Grace period for the prover node, whose sync state is not observable over RPC, to ingest the priced
// checkpoints before `startProof` snapshots its CheckpointStore.
export const PROVER_NODE_SYNC__SETTLE_DELAY_MS = 1_000;

// Poll interval for checking the prover node's partial proof job status until it reaches a terminal state.
export const PROOF_COMPLETION__POLL_INTERVAL_MS = 5_000;
// Timeout for waiting for the prover node's partial proof job to reach a terminal state.
export const PROOF_COMPLETION__TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
