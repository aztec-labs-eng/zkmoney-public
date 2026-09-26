//! Functionality for storing and loading unspent deposit hints from capsules.
use aztec::{
    capsules::CapsuleArray,
    context::UtilityContext,
    keys::getters::{get_nhk_app, get_public_keys},
    oracle::{
        get_l1_to_l2_membership_witness::{get_l1_to_l2_membership_witness, UnsiloedNullifier},
        nullifiers::check_nullifier_exists,
    },
    protocol::{
        address::{AztecAddress, EthAddress},
        constants::MAX_NULLIFIERS_PER_CALL,
        hash::sha256_to_field,
        merkle_tree::root::root_from_sibling_path,
        traits::{Deserialize, Serialize},
    },
};
use oxide_token_lib::deposit_message_hashing::{compute_deposit_message_hash, compute_deposit_message_nullifier};

pub global DEPOSITS_CAPSULE_SLOT: Field = sha256_to_field("OXIDE_TOKEN::DEPOSITS".as_bytes());

/// Each spent deposit consumes one L1 -> L2 message, which emits one nullifier, so a single call can never spend more
/// deposits than the kernel's per-call nullifier budget.
pub global MAX_DEPOSITS_PER_CALL: u32 = MAX_NULLIFIERS_PER_CALL;
#[derive(Deserialize, Serialize)]
pub struct Deposit {
    pub inbox_index: Field,
    pub amount: u128,
    pub shared_secret_salt: Field,
    // The following values are stored just so that we don't waste time to re-deriving them
    pub message_hash: Field,
    pub nullifier: Field,
}

pub unconstrained fn deposits(contract_address: AztecAddress, recipient: AztecAddress) -> CapsuleArray<Deposit> {
    CapsuleArray::at(contract_address, DEPOSITS_CAPSULE_SLOT, recipient)
}

pub unconstrained fn store_deposit(
    context: UtilityContext,
    portal: EthAddress,
    inbox_index: Field,
    amount: u128,
    recipient: AztecAddress,
    shared_secret_salt: Field,
) {
    let contract_address = context.this_address();

    // We prune spent deposits only here as this function is never expected to be invoked in a real transaction
    // simulation or execution. If that happened we would get deposits with pending nullifiers dropped which would be
    // a bug as pending nullifiers are not guaranteed to get into a block.
    prune_spent(contract_address, recipient);

    let message_hash = compute_deposit_message_hash(
        portal,
        context.chain_id(),
        contract_address,
        context.version(),
        shared_secret_salt,
        recipient,
        amount,
        inbox_index,
    );

    // The membership-witness oracle only serves non-nullified messages so we check the nullifier first to not get
    // an incorrect error.
    let nhk_app = get_nhk_app(get_public_keys(recipient).npk_m_hash);
    let inner_nullifier = compute_deposit_message_nullifier(message_hash, nhk_app);
    assert(!check_nullifier_exists(inner_nullifier), "deposit already spent");
    assert(!contains_inbox_index(contract_address, recipient, inbox_index), "deposit already stored");

    let (_witness_index, sibling_path) = get_l1_to_l2_membership_witness(
        message_hash,
        Option::some(
            UnsiloedNullifier { contract_address, nullifier: inner_nullifier },
        ),
    );
    let root = root_from_sibling_path(message_hash, inbox_index, sibling_path);
    assert(root == context.block_header().state.l1_to_l2_message_tree.root, "deposit message does not exist");

    deposits(contract_address, recipient).push(
        Deposit { inbox_index, amount, shared_secret_salt, message_hash, nullifier: inner_nullifier },
    );
}

/// Sum of `owner`'s recorded unspent deposits.
pub unconstrained fn balance(contract_address: AztecAddress, owner: AztecAddress) -> u128 {
    let deposits = deposits(contract_address, owner);
    let mut balance: u128 = 0;
    for i in 0..deposits.len() {
        let deposit = deposits.get(i);
        if !check_nullifier_exists(deposit.nullifier) {
            balance += deposit.amount;
        }
    }
    balance
}

pub unconstrained fn contains_inbox_index(
    contract_address: AztecAddress,
    recipient: AztecAddress,
    inbox_index: Field,
) -> bool {
    let deposits = deposits(contract_address, recipient);
    let mut found = false;
    for i in 0..deposits.len() {
        if deposits.get(i).inbox_index == inbox_index {
            found = true;
        }
    }
    found
}

/// Selects up to `max_deposits` unspent deposits, i.e. ones whose deposit-message nullifier does not exist yet. Stops
/// selecting once `amount` is reached.
pub unconstrained fn next_deposits(
    contract_address: AztecAddress,
    owner: AztecAddress,
    amount: u128,
    max_deposits: u32,
) -> BoundedVec<Deposit, MAX_DEPOSITS_PER_CALL> {
    assert(max_deposits <= MAX_DEPOSITS_PER_CALL);
    let deposits = deposits(contract_address, owner);
    let mut result = BoundedVec::new();
    let mut selected: u128 = 0;
    for i in 0..deposits.len() {
        if (result.len() < max_deposits) & (selected < amount) {
            let deposit = deposits.get(i);
            // Checking for nullifier existence here is generally cheap as for deposits that were spent in the current
            // transaction the following calls queries only a local cache.
            if !check_nullifier_exists(deposit.nullifier) {
                result.push(deposit);
                selected += deposit.amount;
            }
        }
    }
    result
}

/// Removes every deposit from capsules that was already spent.
///
/// Warning: `check_nullifier_exists` unfortunately does not allow us to check only for settled nullifiers - it also
/// considers pending ones. Hence this is dangerous to call from a simulation or a real execution of a transaction -
/// it would drop deposits that have pending nullifiers but that does not guarantee that the pending nullifier will
/// actually make it to a block.
unconstrained fn prune_spent(contract_address: AztecAddress, owner: AztecAddress) {
    let deposits = deposits(contract_address, owner);
    // Iterate backward: `CapsuleArray.for_each` reads the length once and does not support `remove` from inside the
    // callback -- removing mid-iteration makes the trailing `get` calls read past the shortened array. Backward
    // indexing keeps every index still to be visited valid after a removal.
    let mut i = deposits.len();
    while i > 0 {
        i -= 1;
        if check_nullifier_exists(deposits.get(i).nullifier) {
            deposits.remove(i);
        }
    }
}
