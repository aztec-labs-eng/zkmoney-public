// Statically bundled artifact for the frozen_notes_refund circuit.
// The compiled JSON is produced by `noir-projects/bootstrap.sh frozen_notes_refund`; if the circuit changes,
// that script must be re-run before rebuilding this package.
import type { CompiledCircuit } from '@aztec/noir-noir_js';

import RefundCircuitJson from '../../../../noir-projects/frozen_notes_refund/target/frozen_notes_refund.json' with { type: 'json' };

export const RefundCircuit = RefundCircuitJson as unknown as CompiledCircuit;
