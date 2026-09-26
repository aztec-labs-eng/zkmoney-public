// Statically bundled artifact for the unprocessed_deposit_refund circuit.
// The compiled JSON is produced by `noir-projects/bootstrap.sh unprocessed_deposit_refund`; if
// the circuit changes, that script must be re-run before rebuilding this package.
import type { CompiledCircuit } from '@aztec/noir-noir_js';

import UnprocessedDepositRefundCircuitJson from '../../../../noir-projects/unprocessed_deposit_refund/target/unprocessed_deposit_refund.json' with { type: 'json' };

export const UnprocessedDepositRefundCircuit = UnprocessedDepositRefundCircuitJson as unknown as CompiledCircuit;
