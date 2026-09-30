//! Multiplication of secp256k1's generator by a witness scalar.
//!
//! $$ G \cdot s = \sum_{i} (d_i \cdot 16^i) \cdot G, \qquad d_i \in [0, 16) $$
//!
//! Every term is a table entry, so a window costs one lookup and one addition — no doublings. Row
//! offsets are distinct and cancel: no entry is infinity, no addition doubles, and the accumulated
//! windows need no correction.
//!
//! Uses running sum idea from
//! https://github.com/AztecProtocol/aztec-packages/blob/86f69c8751f63ca604a1dab5967f208b211a1611/barretenberg/cpp/src/barretenberg/stdlib/primitives/biggroup/biggroup.hpp#L309

use bigcurve::curves::secp256k1::Secp256k1;
use bigcurve::internal::evaluate_quadratic_expression;
use bignum::{BigNum, Secp256k1_Fq};

use crate::comb_table::{COMB_WINDOWS, COMB_X, COMB_Y};

/// Running sum with an implicit y-coordinate `lambda_prev * (x_prev - x) - y_prev`, where
/// `(x_prev, y_prev)` is the last point added and `lambda_prev` the chord slope that produced `x`.
struct ChainAcc {
    x: Secp256k1_Fq,
    x_prev: Secp256k1_Fq,
    y_prev: Secp256k1_Fq,
    lambda_prev: Secp256k1_Fq,
}

impl ChainAcc {
    unconstrained fn implicit_y(self) -> Secp256k1_Fq {
        self.lambda_prev * (self.x_prev - self.x) - self.y_prev
    }
}

unconstrained fn slope_hint(
    x1: Secp256k1_Fq,
    y1: Secp256k1_Fq,
    x2: Secp256k1_Fq,
    y2: Secp256k1_Fq,
) -> (Secp256k1_Fq, Secp256k1_Fq) {
    let lambda = (y2 - y1) / (x2 - x1);
    (lambda, lambda * lambda - x2 - x1)
}

unconstrained fn chain_add_hint(acc: ChainAcc, x2: Secp256k1_Fq, y2: Secp256k1_Fq) -> (Secp256k1_Fq, Secp256k1_Fq) {
    slope_hint(acc.x, acc.implicit_y(), x2, y2)
}

/// Opens a chain with `p + q` (distinct x). The sum's y-coordinate stays implicit in the accumulator.
fn chain_add_start(p: Secp256k1, q: Secp256k1) -> ChainAcc {
    let (x1, y1, x2, y2) = (p.x, p.y, q.x, q.y);
    // Safety: the two constraints below pin (lambda, x3) to the chord-addition result.
    let (lambda, x3) = unsafe { slope_hint(x1, y1, x2, y2) };
    lambda.validate_in_range();
    x3.validate_in_range();
    x1.assert_is_not_equal(x2);

    // lambda * (x2 - x1) - (y2 - y1) = 0
    evaluate_quadratic_expression(
        [[lambda]],
        [[false]],
        [[x2, x1]],
        [[false, true]],
        [y2, y1],
        [true, false],
    );
    // lambda^2 - x3 - x2 - x1 = 0
    evaluate_quadratic_expression(
        [[lambda]],
        [[false]],
        [[lambda]],
        [[false]],
        [x3, x2, x1],
        [true, true, true],
    );

    ChainAcc { x: x3, x_prev: x1, y_prev: y1, lambda_prev: lambda }
}

/// Adds `q` (distinct x) to the chain. The accumulator's implicit y is substituted into the chord constraint, so
/// each addition costs two quadratic evaluations instead of the three a plain constrained addition needs.
fn chain_add(acc: ChainAcc, q: Secp256k1) -> ChainAcc {
    let (x2, y2) = (q.x, q.y);
    // Safety: the two constraints below pin (lambda, x3) to the chord-addition result.
    let (lambda, x3) = unsafe { chain_add_hint(acc, x2, y2) };
    lambda.validate_in_range();
    x3.validate_in_range();
    acc.x.assert_is_not_equal(x2);

    // lambda * (x2 - acc.x) - y2 + implicit_y(acc) = 0
    evaluate_quadratic_expression(
        [[lambda], [acc.lambda_prev]],
        [[false], [false]],
        [[x2, acc.x], [acc.x_prev, acc.x]],
        [[false, true], [false, true]],
        [y2, acc.y_prev],
        [true, true],
    );
    // lambda^2 - x3 - x2 - acc.x = 0
    evaluate_quadratic_expression(
        [[lambda]],
        [[false]],
        [[lambda]],
        [[false]],
        [x3, x2, acc.x],
        [true, true, true],
    );

    ChainAcc { x: x3, x_prev: x2, y_prev: y2, lambda_prev: lambda }
}

/// Closes the chain: materializes and constrains the final point's y-coordinate.
fn chain_add_end(acc: ChainAcc) -> Secp256k1 {
    // Safety: the constraint below pins y to the accumulator's implicit y-coordinate.
    let y = unsafe { acc.implicit_y() };
    y.validate_in_range();

    // lambda_prev * (x_prev - acc.x) - y_prev - y = 0
    evaluate_quadratic_expression(
        [[acc.lambda_prev]],
        [[false]],
        [[acc.x_prev, acc.x]],
        [[false, true]],
        [acc.y_prev, y],
        [true, true],
    );

    Secp256k1 { x: acc.x, y, is_infinity: false }
}

/// Chains all comb windows, leaving the accumulator open for further additions.
fn fixed_base_mul_acc(digits: [u8; COMB_WINDOWS]) -> ChainAcc {
    let mut acc = chain_add_start(comb_entry(0, digits[0]), comb_entry(1, digits[1]));
    for i in 2..COMB_WINDOWS {
        acc = chain_add(acc, comb_entry(i, digits[i]));
    }
    acc
}

fn comb_entry(window: u32, digit: u8) -> Secp256k1 {
    Secp256k1 { x: COMB_X[window][digit as u32], y: COMB_Y[window][digit as u32], is_infinity: false }
}

/// Little-endian base-16 digits of a big-endian value, zero-padded to a full set of windows. The
/// bytes must come from a constrained decomposition; that is what binds the digits to the scalar.
pub fn nibbles_be<let N: u32>(bytes: [u8; N]) -> [u8; COMB_WINDOWS] {
    let mut digits: [u8; COMB_WINDOWS] = [0; COMB_WINDOWS];
    for i in 0..N {
        let byte = bytes[N - 1 - i];
        digits[2 * i] = byte & 15;
        digits[2 * i + 1] = byte >> 4;
    }
    digits
}

/// `G * sum_i(digits[i] * 16^i)`. A zero scalar has no affine representation and is unsatisfiable.
pub fn fixed_base_mul(digits: [u8; COMB_WINDOWS]) -> Secp256k1 {
    chain_add_end(fixed_base_mul_acc(digits))
}

mod test {
    use crate::comb_table::{COMB_ENTRIES, COMB_WINDOW_BITS, COMB_WINDOWS, COMB_X, COMB_Y};
    use super::{fixed_base_mul, nibbles_be};
    use bigcurve::BigCurve;
    use bigcurve::curves::secp256k1::{Secp256k1, Secp256k1Scalar};
    use bignum::{BigNum, Secp256k1_Fr};

    fn generic_mul(be: [u8; 32]) -> Secp256k1 {
        Secp256k1::one().mul(Secp256k1Scalar::from_bignum(Secp256k1_Fr::from_be_bytes(be)))
    }

    fn assert_matches_generic_mul(be: [u8; 32]) {
        assert(fixed_base_mul(nibbles_be(be)).eq(generic_mul(be)));
    }

    fn be_from_u32(value: u32) -> [u8; 32] {
        let mut be: [u8; 32] = [0; 32];
        let bytes: [u8; 4] = (value as Field).to_be_bytes();
        for i in 0..4 {
            be[28 + i] = bytes[i];
        }
        be
    }

    #[test]
    fn matches_generic_mul_for_small_scalars() {
        for k in 1..4 {
            assert_matches_generic_mul(be_from_u32(k));
        }
    }

    #[test]
    fn matches_generic_mul_for_the_resolver_key_fixture() {
        let mut be: [u8; 32] = [0; 32];
        for i in 0..8 {
            be[4 * i] = 0x12;
            be[4 * i + 1] = 0x34;
            be[4 * i + 2] = 0x56;
            be[4 * i + 3] = 0x78;
        }
        assert_matches_generic_mul(be);
    }

    /// Sweeps digit values across windows: scalar `k` puts digit `(i + k) % 16` in window `i`. The top
    /// window stays zero to keep every scalar under the group order.
    #[test]
    fn matches_generic_mul_across_digit_rotations() {
        for k in 0..4 {
            let mut be: [u8; 32] = [0; 32];
            for i in 0..(COMB_WINDOWS - 1) {
                let digit = ((i + k) % COMB_ENTRIES) as u8;
                let byte_index = 31 - i / 2;
                be[byte_index] = if i % 2 == 0 {
                    be[byte_index] | digit
                } else {
                    be[byte_index] | (digit * 16)
                };
            }
            assert_matches_generic_mul(be);
        }
    }

    /// `SIGMA_i = 2^i * W` for `i > 0` and `-sum(SIGMA_i)` for window zero, `W` the offset generator
    /// the table was built from.
    fn expected_offsets() -> [Secp256k1; COMB_WINDOWS] {
        let mut sigma: [Secp256k1; COMB_WINDOWS] = [Secp256k1::one(); COMB_WINDOWS];
        let mut doubling = Secp256k1::offset_generator();
        let mut tail_total = Secp256k1::point_at_infinity();
        for i in 1..COMB_WINDOWS {
            doubling = doubling + doubling;
            sigma[i] = doubling;
            tail_total = tail_total + doubling;
        }
        sigma[0] = std::ops::Neg::neg(tail_total);
        sigma
    }

    /// `COMB[i][j] == j * 2^(4i) * G + SIGMA_i`, re-derived from curve arithmetic.
    #[test]
    fn comb_table_matches_curve_library() {
        let sigma = expected_offsets();
        let mut window_base = Secp256k1::one();

        for i in 0..COMB_WINDOWS {
            let mut entry = sigma[i];
            for j in 0..COMB_ENTRIES {
                if j != 0 {
                    entry = entry + window_base;
                }
                assert(COMB_X[i][j] == entry.x);
                assert(COMB_Y[i][j] == entry.y);
            }
            for _ in 0..COMB_WINDOW_BITS {
                window_base = window_base + window_base;
            }
        }
    }

    /// The property `fixed_base_mul` relies on to skip a correction step.
    #[test]
    fn offsets_cancel() {
        let sigma = expected_offsets();
        let mut total = Secp256k1::point_at_infinity();
        for i in 0..COMB_WINDOWS {
            total = total + sigma[i];
        }
        assert(total.is_infinity);
    }
}
