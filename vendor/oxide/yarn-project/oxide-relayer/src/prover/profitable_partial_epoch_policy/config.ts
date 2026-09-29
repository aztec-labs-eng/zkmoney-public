// Gas to call Rollup.submitEpochRootProof with a real proof.
// Measured in aztec-packages/end-to-end/src/e2e_prover/full.test.ts with a real proof.
// const ROLLUP__SUBMIT_EPOCH_ROOT_PROOF_GAS = 575_113n;
// Overhead the FirstProverProofSubmitter adds around the proof for first-prover capture.
// Measured in l1-contracts test/periphery/FirstProverProofSubmitter.gas.t.sol.
// const FIRST_PROVER_PROOF_SUBMITTER__CAPTURE_OVERHEAD_GAS = 57_558n;

// Gas to submit through the FirstProverProofSubmitter:
// ROLLUP__SUBMIT_EPOCH_ROOT_PROOF_GAS + FIRST_PROVER_PROOF_SUBMITTER__CAPTURE_OVERHEAD_GAS
export const ROLLUP__SUBMIT_EPOCH_PROOF_GAS = 640_000n; // 632_671n

export const EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT = 0n;
export const EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT_MARGIN_BPS = 0n;

// Off-chain proving cost per checkpoint, in the price oracle's common quote currency.
export const EARLY_SUBMIT_POLICY__PROVING_COST_PER_CHECKPOINT = 0n;
