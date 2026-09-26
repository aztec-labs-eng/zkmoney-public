// TXE tests for OidcKeyRegistry: adding/removing issuer JWKs and auds, the per-issuer
// generation-counter rotation semantics, issuer scoping, the operator/guardian role split, and the
// pause switch. h_iss / jwk_id / aud values are opaque Fields to the contract (it only hashes and
// stores them), so arbitrary test constants exercise the full state machine.
use crate::OidcKeyRegistry;

use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};

global GOOGLE_H_ISS: Field = 0x6f6f676c65; // arbitrary stand-ins for poseidon2_hash_packed(iss)
global APPLE_H_ISS: Field = 0x6170706c65;
global K1: Field = 1001;
global K2: Field = 1002;
global K3: Field = 1003;
global AUD1: Field = 5001;
global AUD2: Field = 5002;

fn pad1(a: Field) -> [Field; 10] {
    [a, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}
fn pad2(a: Field, b: Field) -> [Field; 10] {
    [a, b, 0, 0, 0, 0, 0, 0, 0, 0]
}
fn empty() -> [Field; 10] {
    [0; 10]
}

// Returns (env, registry address, operator, guardian, other).
unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();

    let operator = env.create_light_account();
    let guardian = env.create_light_account();
    let other = env.create_light_account();

    let initializer_call = OidcKeyRegistry::interface().constructor(operator, guardian);
    let addr = env.deploy("OidcKeyRegistry").with_public_initializer(operator, initializer_call);

    (env, addr, operator, guardian, other)
}

//--------------------------- JWK add / scope / removal ---------------------------

#[test]
unconstrained fn operator_sets_jwks_and_they_validate() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad2(K1, K2), 2));

    assert(env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K1)), "K1 should be valid");
    assert(env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K2)), "K2 should be valid");
    // a key that was never listed is not valid
    assert(!env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K3)), "K3 should be invalid");
    // issuer scoping: the same key under a different issuer is not valid
    assert(!env.view_public(c.is_valid_jwk(APPLE_H_ISS, K1)), "K1 must not validate under Apple");
}

#[test]
unconstrained fn issuers_are_independent() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad1(K1), 1));
    env.call_public(operator, c.set_issuer_jwks(APPLE_H_ISS, pad1(K2), 1));

    assert(env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K1)), "google K1 valid");
    assert(env.view_public(c.is_valid_jwk(APPLE_H_ISS, K2)), "apple K2 valid");
    assert(!env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K2)), "google must not have apple's key");
}

#[test]
unconstrained fn relist_drops_removed_key_keeps_survivor() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad2(K1, K2), 2));
    // re-list with only K1 (K2 rotated out) - bumps the generation
    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad1(K1), 1));

    assert(env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K1)), "survivor K1 still valid");
    assert(!env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K2)), "dropped K2 now invalid");
}

#[test]
unconstrained fn relist_same_set_keeps_keys_valid() {
    // a routine re-sync that re-lists the SAME keys keeps already-issued proofs valid, because
    // the contract recomputes the scoped key at the CURRENT generation at claim time.
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad2(K1, K2), 2));
    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad2(K1, K2), 2));

    assert(env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K1)), "K1 still valid after re-list");
    assert(env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K2)), "K2 still valid after re-list");
}

#[test]
unconstrained fn empty_set_invalidates_all_keys() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad2(K1, K2), 2));
    // count == 0 is O(1) full invalidation (generation bump, no writes)
    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, empty(), 0));

    assert(!env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K1)), "K1 invalidated");
    assert(!env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K2)), "K2 invalidated");
}

//--------------------------- AUD allowlist ---------------------------

#[test]
unconstrained fn operator_adds_and_removes_aud() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    assert(!env.view_public(c.is_aud_allowed(AUD1)), "aud not allowed initially");
    env.call_public(operator, c.add_aud(AUD1));
    assert(env.view_public(c.is_aud_allowed(AUD1)), "aud allowed after add");
    env.call_public(operator, c.remove_aud(AUD1));
    assert(!env.view_public(c.is_aud_allowed(AUD1)), "aud not allowed after remove");
    assert(!env.view_public(c.is_aud_allowed(AUD2)), "unrelated aud never allowed");
}

//--------------------------- assert_valid (claim-time check) ---------------------------

#[test]
unconstrained fn assert_valid_passes_for_listed_key_and_allowed_aud() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(operator, c.add_aud(AUD1));
    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad1(K1), 1));

    // Should not revert: a token issued "now" is within the freshness window.
    let iat = env.last_block_timestamp();
    env.view_public(c.assert_valid(GOOGLE_H_ISS, AUD1, K1, iat));
}

#[test(should_fail_with = "invalid aud")]
unconstrained fn assert_valid_fails_when_aud_not_allowed() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad1(K1), 1));
    // aud was never added
    env.view_public(c.assert_valid(GOOGLE_H_ISS, AUD1, K1, env.last_block_timestamp()));
}

#[test(should_fail_with = "invalid jwk")]
unconstrained fn assert_valid_fails_for_unlisted_key() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(operator, c.add_aud(AUD1));
    // no jwks set for the issuer
    env.view_public(c.assert_valid(GOOGLE_H_ISS, AUD1, K1, env.last_block_timestamp()));
}

#[test(should_fail_with = "stale zkJWT proof")]
unconstrained fn assert_valid_fails_for_stale_iat() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(operator, c.add_aud(AUD1));
    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad1(K1), 1));

    // Issuer/aud/jwk are all valid, but the login token is older than IAT_ALLOWED_DELAY (14 days),
    // so the claim-time freshness gate must reject it. 1_209_600 == IAT_ALLOWED_DELAY.
    let iat = env.last_block_timestamp();
    env.mine_block_at(iat + 1_209_600 + 1);
    env.view_public(c.assert_valid(GOOGLE_H_ISS, AUD1, K1, iat));
}

//--------------------------- guardian: invalidate / pause / rotate ---------------------------

#[test]
unconstrained fn guardian_invalidates_issuer() {
    let (env, addr, operator, guardian, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad2(K1, K2), 2));
    env.call_public(guardian, c.invalidate_issuer(GOOGLE_H_ISS));

    assert(!env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K1)), "K1 invalidated by guardian");
    assert(!env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K2)), "K2 invalidated by guardian");
}

#[test]
unconstrained fn guardian_rotates_operator() {
    let (env, addr, _operator, guardian, other) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(guardian, c.rotate_operator(other));
    // the new operator can now write
    env.call_public(other, c.set_issuer_jwks(GOOGLE_H_ISS, pad1(K1), 1));
    assert(env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K1)), "new operator can set jwks");
}

#[test]
unconstrained fn pause_then_unpause_restores_operator_writes() {
    let (env, addr, operator, guardian, _) = setup();
    let c = OidcKeyRegistry::at(addr);

    env.call_public(guardian, c.set_paused(true));
    env.call_public(guardian, c.set_paused(false));
    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad1(K1), 1));
    assert(env.view_public(c.is_valid_jwk(GOOGLE_H_ISS, K1)), "writes work again after unpause");
}

//--------------------------- access control: rejections ---------------------------

#[test(should_fail_with = "only operator")]
unconstrained fn non_operator_cannot_set_jwks() {
    let (env, addr, _, _, other) = setup();
    let c = OidcKeyRegistry::at(addr);
    env.call_public(other, c.set_issuer_jwks(GOOGLE_H_ISS, pad1(K1), 1));
}

#[test(should_fail_with = "only operator")]
unconstrained fn guardian_cannot_set_jwks() {
    let (env, addr, _, guardian, _) = setup();
    let c = OidcKeyRegistry::at(addr);
    env.call_public(guardian, c.set_issuer_jwks(GOOGLE_H_ISS, pad1(K1), 1));
}

#[test(should_fail_with = "only operator")]
unconstrained fn non_operator_cannot_add_aud() {
    let (env, addr, _, _, other) = setup();
    let c = OidcKeyRegistry::at(addr);
    env.call_public(other, c.add_aud(AUD1));
}

#[test(should_fail_with = "only guardian")]
unconstrained fn operator_cannot_invalidate_issuer() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);
    env.call_public(operator, c.invalidate_issuer(GOOGLE_H_ISS));
}

#[test(should_fail_with = "only guardian")]
unconstrained fn operator_cannot_pause() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);
    env.call_public(operator, c.set_paused(true));
}

#[test(should_fail_with = "only guardian")]
unconstrained fn operator_cannot_rotate_operator() {
    let (env, addr, operator, _, other) = setup();
    let c = OidcKeyRegistry::at(addr);
    env.call_public(operator, c.rotate_operator(other));
}

//--------------------------- pause + bounds revert paths ---------------------------

#[test(should_fail_with = "registry paused")]
unconstrained fn paused_blocks_set_jwks() {
    let (env, addr, operator, guardian, _) = setup();
    let c = OidcKeyRegistry::at(addr);
    env.call_public(guardian, c.set_paused(true));
    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, pad1(K1), 1));
}

#[test(should_fail_with = "too many keys for issuer")]
unconstrained fn rejects_count_over_max() {
    let (env, addr, operator, _, _) = setup();
    let c = OidcKeyRegistry::at(addr);
    // count exceeds MAX_KEYS_PER_ISSUER (10) - fail closed rather than silently drop
    env.call_public(operator, c.set_issuer_jwks(GOOGLE_H_ISS, empty(), 11));
}
