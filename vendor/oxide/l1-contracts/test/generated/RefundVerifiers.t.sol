// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {IVerifier, HonkVerifier as FrozenDepositsHonkVerifier} from "@generated/FrozenDepositsRefundVerifier.sol";
import {HonkVerifier as FrozenNotesHonkVerifier} from "@generated/FrozenNotesRefundVerifier.sol";

contract RefundVerifiersTest is Test {
  bytes4 internal constant SUMCHECK_FAILED = 0x9fc3a218;
  bytes4 internal constant PUBLIC_INPUTS_LENGTH_WRONG = 0xfa066593;

  string internal constant FROZEN_DEPOSITS_FIXTURE = "frozen_deposits_refund";
  string internal constant FROZEN_DEPOSITS_FULL_BATCH_FIXTURE = "frozen_deposits_refund_full_batch";
  string internal constant FROZEN_NOTES_FIXTURE = "frozen_notes_refund";
  string internal constant FROZEN_NOTES_FULL_BATCH_FIXTURE = "frozen_notes_refund_full_batch";

  uint256 internal constant FROZEN_DEPOSITS_NULLIFIERS_START =
    OxideConstants.FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT - OxideConstants.MAX_FROZEN_DEPOSITS_PER_REFUND;
  uint256 internal constant FROZEN_NOTES_NULLIFIERS_START =
    OxideConstants.FROZEN_NOTES_REFUND_PUBLIC_INPUT_COUNT - OxideConstants.MAX_FROZEN_NOTES_PER_REFUND;

  IVerifier internal frozenDepositsVerifier;
  IVerifier internal frozenNotesVerifier;

  function setUp() external {
    frozenDepositsVerifier = new FrozenDepositsHonkVerifier();
    frozenNotesVerifier = IVerifier(address(new FrozenNotesHonkVerifier()));
  }

  function test_GivenTheFixtureProof_WhenTheFrozenDepositsVerifierVerifiesIt() external view {
    _assertAcceptsTheFixtureProof(frozenDepositsVerifier, FROZEN_DEPOSITS_FIXTURE, FROZEN_DEPOSITS_NULLIFIERS_START, 1);
  }

  function test_GivenAChangedNullifier_WhenTheFrozenDepositsVerifierVerifiesIt() external {
    _assertRejectsEachChangedNullifier(
      frozenDepositsVerifier, FROZEN_DEPOSITS_FIXTURE, FROZEN_DEPOSITS_NULLIFIERS_START, 1
    );
  }

  function test_GivenAZeroedNullifier_WhenTheFrozenDepositsVerifierVerifiesIt() external {
    _assertRejectsEachZeroedNullifier(
      frozenDepositsVerifier, FROZEN_DEPOSITS_FIXTURE, FROZEN_DEPOSITS_NULLIFIERS_START, 1
    );
  }

  function test_GivenANullifierInAPaddingSlot_WhenTheFrozenDepositsVerifierVerifiesIt() external {
    _assertRejectsANullifierInEachPaddingSlot(
      frozenDepositsVerifier, FROZEN_DEPOSITS_FIXTURE, FROZEN_DEPOSITS_NULLIFIERS_START
    );
  }

  function test_GivenNoNullifiers_WhenTheFrozenDepositsVerifierVerifiesIt() external {
    _assertRejectsNoNullifiers(frozenDepositsVerifier, FROZEN_DEPOSITS_FIXTURE, FROZEN_DEPOSITS_NULLIFIERS_START);
  }

  function test_GivenAFullBatchProof_WhenTheFrozenDepositsVerifierVerifiesIt() external view {
    _assertAcceptsTheFixtureProof(
      frozenDepositsVerifier,
      FROZEN_DEPOSITS_FULL_BATCH_FIXTURE,
      FROZEN_DEPOSITS_NULLIFIERS_START,
      OxideConstants.MAX_FROZEN_DEPOSITS_PER_REFUND
    );
  }

  function test_GivenAFullBatchWithAChangedNullifier_WhenTheFrozenDepositsVerifierVerifiesIt() external {
    _assertRejectsEachChangedNullifier(
      frozenDepositsVerifier,
      FROZEN_DEPOSITS_FULL_BATCH_FIXTURE,
      FROZEN_DEPOSITS_NULLIFIERS_START,
      OxideConstants.MAX_FROZEN_DEPOSITS_PER_REFUND
    );
  }

  function test_GivenAFullBatchWithAZeroedNullifier_WhenTheFrozenDepositsVerifierVerifiesIt() external {
    _assertRejectsEachZeroedNullifier(
      frozenDepositsVerifier,
      FROZEN_DEPOSITS_FULL_BATCH_FIXTURE,
      FROZEN_DEPOSITS_NULLIFIERS_START,
      OxideConstants.MAX_FROZEN_DEPOSITS_PER_REFUND
    );
  }

  function test_GivenOnlyTheFirstNullifiersOfAFullBatch_WhenTheFrozenDepositsVerifierVerifiesIt() external {
    _assertRejectsEachPrefixOfNullifiers(
      frozenDepositsVerifier,
      FROZEN_DEPOSITS_FULL_BATCH_FIXTURE,
      FROZEN_DEPOSITS_NULLIFIERS_START,
      OxideConstants.MAX_FROZEN_DEPOSITS_PER_REFUND
    );
  }

  function test_GivenAFullBatchWithSwappedNullifiers_WhenTheFrozenDepositsVerifierVerifiesIt() external {
    _assertRejectsSwappedNullifiers(
      frozenDepositsVerifier,
      FROZEN_DEPOSITS_FULL_BATCH_FIXTURE,
      FROZEN_DEPOSITS_NULLIFIERS_START,
      OxideConstants.MAX_FROZEN_DEPOSITS_PER_REFUND
    );
  }

  function test_GivenAFullBatchWithNoNullifiers_WhenTheFrozenDepositsVerifierVerifiesIt() external {
    _assertRejectsNoNullifiers(
      frozenDepositsVerifier, FROZEN_DEPOSITS_FULL_BATCH_FIXTURE, FROZEN_DEPOSITS_NULLIFIERS_START
    );
  }

  function test_GivenTheFixtureProof_WhenTheFrozenNotesVerifierVerifiesIt() external view {
    _assertAcceptsTheFixtureProof(frozenNotesVerifier, FROZEN_NOTES_FIXTURE, FROZEN_NOTES_NULLIFIERS_START, 1);
  }

  function test_GivenAChangedNullifier_WhenTheFrozenNotesVerifierVerifiesIt() external {
    _assertRejectsEachChangedNullifier(frozenNotesVerifier, FROZEN_NOTES_FIXTURE, FROZEN_NOTES_NULLIFIERS_START, 1);
  }

  function test_GivenAZeroedNullifier_WhenTheFrozenNotesVerifierVerifiesIt() external {
    _assertRejectsEachZeroedNullifier(frozenNotesVerifier, FROZEN_NOTES_FIXTURE, FROZEN_NOTES_NULLIFIERS_START, 1);
  }

  function test_GivenANullifierInAPaddingSlot_WhenTheFrozenNotesVerifierVerifiesIt() external {
    _assertRejectsANullifierInEachPaddingSlot(frozenNotesVerifier, FROZEN_NOTES_FIXTURE, FROZEN_NOTES_NULLIFIERS_START);
  }

  function test_GivenNoNullifiers_WhenTheFrozenNotesVerifierVerifiesIt() external {
    _assertRejectsNoNullifiers(frozenNotesVerifier, FROZEN_NOTES_FIXTURE, FROZEN_NOTES_NULLIFIERS_START);
  }

  function test_GivenAFullBatchProof_WhenTheFrozenNotesVerifierVerifiesIt() external view {
    _assertAcceptsTheFixtureProof(
      frozenNotesVerifier,
      FROZEN_NOTES_FULL_BATCH_FIXTURE,
      FROZEN_NOTES_NULLIFIERS_START,
      OxideConstants.MAX_FROZEN_NOTES_PER_REFUND
    );
  }

  function test_GivenAFullBatchWithAChangedNullifier_WhenTheFrozenNotesVerifierVerifiesIt() external {
    _assertRejectsEachChangedNullifier(
      frozenNotesVerifier,
      FROZEN_NOTES_FULL_BATCH_FIXTURE,
      FROZEN_NOTES_NULLIFIERS_START,
      OxideConstants.MAX_FROZEN_NOTES_PER_REFUND
    );
  }

  function test_GivenAFullBatchWithAZeroedNullifier_WhenTheFrozenNotesVerifierVerifiesIt() external {
    _assertRejectsEachZeroedNullifier(
      frozenNotesVerifier,
      FROZEN_NOTES_FULL_BATCH_FIXTURE,
      FROZEN_NOTES_NULLIFIERS_START,
      OxideConstants.MAX_FROZEN_NOTES_PER_REFUND
    );
  }

  function test_GivenOnlyTheFirstNullifiersOfAFullBatch_WhenTheFrozenNotesVerifierVerifiesIt() external {
    _assertRejectsEachPrefixOfNullifiers(
      frozenNotesVerifier,
      FROZEN_NOTES_FULL_BATCH_FIXTURE,
      FROZEN_NOTES_NULLIFIERS_START,
      OxideConstants.MAX_FROZEN_NOTES_PER_REFUND
    );
  }

  function test_GivenAFullBatchWithSwappedNullifiers_WhenTheFrozenNotesVerifierVerifiesIt() external {
    _assertRejectsSwappedNullifiers(
      frozenNotesVerifier,
      FROZEN_NOTES_FULL_BATCH_FIXTURE,
      FROZEN_NOTES_NULLIFIERS_START,
      OxideConstants.MAX_FROZEN_NOTES_PER_REFUND
    );
  }

  function test_GivenAFullBatchWithNoNullifiers_WhenTheFrozenNotesVerifierVerifiesIt() external {
    _assertRejectsNoNullifiers(frozenNotesVerifier, FROZEN_NOTES_FULL_BATCH_FIXTURE, FROZEN_NOTES_NULLIFIERS_START);
  }

  function _assertAcceptsTheFixtureProof(
    IVerifier _verifier,
    string memory _fixture,
    uint256 _nullifiersStart,
    uint256 _nullifierCount
  ) internal view {
    (bytes memory proof, bytes32[] memory publicInputs) = _fixtureProof(_fixture);
    for (uint256 i = _nullifiersStart; i < publicInputs.length; i++) {
      if (i < _nullifiersStart + _nullifierCount) {
        assertNotEq(publicInputs[i], bytes32(0));
      } else {
        assertEq(publicInputs[i], bytes32(0));
      }
    }
    assertTrue(_verifier.verify(proof, publicInputs));
  }

  function _assertRejectsEachChangedNullifier(
    IVerifier _verifier,
    string memory _fixture,
    uint256 _nullifiersStart,
    uint256 _nullifierCount
  ) internal {
    (bytes memory proof, bytes32[] memory publicInputs) = _fixtureProof(_fixture);
    for (uint256 i = _nullifiersStart; i < _nullifiersStart + _nullifierCount; i++) {
      bytes32[] memory changed = _copy(publicInputs);
      changed[i] = bytes32(uint256(changed[i]) ^ 1);
      _expectRejected(_verifier, proof, changed);
    }
  }

  function _assertRejectsEachZeroedNullifier(
    IVerifier _verifier,
    string memory _fixture,
    uint256 _nullifiersStart,
    uint256 _nullifierCount
  ) internal {
    (bytes memory proof, bytes32[] memory publicInputs) = _fixtureProof(_fixture);
    for (uint256 i = _nullifiersStart; i < _nullifiersStart + _nullifierCount; i++) {
      bytes32[] memory zeroed = _copy(publicInputs);
      zeroed[i] = bytes32(0);
      _expectRejected(_verifier, proof, zeroed);
    }
  }

  function _assertRejectsANullifierInEachPaddingSlot(
    IVerifier _verifier,
    string memory _fixture,
    uint256 _nullifiersStart
  ) internal {
    (bytes memory proof, bytes32[] memory publicInputs) = _fixtureProof(_fixture);
    for (uint256 i = _nullifiersStart + 1; i < publicInputs.length; i++) {
      bytes32[] memory padded = _copy(publicInputs);
      padded[i] = publicInputs[_nullifiersStart];
      _expectRejected(_verifier, proof, padded);
    }
  }

  function _assertRejectsEachPrefixOfNullifiers(
    IVerifier _verifier,
    string memory _fixture,
    uint256 _nullifiersStart,
    uint256 _nullifierCount
  ) internal {
    (bytes memory proof, bytes32[] memory publicInputs) = _fixtureProof(_fixture);
    for (uint256 kept = 1; kept < _nullifierCount; kept++) {
      bytes32[] memory prefix = _copy(publicInputs);
      for (uint256 i = _nullifiersStart + kept; i < publicInputs.length; i++) {
        prefix[i] = bytes32(0);
      }
      _expectRejected(_verifier, proof, prefix);
    }
  }

  function _assertRejectsSwappedNullifiers(
    IVerifier _verifier,
    string memory _fixture,
    uint256 _nullifiersStart,
    uint256 _nullifierCount
  ) internal {
    (bytes memory proof, bytes32[] memory publicInputs) = _fixtureProof(_fixture);
    uint256 last = _nullifiersStart + _nullifierCount - 1;
    (publicInputs[_nullifiersStart], publicInputs[last]) = (publicInputs[last], publicInputs[_nullifiersStart]);
    _expectRejected(_verifier, proof, publicInputs);
  }

  function _assertRejectsNoNullifiers(IVerifier _verifier, string memory _fixture, uint256 _nullifiersStart) internal {
    (bytes memory proof, bytes32[] memory publicInputs) = _fixtureProof(_fixture);
    bytes32[] memory truncated = new bytes32[](_nullifiersStart);
    for (uint256 i = 0; i < _nullifiersStart; i++) {
      truncated[i] = publicInputs[i];
    }
    vm.expectRevert(PUBLIC_INPUTS_LENGTH_WRONG);
    _verifier.verify(proof, truncated);
  }

  function _expectRejected(IVerifier _verifier, bytes memory _proof, bytes32[] memory _publicInputs) internal {
    vm.expectRevert(SUMCHECK_FAILED);
    _verifier.verify(_proof, _publicInputs);
  }

  function _fixtureProof(string memory _fixture)
    internal
    view
    returns (bytes memory proof, bytes32[] memory publicInputs)
  {
    string memory json = vm.readFile(string.concat("./test/fixtures/", _fixture, "_proof.json"));
    proof = vm.parseJsonBytes(json, ".proof");
    publicInputs = vm.parseJsonBytes32Array(json, ".publicInputs");
  }

  function _copy(bytes32[] memory _values) internal pure returns (bytes32[] memory copy) {
    copy = new bytes32[](_values.length);
    for (uint256 i = 0; i < _values.length; i++) {
      copy[i] = _values[i];
    }
  }
}
