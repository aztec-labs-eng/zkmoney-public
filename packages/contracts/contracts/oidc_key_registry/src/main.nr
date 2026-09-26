// OidcKeyRegistry: single-purpose registry attesting the currently-trusted Apple/Google JSON Web
// Key Sets used to claim email payment links (zkJWT). It replaces the old EmailRegistry, whose
// email<->address association feature has been removed.
//
// Trusted keys are scoped per issuer behind a monotonic generation counter:
//   valid(iss, pubkey) := jwks_allowlist[ Poseidon2([H(iss), update_index[H(iss)], pubkey_hash]) ]
// Rotation is a single atomic call (set_issuer_jwks) that bumps the issuer's generation and writes
// the whole current key set; invalidating an issuer is just bumping the generation with no writes,
// which makes every prior-generation scoped key unreachable in O(1).
//
// The generation counter lives only on-chain and is never an input to the zkJWT proof: a proof
// commits to (issuer, pubkey, ...), and the contract recomputes the scoped key at the CURRENT
// generation at claim time. A routine re-sync that re-lists the same keys therefore keeps already
// generated proofs valid.
//
// Two-role access:
//   - operator (hot, the backend cron): routine set_issuer_jwks / add_aud / remove_aud
//   - guardian (cold): rotate the operator, invalidate any issuer, and pause claims
// The guardian deliberately CANNOT write keys (only invalidate), so a compromised guardian key can
// freeze/revoke but cannot inject a malicious key.

mod test;

use aztec::macros::aztec;

#[aztec]
pub contract OidcKeyRegistry {
    use aztec::{
        macros::{functions::{external, initializer, view}, storage::storage},
        protocol::address::AztecAddress,
        state_vars::{Map, PublicMutable},
    };
    use poseidon::poseidon2::Poseidon2;

    // Max trusted keys per issuer written in one atomic update. Google/Apple expose ~2-4 keys;
    // 10 is comfortable headroom including rotation overlaps. Exceeding it reverts (fail-closed)
    // rather than silently dropping a key.
    global MAX_KEYS_PER_ISSUER: u32 = 10;

    // Max age of a zkJWT's iat for a claim proof to be accepted (14 days). Bounds how long a cached
    // proof stays claimable, so a stale login token cannot claim after the email is reassigned to a
    // new owner. Enforced here rather than in the caller because assert_valid is already an
    // enqueued public call, so claim() pays no extra call to read the block timestamp.
    global IAT_ALLOWED_DELAY: u64 = 1_209_600; // 14 * 24 * 60 * 60

    #[storage]
    struct Storage<Context> {
        operator: PublicMutable<AztecAddress, Context>,
        guardian: PublicMutable<AztecAddress, Context>,
        paused: PublicMutable<bool, Context>,
        // H(iss) -> current generation counter (0 until the issuer is first set)
        update_index: Map<Field, PublicMutable<u64, Context>, Context>,
        // Poseidon2([H(iss), gen, pubkey_hash]) -> trusted
        jwks_allowlist: Map<Field, PublicMutable<bool, Context>, Context>,
        // aud_hash -> allowed
        aud_allowlist: Map<Field, PublicMutable<bool, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(operator: AztecAddress, guardian: AztecAddress) {
        self.storage.operator.write(operator);
        self.storage.guardian.write(guardian);
        self.storage.paused.write(false);
    }

    //--------------------------OPERATOR: JWK rotation--------------------------

    // Atomically replace an issuer's trusted key set: bump the generation and write the first
    // `count` pubkey hashes under the new generation. Empty (count == 0) = O(1) full invalidation.
    #[external("public")]
    fn set_issuer_jwks(h_iss: Field, pubkey_hashes: [Field; MAX_KEYS_PER_ISSUER], count: u32) {
        assert(self.msg_sender() == self.storage.operator.read(), "only operator");
        assert(!self.storage.paused.read(), "registry paused");
        assert(count <= MAX_KEYS_PER_ISSUER, "too many keys for issuer");

        let gen = self.storage.update_index.at(h_iss).read() + 1;
        self.storage.update_index.at(h_iss).write(gen);

        for i in 0..MAX_KEYS_PER_ISSUER {
            if i < count {
                let scoped = Poseidon2::hash([h_iss, gen as Field, pubkey_hashes[i]], 3);
                self.storage.jwks_allowlist.at(scoped).write(true);
            }
        }
    }

    //--------------------------OPERATOR: aud allowlist--------------------------

    #[external("public")]
    fn add_aud(aud: Field) {
        assert(self.msg_sender() == self.storage.operator.read(), "only operator");
        assert(!self.storage.paused.read(), "registry paused");
        self.storage.aud_allowlist.at(aud).write(true);
    }

    #[external("public")]
    fn remove_aud(aud: Field) {
        assert(self.msg_sender() == self.storage.operator.read(), "only operator");
        assert(!self.storage.paused.read(), "registry paused");
        self.storage.aud_allowlist.at(aud).write(false);
    }

    //--------------------------GUARDIAN: invalidate / pause / rotate--------------------------

    // Invalidate an entire issuer's key set in O(1) by bumping the generation with no key writes.
    #[external("public")]
    fn invalidate_issuer(h_iss: Field) {
        assert(self.msg_sender() == self.storage.guardian.read(), "only guardian");
        let gen = self.storage.update_index.at(h_iss).read() + 1;
        self.storage.update_index.at(h_iss).write(gen);
    }

    #[external("public")]
    fn set_paused(paused: bool) {
        assert(self.msg_sender() == self.storage.guardian.read(), "only guardian");
        self.storage.paused.write(paused);
    }

    #[external("public")]
    fn rotate_operator(new_operator: AztecAddress) {
        assert(self.msg_sender() == self.storage.guardian.read(), "only guardian");
        self.storage.operator.write(new_operator);
    }

    //--------------------------CLAIM-TIME CHECK--------------------------

    // Assert (issuer, pubkey) is trusted at the current generation, the aud is allowed, and the login
    // token is still fresh. Called by PaylinkEmail.claim; h_iss, pubkey_hash and iat come from the
    // verified zkJWT proof. Freshness is checked last so the aud / jwk revert reasons still surface
    // first when a proof is both untrusted and stale.
    #[external("public")]
    #[view]
    fn assert_valid(h_iss: Field, aud: Field, pubkey_hash: Field, iat: u64) {
        assert(!self.storage.paused.read(), "registry paused");
        assert(self.storage.aud_allowlist.at(aud).read(), "invalid aud");
        let gen = self.storage.update_index.at(h_iss).read();
        let scoped = Poseidon2::hash([h_iss, gen as Field, pubkey_hash], 3);
        assert(self.storage.jwks_allowlist.at(scoped).read(), "invalid jwk");
        assert(self.context.timestamp() <= iat + IAT_ALLOWED_DELAY, "stale zkJWT proof");
    }

    //--------------------------VIEWS--------------------------

    #[external("public")]
    #[view]
    fn is_valid_jwk(h_iss: Field, pubkey_hash: Field) -> bool {
        let gen = self.storage.update_index.at(h_iss).read();
        let scoped = Poseidon2::hash([h_iss, gen as Field, pubkey_hash], 3);
        self.storage.jwks_allowlist.at(scoped).read()
    }

    #[external("public")]
    #[view]
    fn is_aud_allowed(aud: Field) -> bool {
        self.storage.aud_allowlist.at(aud).read()
    }
}
