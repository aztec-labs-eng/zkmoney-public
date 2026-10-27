//! A set of utilities used by the refund circuits to verify the refund carries a valid migration signature.
//! See [Migration signature](../../../engineering-design-docs/oxide.md#migration-signature) in engineering-design-docs/oxide.md.
//!
//! ```text
//! refund_commitment = poseidon2_hash_with_separator([executor, user_payload_hash], DOM_SEP__MIGRATION)
//! ```
//!
//! In passkey mode, the passkey signs `refund_commitment`. In fallback-key mode, `fbsk_m` signs it.

use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar};

use aztec::protocol::{
    address::{AztecAddress, EthAddress},
    hash::poseidon2_hash_with_separator,
    public_keys::{hash_public_key, PublicKeys},
    traits::ToField,
};
use oxide_lib::account_address::{
    AccountInstancePreimage, compute_account_address, compute_passkey_hash, compute_passkey_set_immutables_hash,
    PasskeyPublicKey,
};
use oxide_lib::constants::{DOM_SEP__MIGRATION, MAX_ACCOUNT_PASSKEYS};
use oxide_lib::webauthn::{assert_valid_webauthn_signature, WebAuthnAuth};

/// `use_passkey` selects the mode. The fields of the other mode are ignored and may be zero. The refund supplies the
/// `executor` and `user_payload_hash` of the migration as its public inputs.
pub struct MigrationSignature {
    pub use_passkey: bool,
    /// Passkey mode: the P-256 passkey that signs.
    pub passkey: PasskeyPublicKey,
    /// Passkey mode: the owner's passkey set, which holds the hash of `passkey`.
    pub passkey_set: [Field; MAX_ACCOUNT_PASSKEYS],
    /// Passkey mode: the WebAuthn assertion by `passkey` over the refund commitment.
    pub webauthn: WebAuthnAuth,
    /// Fallback-key mode: the master fallback public key that the owner's `public_keys` commit to.
    pub fbpk_m: EmbeddedCurvePoint,
    /// Fallback-key mode: the Grumpkin-Schnorr signature `(s, e)` by `fbsk_m` over the refund commitment.
    pub fallback_signature: (EmbeddedCurveScalar, EmbeddedCurveScalar),
}

/// Assert that the owner of `owner` signed a migration that sends refunds to `executor` with `user_payload_hash`.
///
/// Binds `public_keys` and `instance` to `owner` with the immutables hash of the selected mode, then verifies the
/// signature of that mode.
pub fn assert_valid_migration_signature(
    owner: AztecAddress,
    public_keys: PublicKeys,
    instance: AccountInstancePreimage,
    executor: EthAddress,
    user_payload_hash: Field,
    signature: MigrationSignature,
) {
    let immutables_hash = if signature.use_passkey {
        compute_passkey_set_immutables_hash(signature.passkey_set)
    } else {
        0
    };
    assert_eq(
        compute_account_address(public_keys, instance, immutables_hash),
        owner,
        "migration signature does not match owner address",
    );

    let refund_commitment = compute_refund_commitment(executor, user_payload_hash);
    if signature.use_passkey {
        let passkey_hash = compute_passkey_hash(signature.passkey);
        assert(signature.passkey_set.any(|slot| slot == passkey_hash), "passkey is not in the owner's passkey set");
        assert_valid_webauthn_signature(signature.passkey, refund_commitment, signature.webauthn);
    } else {
        assert_eq(
            hash_public_key(signature.fbpk_m),
            public_keys.fbpk_m_hash,
            "fbpk_m does not match owner's fbpk_m_hash",
        );
        schnorr::assert_valid_signature(
            signature.fbpk_m,
            signature.fallback_signature,
            refund_commitment,
        );
    }
}

fn compute_refund_commitment(executor: EthAddress, user_payload_hash: Field) -> Field {
    poseidon2_hash_with_separator([executor.to_field(), user_payload_hash], DOM_SEP__MIGRATION)
}

mod tests {
    use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar};

    use super::{assert_valid_migration_signature, compute_refund_commitment, MigrationSignature};
    use aztec::protocol::{
        address::{AztecAddress, EthAddress},
        contract_class_id::ContractClassId,
        public_keys::{hash_public_key, IvpkM, PublicKeys},
        traits::FromField,
    };
    use oxide_lib::account_address::{
        AccountInstancePreimage, compute_account_address, compute_passkey_hash, compute_passkey_set_immutables_hash,
        PasskeyPublicKey,
    };
    use oxide_lib::constants::{MAX_ACCOUNT_PASSKEYS, WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN};
    use oxide_lib::webauthn::WebAuthnAuth;

    // Pinned migration, shared with `yarn-project/oxide-lib/src/testing/migration_vector.ts`.
    global TEST_EXECUTOR: EthAddress = EthAddress::from_field(0xe5ec);
    global TEST_USER_PAYLOAD_HASH: Field = 0x9a71;
    global TEST_REFUND_COMMITMENT: Field = 0x21354e75606ac560d687b8845876dff5d07cb672259194c591dd252783382426;

    // Pinned fallback-key signature by `signMigration` (see `yarn-project/oxide-client/src/sign_migration.ts`) with
    // `fbsk_m` 0x0f5b of the migration to `TEST_EXECUTOR`, `TEST_USER_PAYLOAD_HASH`. If the fallback tests fail, the TS
    // signer and the `schnorr` verifier disagree on the challenge construction or the domain-separation tag.
    global TEST_FBPK_M: EmbeddedCurvePoint = EmbeddedCurvePoint {
        x: 0x304f4fb549edbf4f9a4235161af958881dcff98649884e9eb25681ba48b61111,
        y: 0x13d8f03a967530037a0b0f51bd30c03fd206fa7bde24e0a66d093cab0318315e,
    };

    fn test_fallback_signature() -> (EmbeddedCurveScalar, EmbeddedCurveScalar) {
        let sig_s = EmbeddedCurveScalar::new(
            0x58507a581a350544da8efee3a146648b,
            0x03c09b97d12199dd01f2a2d8deaea87d,
        );
        let sig_e = EmbeddedCurveScalar::new(
            0x19e8cd04fa6b44a16c67bff89a3323d2,
            0x0628ad2fb55f033bcb58703a4a3a207e,
        );
        (sig_s, sig_e)
    }

    // The stub P-256 passkey of `yarn-project/deploy-lib` signed `TEST_REFUND_COMMITMENT`. The passkey-mode tests need a
    // real assertion, because only an assertion that verifies lets the execution reach the fallback verifier with its
    // zeroed inputs.
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
    // `{"type":"webauthn.get","challenge":"ITVOdWBqxWDWh7iEWHbf9dB8tnIlkZTFkd0lJ4M4JCY","origin":"https://stub.passkey.test","crossOrigin":false}`
    global TEST_CLIENT_DATA_JSON_LEN: u32 = 138;
    global TEST_CLIENT_DATA_JSON: [u8; 138] = [
        0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0x22, 0x77, 0x65, 0x62, 0x61, 0x75, 0x74, 0x68, 0x6e, 0x2e,
        0x67, 0x65, 0x74, 0x22, 0x2c, 0x22, 0x63, 0x68, 0x61, 0x6c, 0x6c, 0x65, 0x6e, 0x67, 0x65, 0x22, 0x3a, 0x22,
        0x49, 0x54, 0x56, 0x4f, 0x64, 0x57, 0x42, 0x71, 0x78, 0x57, 0x44, 0x57, 0x68, 0x37, 0x69, 0x45, 0x57, 0x48,
        0x62, 0x66, 0x39, 0x64, 0x42, 0x38, 0x74, 0x6e, 0x49, 0x6c, 0x6b, 0x5a, 0x54, 0x46, 0x6b, 0x64, 0x30, 0x6c,
        0x4a, 0x34, 0x4d, 0x34, 0x4a, 0x43, 0x59, 0x22, 0x2c, 0x22, 0x6f, 0x72, 0x69, 0x67, 0x69, 0x6e, 0x22, 0x3a,
        0x22, 0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f, 0x2f, 0x73, 0x74, 0x75, 0x62, 0x2e, 0x70, 0x61, 0x73, 0x73,
        0x6b, 0x65, 0x79, 0x2e, 0x74, 0x65, 0x73, 0x74, 0x22, 0x2c, 0x22, 0x63, 0x72, 0x6f, 0x73, 0x73, 0x4f, 0x72,
        0x69, 0x67, 0x69, 0x6e, 0x22, 0x3a, 0x66, 0x61, 0x6c, 0x73, 0x65, 0x7d,
    ];
    global TEST_SIGNATURE: [u8; 64] = [
        0xe3, 0xb7, 0xf3, 0x53, 0xc7, 0x4c, 0xfd, 0x6d, 0x9f, 0xdf, 0xd5, 0x52, 0xce, 0x6b, 0x70, 0x08, 0x84, 0x77,
        0xa2, 0x24, 0x00, 0x03, 0x84, 0x3c, 0xea, 0x6c, 0x80, 0xc4, 0x9e, 0x48, 0x6e, 0x43, 0x42, 0xb7, 0x0a, 0x9e,
        0xd7, 0x0f, 0x34, 0xf7, 0x35, 0x77, 0xae, 0x8a, 0xfb, 0x30, 0x7c, 0x2c, 0x05, 0x3c, 0x4a, 0x50, 0x0d, 0x8b,
        0x4e, 0x5c, 0x8f, 0xe5, 0xec, 0x56, 0x11, 0x6a, 0xa9, 0x4d,
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

    fn one_passkey_set() -> [Field; MAX_ACCOUNT_PASSKEYS] {
        let mut set = [0; MAX_ACCOUNT_PASSKEYS];
        set[0] = compute_passkey_hash(TEST_PASSKEY);
        set
    }

    /// A two-passkey set that holds `TEST_PASSKEY` in slot 1.
    fn two_passkey_set() -> [Field; MAX_ACCOUNT_PASSKEYS] {
        let mut set = [0; MAX_ACCOUNT_PASSKEYS];
        set[0] = OTHER_PASSKEY_HASH;
        set[1] = compute_passkey_hash(TEST_PASSKEY);
        set
    }

    global OTHER_PASSKEY_HASH: Field = 0x0689c6b6a28fe596ddfef7e415ffdfab45aca28a67d442ee9f59aa0952788e9c;

    /// A fallback-key signature with the passkey fields zeroed, as the prover supplies them.
    fn fallback_key_migration_signature() -> MigrationSignature {
        MigrationSignature {
            use_passkey: false,
            passkey: PasskeyPublicKey { x: [0; 32], y: [0; 32] },
            passkey_set: [0; MAX_ACCOUNT_PASSKEYS],
            webauthn: zero_webauthn(),
            fbpk_m: TEST_FBPK_M,
            fallback_signature: test_fallback_signature(),
        }
    }

    /// A passkey signature with the fallback fields zeroed, as the prover supplies them.
    fn passkey_migration_signature() -> MigrationSignature {
        MigrationSignature {
            use_passkey: true,
            passkey: TEST_PASSKEY,
            passkey_set: one_passkey_set(),
            webauthn: test_webauthn(),
            fbpk_m: EmbeddedCurvePoint { x: 0, y: 0 },
            fallback_signature: (EmbeddedCurveScalar::new(0, 0), EmbeddedCurveScalar::new(0, 0)),
        }
    }

    #[test]
    fn matches_the_pinned_migration() {
        assert_eq(compute_refund_commitment(TEST_EXECUTOR, TEST_USER_PAYLOAD_HASH), TEST_REFUND_COMMITMENT);
    }

    #[test]
    fn passkey_authorizes_its_owner() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let owner = compute_account_address(
            public_keys,
            instance,
            compute_passkey_set_immutables_hash(one_passkey_set()),
        );

        assert_valid_migration_signature(
            owner,
            public_keys,
            instance,
            TEST_EXECUTOR,
            TEST_USER_PAYLOAD_HASH,
            passkey_migration_signature(),
        );
    }

    #[test(should_fail_with = "clientDataJSON challenge does not match the expected challenge")]
    fn passkey_rejects_another_user_payload_hash() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let owner = compute_account_address(
            public_keys,
            instance,
            compute_passkey_set_immutables_hash(one_passkey_set()),
        );

        assert_valid_migration_signature(
            owner,
            public_keys,
            instance,
            TEST_EXECUTOR,
            TEST_USER_PAYLOAD_HASH + 1,
            passkey_migration_signature(),
        );
    }

    #[test]
    fn passkey_of_a_set_authorizes_its_owner() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let set = two_passkey_set();
        let owner = compute_account_address(
            public_keys,
            instance,
            compute_passkey_set_immutables_hash(set),
        );
        let mut signature = passkey_migration_signature();
        signature.passkey_set = set;

        assert_valid_migration_signature(
            owner,
            public_keys,
            instance,
            TEST_EXECUTOR,
            TEST_USER_PAYLOAD_HASH,
            signature,
        );
    }

    #[test(should_fail_with = "passkey is not in the owner's passkey set")]
    fn rejects_a_passkey_outside_the_set() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let mut set = [0; MAX_ACCOUNT_PASSKEYS];
        set[0] = OTHER_PASSKEY_HASH;
        let owner = compute_account_address(
            public_keys,
            instance,
            compute_passkey_set_immutables_hash(set),
        );
        let mut signature = passkey_migration_signature();
        signature.passkey_set = set;

        assert_valid_migration_signature(
            owner,
            public_keys,
            instance,
            TEST_EXECUTOR,
            TEST_USER_PAYLOAD_HASH,
            signature,
        );
    }

    #[test(should_fail_with = "migration signature does not match owner address")]
    fn rejects_a_passkey_set_the_owner_does_not_commit_to() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let owner = compute_account_address(
            public_keys,
            instance,
            compute_passkey_set_immutables_hash(two_passkey_set()),
        );

        assert_valid_migration_signature(
            owner,
            public_keys,
            instance,
            TEST_EXECUTOR,
            TEST_USER_PAYLOAD_HASH,
            passkey_migration_signature(),
        );
    }

    #[test]
    fn fallback_key_authorizes_zero_immutables_owner() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let owner = compute_account_address(public_keys, instance, 0);

        assert_valid_migration_signature(
            owner,
            public_keys,
            instance,
            TEST_EXECUTOR,
            TEST_USER_PAYLOAD_HASH,
            fallback_key_migration_signature(),
        );
    }

    #[test(should_fail_with = "migration signature does not match owner address")]
    fn passkey_owner_cannot_use_fallback_mode() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        // The owner commits to a passkey, so its address does not derive from immutables 0.
        let owner = compute_account_address(
            public_keys,
            instance,
            compute_passkey_set_immutables_hash(one_passkey_set()),
        );

        assert_valid_migration_signature(
            owner,
            public_keys,
            instance,
            TEST_EXECUTOR,
            TEST_USER_PAYLOAD_HASH,
            fallback_key_migration_signature(),
        );
    }

    #[test(should_fail_with = "migration signature does not match owner address")]
    fn zero_immutables_owner_cannot_use_passkey_mode() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let owner = compute_account_address(public_keys, instance, 0);

        assert_valid_migration_signature(
            owner,
            public_keys,
            instance,
            TEST_EXECUTOR,
            TEST_USER_PAYLOAD_HASH,
            passkey_migration_signature(),
        );
    }

    #[test(should_fail_with = "fbpk_m does not match owner's fbpk_m_hash")]
    fn rejects_fallback_key_the_owner_does_not_commit_to() {
        let mut public_keys = test_public_keys();
        public_keys.fbpk_m_hash = 0x99;
        let instance = test_instance();
        let owner = compute_account_address(public_keys, instance, 0);

        assert_valid_migration_signature(
            owner,
            public_keys,
            instance,
            TEST_EXECUTOR,
            TEST_USER_PAYLOAD_HASH,
            fallback_key_migration_signature(),
        );
    }

    #[test(should_fail)]
    fn fallback_key_rejects_another_user_payload_hash() {
        let public_keys = test_public_keys();
        let instance = test_instance();
        let owner = compute_account_address(public_keys, instance, 0);

        assert_valid_migration_signature(
            owner,
            public_keys,
            instance,
            TEST_EXECUTOR,
            TEST_USER_PAYLOAD_HASH + 1,
            fallback_key_migration_signature(),
        );
    }
}
