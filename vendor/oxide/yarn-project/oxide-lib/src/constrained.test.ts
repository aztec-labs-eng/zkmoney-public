import { Fr } from '@aztec/aztec.js/fields';

import { describe, expect, it } from '@jest/globals';

import { type Constrained, derive, markConstrained, publicInput, testConstrained } from './constrained.js';

describe('Constrained', () => {
  it('marking functions return the same reference', () => {
    const value = Fr.random();
    expect(publicInput(value, 'test')).toBe(value);
    expect(markConstrained(value, 'test')).toBe(value);
    expect(testConstrained(value)).toBe(value);
  });

  it('derive applies the projection', () => {
    const value = testConstrained(new Fr(7n));
    const doubled: Constrained<Fr> = derive(value, v => new Fr(v.toBigInt() * 2n));
    expect(doubled.toBigInt()).toBe(14n);
  });

  it('brand erases on assignment but cannot be forged', () => {
    // @ts-expect-error a raw Fr is not Constrained<Fr>
    const _needsConstrained: Constrained<Fr> = Fr.random();
    const constrained = testConstrained(Fr.ONE);
    const erased: Fr = constrained;
    expect(erased).toBe(constrained);
  });

  it('does not collapse to never on classes with a private _branding member (e.g. Fr)', () => {
    // `true` is not assignable to `never`, so this fails to type-check if Constrained<Fr> collapses.
    const probe: [Constrained<Fr>] extends [never] ? never : true = true;
    expect(probe).toBe(true);
  });
});
