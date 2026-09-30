//! Proof that a block header is the tip of the frozen archive.

use aztec::protocol::{
    abis::block_header::BlockHeader,
    constants::ARCHIVE_HEIGHT,
    merkle_tree::{check_membership, MembershipWitness},
    traits::Hash,
};

// Constrain `frozen_tip` to be the right-most (latest) leaf of the `frozen_archive`.
//
// Refund circuits need this: without it an attacker could spend a note / deposit before the rollup got frozen and then
// re-spend it via the refund by picking an older block header that pre-dates the spend's nullifier.
//
// We constrain the provided header to be the right-most header in archive by:
//      i.  proving the block header is a leaf in the frozen archive,
//      ii. proving there is zero leaf at that same index in `frozen_tip.last_archive` using the same sibling
//          path as in point i.
//
// Sketch: the two proofs share one sibling path. Height-3 archive shown for brevity (real depth = ARCHIVE_HEIGHT);
// block header lives at idx N=4, with sibling-path nodes labelled [S0], [S1], [S2]:
//
//       Frozen archive  R_F                          frozen_tip.last_archive  R_LA
//       (H is the latest entry)                      (snapshot just before H was appended)
//
//                R_F                                            R_LA
//               /   \                                          /    \
//            [S2]    N1                                     [S2]    N1'
//                   /  \                                            /  \
//                  M2  [S1]                                       M2'  [S1]
//                  / \                                            / \
//                 H  [S0]                                        0  [S0]
//
// If H was not the right-most leaf in the tree then `frozen_tip.last_archive` would need to have some leaves
// modified right of H which would result in S0 or S1 to be different and the merkle proof could not pass with
// the same sibling path.
pub fn assert_is_frozen_tip(
    frozen_tip: BlockHeader,
    sibling_path: [Field; ARCHIVE_HEIGHT],
    frozen_archive_root: Field,
) {
    let archive_witness = MembershipWitness { leaf_index: frozen_tip.block_number() as Field, sibling_path };
    assert(
        check_membership(frozen_tip.hash(), archive_witness, frozen_archive_root),
        "frozen tip is not in the archive",
    );
    assert(
        check_membership(0, archive_witness, frozen_tip.last_archive.root),
        "frozen tip is not the latest block in the frozen archive",
    );
}

mod tests {
    use super::assert_is_frozen_tip;
    use aztec::protocol::{
        abis::block_header::BlockHeader,
        constants::ARCHIVE_HEIGHT,
        merkle_tree::{merkle_hash, root::root_from_sibling_path},
        traits::{Empty, Hash},
    };

    // Place our test header H at idx 7 - a generic non-edge position
    global TEST_HEADER_IDX: u32 = 7;

    // The empty-subtree hash at each level: zero[0] = 0; zero[i+1] = merkle_hash(zero[i], zero[i]).
    // Used to fill the upper portion of both sibling paths (everything strictly right of idx 7's
    // subtree is empty in both archives we model).
    fn empty_subtree_hashes() -> [Field; ARCHIVE_HEIGHT] {
        let mut z: [Field; ARCHIVE_HEIGHT] = [0; ARCHIVE_HEIGHT];
        for i in 1..ARCHIVE_HEIGHT {
            z[i] = merkle_hash(z[i - 1], z[i - 1]);
        }
        z
    }

    fn sibling_path_at_idx_7(level_3_sibling: Field) -> [Field; ARCHIVE_HEIGHT] {
        let mut sp: [Field; ARCHIVE_HEIGHT] = empty_subtree_hashes();
        sp[0] = 0x111;
        sp[1] = 0x222;
        sp[2] = 0x333;
        sp[3] = level_3_sibling;
        sp
    }

    #[test]
    fn tip_passes() {
        // Tip case: nothing exists at idx 8..15, so the level-3 sibling is the empty-subtree hash.
        // The same path is genuinely valid for H in the frozen archive AND for the zero-leaf at
        // idx 7 in H.last_archive, so both membership checks succeed.
        let zero = empty_subtree_hashes();
        let sp = sibling_path_at_idx_7(zero[3]);

        let mut header = BlockHeader::empty();
        header.global_variables.block_number = TEST_HEADER_IDX;
        header.last_archive.root = root_from_sibling_path(0, TEST_HEADER_IDX as Field, sp);
        let frozen_archive_root = root_from_sibling_path(header.hash(), TEST_HEADER_IDX as Field, sp);

        assert_is_frozen_tip(header, sp, frozen_archive_root);
    }

    #[test(should_fail_with = "frozen tip is not the latest block in the frozen archive")]
    fn rejects_non_tip_header() {
        // Realistic non-tip scenario: H sits at idx 7 in the frozen archive, with blocks 0..6 to its left and a
        // *later* block H' appended at idx 8. `H.last_archive` is the snapshot before H was appended: same blocks
        // 0..6, zeros from idx 7 onward.
        //
        // Sibling paths for idx 7 in the two archives share their lower levels (sp[0..3], over the identical blocks
        // 0..6) and their upper empty padding (sp[4..]). They diverge only at sp[3], the subtree covering idx 8..15:
        //   - frozen_archive: contains H' at idx 8, so this sibling node is non-zero,
        //   - last_archive:   that subtree is empty, so this sibling node is the empty hash.
        //
        // The prover supplies the genuine path for H in the frozen archive. The first check passes;
        // the second re-applies that same path to leaf=0, and the non-empty sp[3] makes the reconstructed root differ
        // from `last_archive.root`, firing the tip assertion.
        let zero = empty_subtree_hashes();
        let sp_frozen = sibling_path_at_idx_7(0xbeef);
        let sp_last_archive = sibling_path_at_idx_7(zero[3]);

        let mut header = BlockHeader::empty();
        header.global_variables.block_number = TEST_HEADER_IDX;
        header.last_archive.root = root_from_sibling_path(0, TEST_HEADER_IDX as Field, sp_last_archive);
        let frozen_archive_root = root_from_sibling_path(header.hash(), TEST_HEADER_IDX as Field, sp_frozen);

        assert_is_frozen_tip(header, sp_frozen, frozen_archive_root);
    }
}
