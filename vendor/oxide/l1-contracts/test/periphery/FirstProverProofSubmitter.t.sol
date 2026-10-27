// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {FirstProverProofSubmitter} from "@periphery/FirstProverProofSubmitter.sol";
import {Errors} from "@periphery/Errors.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {SubmitEpochRootProofArgs, PublicInputArgs, ProvenCheckpointFees} from "@aztec/core/interfaces/IRollup.sol";
import {ProposedHeader} from "@aztec/core/libraries/rollup/ProposedHeaderLib.sol";
import {CommitteeAttestations} from "@aztec/core/libraries/rollup/AttestationLib.sol";
import {ChainTips} from "@aztec/core/libraries/compressed-data/Tips.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {Test} from "forge-std/Test.sol";
import {MockRollup} from "@test/fixtures/MockRollup.sol";

contract MockSubmittingRollup is MockRollup {
  ChainTips internal tips;
  Epoch internal currentEpoch;
  uint256 internal submitCount;
  bool internal submitReverts;

  error SubmitFailed();

  function setTips(uint256 _pending, uint256 _proven) external {
    tips = ChainTips({pending: _pending, proven: _proven});
  }

  function setCurrentEpoch(uint256 _epoch) external {
    currentEpoch = Epoch.wrap(_epoch);
  }

  function setSubmitReverts(bool _submitReverts) external {
    submitReverts = _submitReverts;
  }

  function getTips() external view returns (ChainTips memory) {
    return tips;
  }

  function getCurrentEpoch() external view returns (Epoch) {
    return currentEpoch;
  }

  function submitEpochRootProof(SubmitEpochRootProofArgs calldata _args) external {
    if (submitReverts) revert SubmitFailed();
    submitCount++;
    _proveRange(_args.start, _args.end, _args.args.proverId);
  }

  function getSubmitCount() external view returns (uint256) {
    return submitCount;
  }
}

contract FirstProverProofSubmitterTest is Test {
  address internal constant PROVER = address(0xBEEF);
  address internal constant OTHER_PROVER = address(0xC0DE);
  uint256 internal constant START = 9;
  uint256 internal constant END = 11;

  function _args() internal pure returns (SubmitEpochRootProofArgs memory) {
    return SubmitEpochRootProofArgs({
      start: START,
      end: END,
      args: PublicInputArgs({
        previousArchive: bytes32(0),
        endArchive: bytes32(0),
        outHash: bytes32(0),
        previousInboxRollingHash: bytes32(0),
        endInboxRollingHash: bytes32(0),
        proverId: PROVER
      }),
      provenCheckpointFees: new ProvenCheckpointFees[](0),
      headers: new ProposedHeader[](0),
      attestations: CommitteeAttestations({signatureIndices: new bytes(0), signaturesOrAddresses: new bytes(0)}),
      blobInputs: new bytes(0),
      proof: new bytes(0)
    });
  }

  function _buildRollup(uint256 _nextEpoch) internal returns (MockSubmittingRollup proofRollup) {
    proofRollup = new MockSubmittingRollup();
    proofRollup.setCheckpoint(8, bytes32(0), 2);
    proofRollup.setCheckpoint(9, bytes32(0), 3);
    proofRollup.setCheckpoint(10, bytes32(0), 3);
    proofRollup.setCheckpoint(11, bytes32(0), 3);
    proofRollup.setCheckpoint(12, bytes32(0), _nextEpoch);
    proofRollup.setTips(12, 0);
    proofRollup.setCurrentEpoch(_nextEpoch);
    proofRollup.setProvenCheckpointNumber(8);
  }

  function _submitter(MockSubmittingRollup _rollup) internal returns (FirstProverProofSubmitter) {
    return new FirstProverProofSubmitter(IRollup(address(_rollup)));
  }

  function testPinsRollup() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    assertEq(address(_submitter(proofRollup).ROLLUP()), address(proofRollup));
  }

  function testPartialProofForwardsAndRollupRecordsProver() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.proveRange(START, END - 1, OTHER_PROVER);
    _submitter(proofRollup).submitEpochRootProof(_args());
    assertEq(proofRollup.getSubmitCount(), 1);
    assertEq(proofRollup.getProvenCheckpointNumber(), END);
    assertEq(proofRollup.getFirstProvenBy(END), PROVER);
    assertEq(proofRollup.getFirstProvenBy(END - 1), OTHER_PROVER);
  }

  function testPendingEndPartialProofForwards() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setTips(END, 0);
    _submitter(proofRollup).submitEpochRootProof(_args());
    assertEq(proofRollup.getSubmitCount(), 1);
    assertEq(proofRollup.getFirstProvenBy(END), PROVER);
  }

  function testPartialProofRevertsBeforeForwardingWhenEndIsAlreadyProven() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.proveRange(START, END, OTHER_PROVER);
    FirstProverProofSubmitter submitter = _submitter(proofRollup);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.FirstProverProofSubmitter__CheckpointAlreadyProven.selector, END, END)
    );
    submitter.submitEpochRootProof(_args());
  }

  function testPartialProofRevertsWhenTheTipIsPastItsEnd() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.proveRange(START, END + 1, OTHER_PROVER);
    FirstProverProofSubmitter submitter = _submitter(proofRollup);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.FirstProverProofSubmitter__CheckpointAlreadyProven.selector, END, END + 1)
    );
    submitter.submitEpochRootProof(_args());
  }

  function testPendingEndPartialProofRevertsWhenEndIsAlreadyProven() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setTips(END, 0);
    proofRollup.proveRange(START, END, OTHER_PROVER);
    FirstProverProofSubmitter submitter = _submitter(proofRollup);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.FirstProverProofSubmitter__CheckpointAlreadyProven.selector, END, END)
    );
    submitter.submitEpochRootProof(_args());
  }

  function testCompleteProofForwardsAndRollupRecordsProver() external {
    MockSubmittingRollup proofRollup = _buildRollup(4);
    _submitter(proofRollup).submitEpochRootProof(_args());
    assertEq(proofRollup.getSubmitCount(), 1);
    assertEq(proofRollup.getFirstProvenBy(END), PROVER);
  }

  function testCompleteProofForwardsWhenEndIsAlreadyProven() external {
    MockSubmittingRollup proofRollup = _buildRollup(4);
    proofRollup.proveRange(START, END, OTHER_PROVER);
    _submitter(proofRollup).submitEpochRootProof(_args());
    assertEq(proofRollup.getSubmitCount(), 1);
    assertEq(proofRollup.getFirstProvenBy(END), OTHER_PROVER);
  }

  function testPendingEndCompleteProofForwardsWhenEndIsAlreadyProven() external {
    MockSubmittingRollup proofRollup = _buildRollup(4);
    proofRollup.setTips(END, 0);
    proofRollup.proveRange(START, END, OTHER_PROVER);
    _submitter(proofRollup).submitEpochRootProof(_args());
    assertEq(proofRollup.getSubmitCount(), 1);
    assertEq(proofRollup.getFirstProvenBy(END), OTHER_PROVER);
  }

  function testRollupRevertBubbles() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setSubmitReverts(true);
    FirstProverProofSubmitter submitter = _submitter(proofRollup);
    vm.expectRevert(MockSubmittingRollup.SubmitFailed.selector);
    submitter.submitEpochRootProof(_args());
  }
}
