// The test fixture helper of the `Constrained` brand. The brand itself is in `@oxide/oxide-lib-tee/constrained.js`, which
// this module re-exports. The enclave does not use this code, so a change here does not change the enclave PCR0.
import type { Constrained } from '@oxide/oxide-lib-tee/constrained.js';

export * from '@oxide/oxide-lib-tee/constrained.js';

/** Marks a test fixture as constrained. Banned outside *.test.ts by eslint. */
export function testConstrained<T>(value: T): Constrained<T> {
  // eslint-disable-next-line no-restricted-syntax
  return value as Constrained<T>;
}
