//! K1 limb types and hash helpers used by `main.nr`.

use bigcurve::curves::secp256k1::{Secp256k1, Secp256k1Scalar};
use bignum::{BigNum, Secp256k1_Fq, Secp256k1_Fr};
use oxide_lib::constants::{K1_N_HI, K1_N_LO, K1_P_HI, K1_P_LO};

pub struct K1Scalar {
    pub scalar_lo: u128,
    pub scalar_hi: u128,
}

impl K1Scalar {
    /// 32 big-endian bytes. Asserts the scalar is in the field.
    pub fn to_be_bytes(self) -> [u8; 32] {
        assert(lt_u256(self.scalar_hi, self.scalar_lo, K1_N_HI, K1_N_LO), "scalar not in field");
        u256_to_be_bytes(self.scalar_hi, self.scalar_lo)
    }

    /// Convert to a noir_bigcurve `Secp256k1Scalar`. Asserts the scalar is in the field.
    pub fn to_scalar(self) -> Secp256k1Scalar {
        assert(lt_u256(self.scalar_hi, self.scalar_lo, K1_N_HI, K1_N_LO), "scalar not in field");
        let scalar_fr: Secp256k1_Fr = Secp256k1_Fr::from_be_bytes(u256_to_be_bytes(self.scalar_hi, self.scalar_lo));
        let scalar: Secp256k1Scalar = Secp256k1Scalar::from_bignum(scalar_fr);
        scalar
    }
}

/// A secp256k1 public key as the lo/hi 128-bit halves of its affine coordinates.
pub struct K1Point {
    pub xlo: u128,
    pub xhi: u128,
    pub ylo: u128,
    pub yhi: u128,
}

impl K1Point {
    /// Convert to a noir_bigcurve `Secp256k1`. Asserts each coordinate fits into Fq.
    pub fn to_secp256k1(self) -> Secp256k1 {
        assert(lt_u256(self.xhi, self.xlo, K1_P_HI, K1_P_LO), "x not in field");
        assert(lt_u256(self.yhi, self.ylo, K1_P_HI, K1_P_LO), "y not in field");
        let x: Secp256k1_Fq = Secp256k1_Fq::from_be_bytes(u256_to_be_bytes(self.xhi, self.xlo));
        let y: Secp256k1_Fq = Secp256k1_Fq::from_be_bytes(u256_to_be_bytes(self.yhi, self.ylo));
        Secp256k1 { x, y, is_infinity: false }
    }
}

/// Strict less-than on 256-bit values held as (hi, lo) 128-bit limbs.
fn lt_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> bool {
    (a_hi < b_hi) | ((a_hi == b_hi) & (a_lo < b_lo))
}

/// Serialize a 256-bit value held as (hi, lo) 128-bit limbs to 32 big-endian bytes.
fn u256_to_be_bytes(hi: u128, lo: u128) -> [u8; 32] {
    let hi_bytes: [u8; 16] = (hi as Field).to_be_bytes();
    let lo_bytes: [u8; 16] = (lo as Field).to_be_bytes();
    hi_bytes.concat(lo_bytes)
}

/// Reinterpret a BN254 field digest as a secp256k1 scalar.
pub fn field_digest_to_scalar(digest: Field) -> Secp256k1Scalar {
    Secp256k1Scalar::from_bignum(Secp256k1_Fr::from(digest))
}

/// Serialize Field elements to 32-byte big-endian words and concatenate.
pub fn fields_to_be_bytes<let N: u32>(fields: [Field; N]) -> [u8; N * 32] {
    let mut bytes: [u8; N * 32] = [0; N * 32];
    for i in 0..N {
        let word: [u8; 32] = fields[i].to_be_bytes();
        for j in 0..32 {
            bytes[i * 32 + j] = word[j];
        }
    }
    bytes
}

/// Serialize a Secp256k1 point to 64 uncompressed big-endian bytes (x || y).
pub fn point_to_be_bytes(p: Secp256k1) -> [u8; 64] {
    p.x.to_be_bytes().concat(p.y.to_be_bytes())
}

mod test {
    use super::{field_digest_to_scalar, K1_P_HI, K1_P_LO, K1Point, u256_to_be_bytes};
    use bigcurve::BigCurve;
    use bigcurve::curves::secp256k1::{Secp256k1, Secp256k1Scalar};
    use bignum::{bignum::BigNum, Secp256k1_Fr};

    // 2*G on secp256k1, as lo/hi halves of its affine coordinates.
    fn two_g() -> K1Point {
        K1Point {
            xhi: 0xc6047f9441ed7d6d3045406e95c07cd8,
            xlo: 0x5c778e4b8cef3ca7abac09b95c709ee5,
            yhi: 0x1ae168fea63dc339a3c58419466ceaee,
            ylo: 0xf7f632653266d0e1236431a950cfe52a,
        }
    }

    #[test]
    fn k1point_lifts_to_expected_point() {
        let lifted = two_g().to_secp256k1();
        lifted.validate_on_curve();
        let expected = Secp256k1::one().mul(Secp256k1Scalar::from(2));
        assert(lifted.eq(expected));
    }

    #[test(should_fail_with = "x not in field")]
    fn k1point_rejects_x_at_prime() {
        // x = p exactly: the smallest non-canonical encoding.
        let mut p = two_g();
        p.xhi = K1_P_HI;
        p.xlo = K1_P_LO;
        let _ = p.to_secp256k1();
    }

    #[test]
    fn u256_to_be_bytes_roundtrip() {
        let bytes = u256_to_be_bytes(
            0x0102030405060708090a0b0c0d0e0f10,
            0x1112131415161718191a1b1c1d1e1f20,
        );
        for i in 0..32 {
            assert(bytes[i] == (i + 1) as u8);
        }
    }

    /// DANGEROUS: Convert a secp256k1 scalar to a BN254 field, reducing it mod p.
    fn scalar_to_field(s: Secp256k1Scalar) -> Field {
        // Limb weights for the base-2^120 bignum.
        let two_pow_120: Field = 0x1000000000000000000000000000000;
        let two_pow_240: Field = 0x1000000000000000000000000000000000000000000000000000000000000;
        let bn: Secp256k1_Fr = s.into_bignum();
        let limbs: [u128; 3] = bn.get_limbs();
        limbs[0] as Field + (limbs[1] as Field) * two_pow_120 + (limbs[2] as Field) * two_pow_240
    }

    // A scalar below the BN254 modulus survives a scalar -> field -> scalar roundtrip:
    // `scalar_to_field` reduces mod p (a no-op while in range) and `field_digest_to_scalar`
    // reinterprets the field as a scalar.
    #[test]
    fn scalar_field_roundtrip() {
        let s = Secp256k1Scalar::from(
            0x123456789abcdef0fedcba9876543210123456789abcdef0fedcba98765432,
        );
        let roundtripped = field_digest_to_scalar(scalar_to_field(s));
        let s_bn: Secp256k1_Fr = s.into_bignum();
        let roundtripped_bn: Secp256k1_Fr = roundtripped.into_bignum();
        assert(roundtripped_bn == s_bn);
    }
}
