//! Authorization of a refund by the owner of the stranded funds.
//!
//! A refund has two authorization modes, and the owner's address selects which one applies:
//!
//! - **Passkey mode.** The address preimage commits to a P-256 passkey through
//!   `immutables_hash = compute_passkey_immutables_hash(passkey)`. The owner authorizes with a WebAuthn assertion.
//! - **Fallback-key mode.** The address preimage has `immutables_hash = 0`, so the address commits to no passkey. We
//!   call such an owner a **fallback-key owner**. The owner authorizes with a Grumpkin-Schnorr signature under the
//!   master fallback key `fbpk_m` that the address does commit to through `public_keys`. This mode keeps the funds of
//!   an owner that has no passkey recoverable: an escrow contract whose keys derive from a shared secret, for
//!   example, has no passkey, and whoever knows the secret derives `fbsk_m` and recovers the funds. That is the
//!   bearer semantics such an escrow has by design.
//!
//! The prover picks the mode with a boolean, and that is safe because the address check pins it: the circuit
//! recomputes the owner's address from the mode's immutables hash, so a passkey account presented in fallback mode
//! hashes to a different address (immutables 0 instead of `H(passkey)`) and fails, and a fallback-key owner presented
//! in passkey mode fails the same way.
//!
//! Neither verifier aborts on them: the zeroed `fbpk_m` is the point at infinity, which `multi_scalar_mul` accepts,
//! and `std::ecdsa_secp256r1::verify_signature` returns false for a zeroed key and signature instead of panicking.

use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar};

use aztec::protocol::{address::AztecAddress, public_keys::{hash_public_key, PublicKeys}};
use oxide_lib::account_address::{
    AccountInstancePreimage, compute_account_address, compute_passkey_immutables_hash, PasskeyPublicKey,
};
use oxide_lib::webauthn::{assert_valid_webauthn_signature, WebAuthnAuth};

/// The owner's authorization of a refund. `use_passkey` selects the mode; the fields of the other mode are ignored
/// and may be zero.
pub struct RefundAuthorization {
    pub use_passkey: bool,
    /// Passkey mode: the P-256 passkey the owner's `immutables_hash` commits to.
    pub passkey: PasskeyPublicKey,
    /// Passkey mode: the WebAuthn assertion by `passkey` over the auth message.
    pub webauthn: WebAuthnAuth,
    /// Fallback-key mode: the master fallback public key the owner's `public_keys` commit to.
    pub fbpk_m: EmbeddedCurvePoint,
    /// Fallback-key mode: the Grumpkin-Schnorr signature `(s, e)` by `fbsk_m` over the auth message.
    pub fallback_signature: (EmbeddedCurveScalar, EmbeddedCurveScalar),
}

/// Assert that the owner of `owner` authorized `auth_message`.
///
/// Binds `public_keys` and `instance` to `owner` with the immutables hash of the selected mode, then verifies the
/// authorization of that mode. See the module documentation for why the prover may pick the mode.
pub fn assert_refund_authorized(
    owner: AztecAddress,
    public_keys: PublicKeys,
    instance: AccountInstancePreimage,
    auth_message: Field,
    auth: RefundAuthorization,
) {
    let immutables_hash = if auth.use_passkey {
        compute_passkey_immutables_hash(auth.passkey)
    } else {
        0
    };
    assert_eq(
        compute_account_address(public_keys, instance, immutables_hash),
        owner,
        "refund authorization does not match owner address",
    );

    if auth.use_passkey {
        assert_valid_webauthn_signature(auth.passkey, auth_message, auth.webauthn);
    } else {
        assert_eq(hash_public_key(auth.fbpk_m), public_keys.fbpk_m_hash, "fbpk_m does not match owner's fbpk_m_hash");
        schnorr::assert_valid_signature(auth.fbpk_m, auth.fallback_signature, auth_message);
    }
}

mod tests {
    use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar};

    use super::{assert_refund_authorized, RefundAuthorization};
    use aztec::protocol::{
        address::AztecAddress,
        contract_class_id::ContractClassId,
        public_keys::{hash_public_key, IvpkM, PublicKeys},
        traits::FromField,
    };
    use oxide_lib::account_address::{
        AccountInstancePreimage, compute_account_address, compute_passkey_immutables_hash, PasskeyPublicKey,
    };
    use oxide_lib::constants::WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN;
    use oxide_lib::webauthn::WebAuthnAuth;

    // Pinned regression vector produced by `signGrumpkinSchnorrPoseidon` (see
    // `yarn-project/oxide-client/src/refund_signature.ts`). If the fallback tests fail, the TS signer and the
    // `schnorr` verifier disagree on the challenge construction or the domain-separation tag.
    global TEST_FBPK_M: EmbeddedCurvePoint = EmbeddedCurvePoint {
        x: 0x1e80aee3834e1297b47c859a4a26339b5c7c4c4096342b360e2b7ba402d1873e,
        y: 0x0e3faf018f2e20f0811785d35bd8491f32e42833ede83ca1a5f3e1975ce7e25e,
    };
    global TEST_AUTH_MESSAGE: Field = 0x18380a3a4dec4daa04fe30592fa1f43bce1fb7e07fbcf136954ce1d9ce76cf98;

    fn test_fallback_signature() -> (EmbeddedCurveScalar, EmbeddedCurveScalar) {
        let sig_s = EmbeddedCurveScalar::new(
            0x6a1dd97eb78ccc24b60bd53321cb429e,
            0x2ba20f83a2def7338dfa653199c04c06,
        );
        let sig_e = EmbeddedCurveScalar::new(
            0xb153a8fceb0a892b58626323643da58c,
            0x24d6adb66f60e0431989b72b59ad0b1f,
        );
        (sig_s, sig_e)
    }

    // Pinned WebAuthn assertion over `TEST_AUTH_MESSAGE` by the stub P-256 passkey of `yarn-project/deploy-lib`,
    // copied from the tests of `oxide_lib::webauthn`. The passkey-mode tests need a real assertion, because only an
    // assertion that verifies lets the execution reach the fallback verifier with its zeroed inputs.
    global TEST_PASSKEY: PasskeyPublicKey = PasskeyPublicKey {
        x: [
            0xd8, 0xcd, 0x12, 0xea, 0x5c, 0x67, 0xf2, 0xf8, 0xa0, 0x0c, 0x11, 0x24, 0x89, 0x3e, 0xdc, 0xfa, 0x67, 0x54,
            0xc4, 0xd6, 0xce, 0xde, 0x6b, 0xe1, 0x3b, 0xdf, 0x22, 0x95, 0xc8, 0x10, 0xa9, 0x7f,
        ],
        y: [
            0xa5, 0xa8, 0x9d, 0x2d, 0x2a, 0x36, 0x0c, 0x0c, 0xa9, 0xa4, 0xd6, 0xc7, 0xc9, 0xed, 0x4b, 0x28, 0xd3, 0xe1,
            0x99, 0xd6, 0x62, 0x7f, 0x2e, 0x69, 0x6d, 0x68, 0x9c, 0x31, 0x0a, 0x5b, 0x0f, 0x48,
        ],
    };
    global TEST_AUTHENTICATOR_DATA: [u8; 37] = [
        0x06, 0xcc, 0x72, 0xc2, 0xe6, 0x6c, 0xe5, 0x75, 0x4e, 0xa5, 0x79, 0x2b, 0xa3, 0x91, 0x9b, 0x3e, 0x49, 0x35,
        0xe7, 0x01, 0x9a, 0x17, 0x23, 0xe2, 0x5c, 0xab, 0xde, 0x11, 0x34, 0xef, 0xc6, 0xf9, 0x05, 0x00, 0x00, 0x00,
        0x07,
    ];
    // `{"type":"webauthn.get","challenge":"GDgKOk3sTaoE_jBZL6H0O84ft-B_vPE2lUzh2c52z5g","origin":"https://stub.passkey.test","crossOrigin":false}`
    global TEST_CLIENT_DATA_JSON_LEN: u32 = 138;
    global TEST_CLIENT_DATA_JSON: [u8; 138] = [
        0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0x22, 0x77, 0x65, 0x62, 0x61, 0x75, 0x74, 0x68, 0x6e, 0x2e,
        0x67, 0x65, 0x74, 0x22, 0x2c, 0x22, 0x63, 0x68, 0x61, 0x6c, 0x6c, 0x65, 0x6e, 0x67, 0x65, 0x22, 0x3a, 0x22,
        0x47, 0x44, 0x67, 0x4b, 0x4f, 0x6b, 0x33, 0x73, 0x54, 0x61, 0x6f, 0x45, 0x5f, 0x6a, 0x42, 0x5a, 0x4c, 0x36,
        0x48, 0x30, 0x4f, 0x38, 0x34, 0x66, 0x74, 0x2d, 0x42, 0x5f, 0x76, 0x50, 0x45, 0x32, 0x6c, 0x55, 0x7a, 0x68,
        0x32, 0x63, 0x35, 0x32, 0x7a, 0x35, 0x67, 0x22, 0x2c, 0x22, 0x6f, 0x72, 0x69, 0x67, 0x69, 0x6e, 0x22, 0x3a,
        0x22, 0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f, 0x2f, 0x73, 0x74, 0x75, 0x62, 0x2e, 0x70, 0x61, 0x73, 0x73,
        0x6b, 0x65, 0x79, 0x2e, 0x74, 0x65, 0x73, 0x74, 0x22, 0x2c, 0x22, 0x63, 0x72, 0x6f, 0x73, 0x73, 0x4f, 0x72,
        0x69, 0x67, 0x69, 0x6e, 0x22, 0x3a, 0x66, 0x61, 0x6c, 0x73, 0x65, 0x7d,
    ];
    global TEST_SIGNATURE: [u8; 64] = [
        0xcc, 0x37, 0x3c, 0x50, 0x5a, 0x3e, 0x68, 0x9a, 0x64, 0xd0, 0x54, 0x8f, 0x07, 0x66, 0xe6, 0xf5, 0xf3, 0x68,
        0xd1, 0x57, 0x0f, 0xe0, 0x38, 0x19, 0xd8, 0x18, 0xb9, 0xee, 0xb0, 0x77, 0x53, 0x1a, 0x61, 0xe5, 0x9a, 0x8c,
        0x9c, 0x0c, 0x7e, 0x38, 0xcb, 0xee, 0x29, 0x6f, 0x44, 0xdf, 0x3b, 0xe1, 0x8d, 0xec, 0x79, 0x6c, 0x3c, 0x01,
        0x23, 0xed, 0xc9, 0xd1, 0xee, 0x89, 0x92, 0xf0, 0x03, 0xd9,
    ];

    fn test_webauthn() -> WebAuthnAuth {
        let mut client_data_json: [u8; WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN] = [0; WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN];
        for i in 0..TEST_CLIENT_DATA_JSON_LEN {
            client_data_json[i] = TEST_CLIENT_DATA_JSON[i];
        }
        WebAuthnAuth {
            authenticator_data: TEST_AUTHENTICATOR_DATA,
            client_data_json,
            client_data_json_len: TEST_CLIENT_DATA_JSON_LEN,
            signature: TEST_SIGNATURE,
        }
    }

    fn zero_webauthn() -> WebAuthnAuth {
        WebAuthnAuth {
            authenticator_data: [0; 37],
            client_data_json: [0; WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN],
            client_data_json_len: 0,
            signature: [0; 64],
        }
    }

    fn test_instance() -> AccountInstancePreimage {
        AccountInstancePreimage {
            contract_class_id: ContractClassId::from_field(0x1234),
            salt: 0x5678,
            initialization_hash: 0x9abc,
            deployer: AztecAddress::from_field(0),
        }
    }

    /// Public keys whose `fbpk_m_hash` commits to the pinned fallback key.
    fn test_public_keys() -> PublicKeys {
        PublicKeys {
            npk_m_hash: 0x11,
            ivpk_m: IvpkM { inner: EmbeddedCurvePoint::generator() },
            ovpk_m_hash: 0x22,
            tpk_m_hash: 0x33,
            mspk_m_hash: 0x44,
            fbpk_m_hash: hash_public_key(TEST_FBPK_M),
        }
    }

    /// A fallback-key authorization with the passkey fields zeroed, as the prover supplies them.
    fn fallback_authorization() -> RefundAuthorization {
        RefundAuthorization {
            use_passkey: false,
            passkey: PasskeyPublicKey { x: [0; 32], y: [0; 32] },
            webauthn: zero_webauthn(),
            fbpk_m: TEST_FBPK_M,
            fallback_signature: test_fallback_signature(),
        }
    }

    /// A passkey authorization with the fallback fields zeroed, as the prover supplies them.
    fn passkey_authorization() -> RefundAuthorization {
        RefundAuthorization {
            use_passkey: true,
            passkey: TEST_PASSKEY,
            webauthn: test_webauthn(),
            fbpk_m: EmbeddedCurvePoint { x: 0, y: 0 },
            fallback_signature: (EmbeddedCurveScalar::new(0, 0), EmbeddedCurveScalar::new(0, 0)),
        }
    }

    #[test]
    fn passkey_authorizes_its_owner() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let owner = compute_account_address(
            public_keys,
            instance,
            compute_passkey_immutables_hash(TEST_PASSKEY),
        );

        assert_refund_authorized(
            owner,
            public_keys,
            instance,
            TEST_AUTH_MESSAGE,
            passkey_authorization(),
        );
    }

    #[test]
    fn fallback_key_authorizes_zero_immutables_owner() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let owner = compute_account_address(public_keys, instance, 0);

        assert_refund_authorized(
            owner,
            public_keys,
            instance,
            TEST_AUTH_MESSAGE,
            fallback_authorization(),
        );
    }

    #[test(should_fail_with = "refund authorization does not match owner address")]
    fn passkey_owner_cannot_use_fallback_mode() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        // The owner commits to a passkey, so its address does not derive from immutables 0.
        let owner = compute_account_address(
            public_keys,
            instance,
            compute_passkey_immutables_hash(TEST_PASSKEY),
        );

        assert_refund_authorized(
            owner,
            public_keys,
            instance,
            TEST_AUTH_MESSAGE,
            fallback_authorization(),
        );
    }

    #[test(should_fail_with = "refund authorization does not match owner address")]
    fn zero_immutables_owner_cannot_use_passkey_mode() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let owner = compute_account_address(public_keys, instance, 0);

        assert_refund_authorized(
            owner,
            public_keys,
            instance,
            TEST_AUTH_MESSAGE,
            passkey_authorization(),
        );
    }

    #[test(should_fail_with = "fbpk_m does not match owner's fbpk_m_hash")]
    fn rejects_fallback_key_the_owner_does_not_commit_to() {
        let mut public_keys = test_public_keys();
        public_keys.fbpk_m_hash = 0x99;
        let instance = test_instance();
        let owner = compute_account_address(public_keys, instance, 0);

        assert_refund_authorized(
            owner,
            public_keys,
            instance,
            TEST_AUTH_MESSAGE,
            fallback_authorization(),
        );
    }

    #[test(should_fail)]
    fn rejects_a_wrong_fallback_signature() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let owner = compute_account_address(public_keys, instance, 0);

        // The signature is over the pinned message, so any other message must not verify.
        assert_refund_authorized(
            owner,
            public_keys,
            instance,
            TEST_AUTH_MESSAGE + 1,
            fallback_authorization(),
        );
    }
}
