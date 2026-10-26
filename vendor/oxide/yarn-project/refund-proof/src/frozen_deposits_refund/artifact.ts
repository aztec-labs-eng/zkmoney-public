// Statically bundled artifact for the frozen_deposits_refund circuit.
// The compiled JSON is produced by `noir-projects/bootstrap.sh frozen_deposits_refund`; if the
// circuit changes, that script must be re-run before rebuilding this package.
import type { CompiledCircuit } from '@aztec-foundation/noir-noir_js';

import FrozenDepositsRefundCircuitJson from '../../../../noir-projects/frozen_deposits_refund/target/frozen_deposits_refund.json' with { type: 'json' };

export const FrozenDepositsRefundCircuit = FrozenDepositsRefundCircuitJson as unknown as CompiledCircuit;
