// Statically bundled artifact for the frozen_deposit_refund circuit.
// The compiled JSON is produced by `noir-projects/bootstrap.sh frozen_deposit_refund`; if the
// circuit changes, that script must be re-run before rebuilding this package.
import type { CompiledCircuit } from '@aztec/noir-noir_js';

import FrozenDepositRefundCircuitJson from '../../../../noir-projects/frozen_deposit_refund/target/frozen_deposit_refund.json' with { type: 'json' };

export const FrozenDepositRefundCircuit = FrozenDepositRefundCircuitJson as unknown as CompiledCircuit;
