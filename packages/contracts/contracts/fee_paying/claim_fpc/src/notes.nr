use aztec::{
    macros::notes::note,
    protocol::traits::{Deserialize, Packable, Serialize},
};

/// A user's remaining sponsored txs on one rail. A subscription is one note per (user, rail); a rail
/// entered by gift may hold several, each spent one batch at a time. The rail's policy gates WHAT
/// its batches may carry, this note gates HOW OFTEN. `rail` is the id the note answers for, so a
/// batch on one rail can never spend another's allowance. `refilled_at` anchors the window; it is
/// always a `bounded_anchor_timestamp`, so it trails the block that stamped it by at most one TTL.
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct SubscriptionNote {
    pub rail: u8,
    pub uses: u32,
    pub refilled_at: u64,
}

/// One sponsored use: decrement, or refill to `max_tx - 1` once the rail's refill window has
/// elapsed. A rail with `refill_period` 0 never refills -- its first allowance is its only one.
pub fn refresh_subscription_note(
    note: SubscriptionNote,
    anchor_ts: u64,
    max_tx: u32,
    refill_period: u64,
) -> SubscriptionNote {
    if note.uses > 0 {
        SubscriptionNote { rail: note.rail, uses: note.uses - 1, refilled_at: note.refilled_at }
    } else {
        let refillable = (refill_period != 0) & (anchor_ts >= note.refilled_at + refill_period);
        assert(refillable, "allowance exhausted");
        SubscriptionNote { rail: note.rail, uses: max_tx - 1, refilled_at: anchor_ts }
    }
}

// -- tests -------------------------------------------------------------------

global TEST_RAIL: u8 = 2;

fn note_with(uses: u32, refilled_at: u64) -> SubscriptionNote {
    SubscriptionNote { rail: TEST_RAIL, uses, refilled_at }
}

#[test]
fn a_use_decrements_and_keeps_the_window_and_rail() {
    let spent = refresh_subscription_note(note_with(3, 1000), 9999, 100, 86400);
    assert(spent.uses == 2);
    assert(spent.refilled_at == 1000);
    assert(spent.rail == TEST_RAIL);
}

#[test(should_fail_with = "allowance exhausted")]
fn a_rail_that_never_refills_is_spent_for_good() {
    // refill_period 0: no anchor, however far in the future, grants another use.
    let _ = refresh_subscription_note(note_with(0, 1000), 0xffffffff, 1, 0);
}

#[test(should_fail_with = "allowance exhausted")]
fn an_exhausted_note_refuses_before_its_window_elapses() {
    let _ = refresh_subscription_note(note_with(0, 1000), 1099, 100, 100);
}

#[test]
fn an_exhausted_note_refills_once_its_window_elapses() {
    let refilled = refresh_subscription_note(note_with(0, 1000), 1100, 100, 100);
    // The refill spends the tx that triggered it and re-anchors the window at this tx's anchor.
    assert(refilled.uses == 99);
    assert(refilled.refilled_at == 1100);
    assert(refilled.rail == TEST_RAIL);
}
