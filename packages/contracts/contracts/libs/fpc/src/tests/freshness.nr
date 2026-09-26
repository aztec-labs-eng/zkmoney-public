use crate::{assert_fresh_quote, bounded_anchor_timestamp};

use aztec::{
    context::{inputs::PrivateContextInputs, PrivateContext},
    protocol::{abis::block_header::BlockHeader, traits::Empty},
};
use date::Date;

fn normal_anchor_ts() -> u64 {
    Date::new(2026, 3, 8).to_timestamp() + 43200
}

fn context_at(anchor_ts: u64) -> PrivateContext {
    let mut header = BlockHeader::empty();
    header.global_variables.timestamp = anchor_ts;

    let mut inputs = PrivateContextInputs::empty();
    inputs.anchor_block_header = header;

    PrivateContext::new(inputs, 0)
}

#[test]
fn bounded_anchor_returns_the_anchor_and_sets_one_ttl_expiry() {
    let anchor_ts = normal_anchor_ts();
    let mut context = context_at(anchor_ts);

    assert_eq(bounded_anchor_timestamp(&mut context), anchor_ts);
    assert_eq(context.finish().expiration_timestamp, anchor_ts + 3600);
}

#[test]
fn quote_accepts_one_hour_ttl() {
    let anchor_ts = normal_anchor_ts();
    let mut context = context_at(anchor_ts);

    let valid_until = anchor_ts + 3600;
    assert_fresh_quote(&mut context, valid_until);
    assert_eq(context.finish().expiration_timestamp, valid_until);
}

#[test(should_fail_with = "quote expired")]
fn quote_rejects_expired_quote() {
    let anchor_ts = normal_anchor_ts();
    let mut context = context_at(anchor_ts);

    assert_fresh_quote(&mut context, anchor_ts);
}

#[test(should_fail_with = "quote ttl too large")]
fn quote_rejects_overlong_ttl() {
    let anchor_ts = normal_anchor_ts();
    let mut context = context_at(anchor_ts);

    assert_fresh_quote(&mut context, anchor_ts + 3601);
}
