// Brand key is a unique symbol: a structural `_branding` property (as in `@aztec/foundation` `Branded`) collides with
// the private `_branding` discriminants on aztec classes like `Fr`, reducing the intersection to `never`.
declare const constrainedBrand: unique symbol;

/**
 * A value that is a public input or has been checked against one, possibly through a chain of branded values.
 *
 * The brand certifies TS-side checks only and makes no claim about any Noir circuit: the circuit may compute the
 * corresponding witness in unconstrained code, and circuit soundness must be audited in Noir, not inferred from this
 * type.
 *
 * @dev Casting into the brand is banned by eslint (no-restricted-syntax).
 */
export type Constrained<T> = T & { readonly [constrainedBrand]: true };

/** Marks value as public input. */
export function publicInput<T>(value: T, _reason: string): Constrained<T> {
  // eslint-disable-next-line no-restricted-syntax
  return value as Constrained<T>;
}

/** Marks a test fixture as constrained. Banned outside *.test.ts by eslint. */
export function testConstrained<T>(value: T): Constrained<T> {
  // eslint-disable-next-line no-restricted-syntax
  return value as Constrained<T>;
}

/** Brands a value immediately after a successful check ties it to a constrained root. */
export function markConstrained<T>(value: T, _check: string): Constrained<T> {
  // eslint-disable-next-line no-restricted-syntax
  return value as Constrained<T>;
}

/** Projects off a constrained value; the projection inherits the constraint. */
export function derive<T, U>(value: Constrained<T>, project: (value: T) => U): Constrained<U> {
  // eslint-disable-next-line no-restricted-syntax
  return project(value) as Constrained<U>;
}
