import type { CompiledCircuit } from '@aztec-foundation/noir-noir_js';

import { fileURLToPath } from 'node:url';

import ResolverCircuitJson from '../../../../noir-projects/resolver_circuit/pinned/resolver_circuit.json' with { type: 'json' };

export const ResolverCircuit = ResolverCircuitJson as unknown as CompiledCircuit;

/** The pinned artifact on disk; the native solver reads it directly. */
export const ResolverCircuitPath = fileURLToPath(
  new URL('../../../../noir-projects/resolver_circuit/pinned/resolver_circuit.json', import.meta.url),
);
