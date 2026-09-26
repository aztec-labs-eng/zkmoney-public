use nodash::str_to_u64;

/// Parse a decimal ASCII string (e.g. from a JWT claim) into a Field.
/// Bytes beyond `len` are ignored. Digits must be 0-9 (ASCII 48-57).
/// Works for BN254 field elements (up to 77 decimal digits; use N >= 80).
pub fn parse_decimal_field<let N: u32>(bytes: [u8; N], len: u32) -> Field {
    let mut result: Field = 0;
    for i in 0..N {
        if i < len {
            result = result * 10 + (bytes[i] - 48) as Field;
        }
    }
    result
}

/// Pin every byte of a claim-value buffer at or past `len` to zero. verifyJwt
/// hashes the full buffer, so an unconstrained tail lets a prover forge a
/// canonical aud/email/sub hash from a shorter value.
pub fn assert_claim_tail_zero<let MAX_LEN: u32>(storage: [u8; MAX_LEN], len: u32) {
    for i in 0..MAX_LEN {
        if i >= len {
            assert(storage[i] == 0, "claim value tail must be zero-padded");
        }
    }
}

/// Wrapper around decoded JWT payload JSON bytes providing typed claim extraction.
/// Uses the unconstrained-extraction + constrained-verification pattern from string_search.
///
/// N: The fixed length of the payload_json array (must be <= 1024).
///    In practice this is JWT_PAYLOAD_JSON_MAX_LEN (768), padded with spaces.
pub struct JwtPayload<let N: u32> {
    payload_json: [u8; N],
}

impl<let N: u32> JwtPayload<N> {
    pub fn new(payload_json: [u8; N]) -> Self {
        assert(N <= 1024, "payload_json must be at most 1024 bytes");
        JwtPayload { payload_json }
    }

    /// Extract a string claim from the JWT payload.
    /// KEY_LEN is inferred from the claim_key array length.
    /// MAX_VAL_LEN must be specified at the call site via the return-type annotation, e.g.:
    ///   let email: BoundedVec<u8, 64> = payload.get_claim_string("email".as_bytes());
    pub fn get_claim_string<let KEY_LEN: u32, let MAX_VAL_LEN: u32>(
        self,
        claim_key: [u8; KEY_LEN],
    ) -> BoundedVec<u8, MAX_VAL_LEN> {
        self.get_claim::<KEY_LEN, MAX_VAL_LEN>(claim_key, true, false)
    }

    /// Like get_claim_string but also asserts the key appears only once (no duplicate keys).
    /// Use for identity-critical claims (email, sub) to prevent duplicate-key injection.
    pub fn get_claim_string_unique<let KEY_LEN: u32, let MAX_VAL_LEN: u32>(
        self,
        claim_key: [u8; KEY_LEN],
    ) -> BoundedVec<u8, MAX_VAL_LEN> {
        self.get_claim::<KEY_LEN, MAX_VAL_LEN>(claim_key, true, true)
    }

    /// Extract a numeric (u64) claim from the JWT payload.
    pub fn get_claim_number<let KEY_LEN: u32>(self, claim_key: [u8; KEY_LEN]) -> u64 {
        let claim: BoundedVec<u8, 20> = self.get_claim::<KEY_LEN, 20>(claim_key, false, false);
        str_to_u64(claim.storage())
    }

    /// Extract a boolean claim from the JWT payload.
    pub fn get_claim_bool<let KEY_LEN: u32>(self, claim_key: [u8; KEY_LEN]) -> bool {
        let value: BoundedVec<u8, 5> = self.get_claim::<KEY_LEN, 5>(claim_key, false, false);
        let mut is_true = true;
        for i in 0..4 {
            is_true = is_true & (value.storage()[i] == "true".as_bytes()[i]);
        }
        let is_false = value.storage() == "false".as_bytes();
        assert(is_true | is_false, "claim is not a boolean");
        is_true
    }

    /// Assert the `email_verified` claim is true. Google must send the JSON
    /// boolean `true`; Apple may send either the boolean `true` or the string
    /// `"true"` (a documented deviation from the OIDC spec), so the string form
    /// is accepted only when `is_apple`. `false`, `"false"`, a missing claim, a
    /// Google string form, or anything else reverts. The payload is signed and
    /// compact JSON, so an exact key:value match is provider-authored; the
    /// trailing ',' / '}' check rejects values like `truer`.
    pub fn assert_email_verified(self, is_apple: bool) {
        // `"email_verified":true` (21 bytes) and `"email_verified":"true"` (23).
        let bool_ok = self.claim_pair_present("\"email_verified\":true".as_bytes());
        let str_ok = self.claim_pair_present("\"email_verified\":\"true\"".as_bytes());
        assert(bool_ok | (is_apple & str_ok), "email not verified by provider");
    }

    /// True iff `needle` occurs in the payload immediately followed by a ','
    /// or '}' delimiter. A plain scan (mirrors the duplicate-key scan below):
    /// `substring_match` reverts when the needle is absent, so it cannot be
    /// used to test "is one of two forms present".
    fn claim_pair_present<let NL: u32>(self, needle: [u8; NL]) -> bool {
        let mut found = false;
        for i in 0..(N - NL) {
            let mut bytes_match = true;
            for j in 0..NL {
                bytes_match = bytes_match & (self.payload_json[i + j] == needle[j]);
            }
            let after = self.payload_json[i + NL];
            found = found | (bytes_match & ((after == 44) | (after == 125)));
        }
        found
    }

    /// Internal: extract and constrain a claim from the payload.
    /// When check_no_duplicate is true, asserts the key does not appear again after its value (prevents duplicate-key injection).
    fn get_claim<let KEY_LEN: u32, let MAX_VAL_LEN: u32>(
        self,
        claim_key: [u8; KEY_LEN],
        is_value_quoted: bool,
        check_no_duplicate: bool,
    ) -> BoundedVec<u8, MAX_VAL_LEN> {
        let haystack: string_search::StringBody1024 =
            string_search::StringBody::new(self.payload_json, N);

        // Extract value unconstrained, then verify in-circuit
        let value: BoundedVec<u8, MAX_VAL_LEN> = unsafe {
            self.extract_claim_unconstrained::<KEY_LEN, MAX_VAL_LEN>(claim_key, is_value_quoted)
        };

        // Build `"key"` needle for substring search
        let mut key_with_quotes: [u8; KEY_LEN + 2] = [0; KEY_LEN + 2];
        key_with_quotes[0] = 34; // "
        for i in 0..KEY_LEN {
            key_with_quotes[i + 1] = claim_key[i];
        }
        key_with_quotes[KEY_LEN + 1] = 34; // "

        let needle: string_search::SubString32 =
            string_search::SubString::new(key_with_quotes, KEY_LEN + 2);
        let (found, position): (bool, u32) = haystack.substring_match(needle);
        assert(found, "claim key not found in JWT payload");

        // Assert colon immediately follows the quoted key
        let colon_index = position + KEY_LEN + 2;
        assert(haystack.body[colon_index] == 58); // ':'

        let mut value_start_index = colon_index + 1;
        let mut index_after_value = value_start_index + value.len();

        if is_value_quoted {
            value_start_index += 1; // skip opening quote
            index_after_value += 2; // account for both surrounding quotes
            assert(haystack.body[value_start_index - 1] == 34); // opening '"'
            assert(haystack.body[index_after_value - 1] == 34); // closing '"'
        }

        // Match each value byte, and forbid value terminators inside the value so
        // value.len() is pinned to the first boundary (a longer len would otherwise
        // absorb later payload bytes). Mirrors extract_claim_unconstrained.
        for i in 0..MAX_VAL_LEN {
            if i < value.len() {
                let b = value.storage()[i];
                assert(haystack.body[value_start_index + i] == b);
                if is_value_quoted {
                    assert(b != 34); // '"'
                } else {
                    assert((b != 34) & (b != 44) & (b != 125)); // '"' ',' '}'
                }
            }
        }

        // Pin the tail to zero so it can't leak into the full-buffer hashes.
        assert_claim_tail_zero(value.storage(), value.len());

        // Assert the character after the value is ',' or '}' (valid JSON delimiter)
        let char_after_value = haystack.body[index_after_value];
        assert((char_after_value == 44) | (char_after_value == 125)); // ',' or '}'

        // // When requested, assert the key does not appear again (prevents duplicate-key injection).
        if check_no_duplicate {
            let needle_len = KEY_LEN + 2;
            let scan_start = index_after_value + 1;
            let mut total_duplicates: u32 = 0;
            for i in 0..(N - needle_len + 1) {
                let in_range = i >= scan_start;
                let mut bytes_match = true;
                for j in 0..needle_len {
                    bytes_match = bytes_match & (haystack.body[i + j] == key_with_quotes[j]);
                }
                let match_at_i = in_range & bytes_match;
                total_duplicates = total_duplicates + (match_at_i as u32);
            }
            assert(total_duplicates == 0, "duplicate claim key");
        }

        value
    }

    /// Unconstrained extraction of a claim value. Finds the value at runtime;
    /// the constrained path in get_claim then verifies it.
    unconstrained fn extract_claim_unconstrained<let KEY_LEN: u32, let MAX_VAL_LEN: u32>(
        self,
        claim_key: [u8; KEY_LEN],
        is_value_quoted: bool,
    ) -> BoundedVec<u8, MAX_VAL_LEN> {
        let haystack: string_search::StringBody1024 =
            string_search::StringBody::new(self.payload_json, N);

        let mut key_with_quotes: [u8; KEY_LEN + 2] = [0; KEY_LEN + 2];
        key_with_quotes[0] = 34;
        for i in 0..KEY_LEN {
            key_with_quotes[i + 1] = claim_key[i];
        }
        key_with_quotes[KEY_LEN + 1] = 34;

        let needle: string_search::SubString32 =
            string_search::SubString::new(key_with_quotes, KEY_LEN + 2);
        let (_, position): (bool, u32) = haystack.substring_match(needle);

        // Value starts after: "key": (+ optional opening quote for strings)
        let mut value_start_idx = position + KEY_LEN + 3; // +3 = 2 quotes + 1 colon
        if is_value_quoted {
            value_start_idx += 1; // skip opening quote
        }

        let mut value: BoundedVec<u8, MAX_VAL_LEN> = BoundedVec::new();
        for i in 0..MAX_VAL_LEN {
            let byte = haystack.body[value_start_idx + i];
            if (byte == 34) | (byte == 44) | (byte == 125) {
                // '"', ',' or '}'
                break;
            }
            value.push(byte);
        }

        value
    }
}

// Boolean `true` is accepted for both providers; the string `"true"` only for
// Apple; everything else reverts. A full verify_jwt path needs a signed fixture.
#[test]
fn email_verified_accepts_bool_and_apple_string() {
    // Google boolean `true`.
    let mut g: [u8; 768] = [32; 768];
    let gs = "{\"email_verified\":true}".as_bytes();
    for i in 0..gs.len() {
        g[i] = gs[i];
    }
    JwtPayload::new(g).assert_email_verified(false);

    // Apple boolean `true` (Apple may send either encoding).
    let mut ab: [u8; 768] = [32; 768];
    let abs = "{\"email_verified\":true}".as_bytes();
    for i in 0..abs.len() {
        ab[i] = abs[i];
    }
    JwtPayload::new(ab).assert_email_verified(true);

    // Apple string `"true"`.
    let mut a: [u8; 768] = [32; 768];
    let ap = "{\"email_verified\":\"true\"}".as_bytes();
    for i in 0..ap.len() {
        a[i] = ap[i];
    }
    JwtPayload::new(a).assert_email_verified(true);
}

// The string form is Apple-only: a Google (is_apple=false) string reverts.
#[test(should_fail_with = "email not verified by provider")]
fn email_verified_rejects_google_string() {
    let mut json: [u8; 768] = [32; 768];
    let src = "{\"email_verified\":\"true\"}".as_bytes();
    for i in 0..src.len() {
        json[i] = src[i];
    }
    JwtPayload::new(json).assert_email_verified(false);
}

// A false value reverts for either provider.
#[test(should_fail_with = "email not verified by provider")]
fn email_verified_rejects_false() {
    let mut json: [u8; 768] = [32; 768];
    let src = "{\"email_verified\":false}".as_bytes();
    for i in 0..src.len() {
        json[i] = src[i];
    }
    JwtPayload::new(json).assert_email_verified(true);
}

/// A value followed by more string fields still extracts to the first boundary,
/// and the no-terminator constraint accepts a legitimate email. (The forged
/// longer-len attack needs an ACVM witness override, unreachable from an honest test.)
#[test]
fn get_claim_pins_first_boundary() {
    let json = "{\"email\":\"alice@gmail.com\",\"email_verified\":true,\"name\":\"John Doe\"}"
        .as_bytes();
    let mut payload: [u8; 768] = [0; 768];
    for i in 0..json.len() {
        payload[i] = json[i];
    }
    let email: BoundedVec<u8, 64> =
        JwtPayload::new(payload).get_claim_string_unique("email".as_bytes());

    let expected = "alice@gmail.com".as_bytes();
    assert(email.len() == expected.len(), "email must be canonical length");
    for i in 0..expected.len() {
        assert(email.storage()[i] == expected[i], "email byte mismatch");
    }
}

/// Unquoted branch: a number followed by another field extracts to the first boundary.
#[test]
fn get_claim_number_pins_first_boundary() {
    let json = "{\"iat\":1234567890,\"exp\":9999999999}".as_bytes();
    let mut payload: [u8; 768] = [0; 768];
    for i in 0..json.len() {
        payload[i] = json[i];
    }
    let iat = JwtPayload::new(payload).get_claim_number("iat".as_bytes());
    assert(iat == 1234567890, "iat must be canonical value");
}

// An honest #[test] can't reach the tail forgery (the extractor zero-fills
// the tail), so these hit assert_claim_tail_zero directly.

#[test]
fn claim_tail_zero_padded_ok() {
    // Short value (len 3) with a zero tail, and a full-length value: both pass.
    let mut storage: [u8; 8] = [0; 8];
    storage[0] = 120;
    storage[1] = 121;
    storage[2] = 122;
    assert_claim_tail_zero(storage, 3);

    let full: [u8; 3] = [65, 66, 67];
    assert_claim_tail_zero(full, 3);
}

// A non-zero byte past `len` (the forged tail) must be rejected.
#[test(should_fail_with = "claim value tail must be zero-padded")]
fn claim_tail_forgery_rejected() {
    let mut storage: [u8; 8] = [0; 8];
    storage[0] = 120;
    storage[1] = 121;
    storage[2] = 122;
    storage[3] = 46;
    assert_claim_tail_zero(storage, 3);
}
