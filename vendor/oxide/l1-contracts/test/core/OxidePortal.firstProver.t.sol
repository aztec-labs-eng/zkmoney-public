// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@core/lib/Errors.sol";

contract OxidePortalFirstProverTest is OxidePortalBase {
  event FirstProverRecorded(uint256 indexed checkpointNumber, address indexed prover);
  address internal constant PROVER = address(0xBEEF);
  uint256 internal constant CHECKPOINT = 11;
  uint256 internal constant EPOCH_NUMBER = 9;
  uint256 internal constant PROOF_LENGTH = 3;

  function _wire() internal {
    rollup.setCheckpoint(CHECKPOINT - PROOF_LENGTH + 1, bytes32(0), EPOCH_NUMBER);
    rollup.setCheckpoint(CHECKPOINT - PROOF_LENGTH, bytes32(0), EPOCH_NUMBER - 1);
    rollup.setCheckpoint(CHECKPOINT, DEFAULT_ARCHIVE_ROOT, EPOCH_NUMBER);
    rollup.setHasSubmitted(EPOCH_NUMBER, PROOF_LENGTH, PROVER, true);
  }

  function testPrepareRejectsProvenCheckpoint() external {
    rollup.setProvenCheckpointNumber(CHECKPOINT);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__CheckpointAlreadyProven.selector, CHECKPOINT, CHECKPOINT)
    );
    portal.prepareFirstProver(CHECKPOINT, PROVER);
  }

  function testPrepareRejectsZeroProver() external {
    vm.expectRevert(Errors.OxidePortal__InvalidProver.selector);
    portal.prepareFirstProver(CHECKPOINT, address(0));
  }

  function testRecordRequiresPrepare() external {
    rollup.setProvenCheckpointNumber(CHECKPOINT);
    vm.expectRevert(abi.encodeWithSelector(Errors.OxidePortal__FirstProverNotPrepared.selector, CHECKPOINT, PROVER));
    portal.recordFirstProver(CHECKPOINT, PROOF_LENGTH, PROVER);
  }

  function testPrepareAndRecordCapturesProver() external {
    _wire();
    rollup.setProvenCheckpointNumber(CHECKPOINT - 1);
    portal.prepareFirstProver(CHECKPOINT, PROVER);
    rollup.setProvenCheckpointNumber(CHECKPOINT);
    portal.recordFirstProver(CHECKPOINT, PROOF_LENGTH, PROVER);
    assertEq(portal.$firstProver(CHECKPOINT), PROVER);
  }

  function testRecordRejectsProvenMismatch() external {
    _wire();
    rollup.setProvenCheckpointNumber(CHECKPOINT - 1);
    portal.prepareFirstProver(CHECKPOINT, PROVER);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__CheckpointNotJustProven.selector, CHECKPOINT, CHECKPOINT - 1)
    );
    portal.recordFirstProver(CHECKPOINT, PROOF_LENGTH, PROVER);
  }

  function testRecordRejectsInvalidProofLengths() external {
    _wire();
    rollup.setProvenCheckpointNumber(CHECKPOINT - 1);
    portal.prepareFirstProver(CHECKPOINT, PROVER);
    rollup.setProvenCheckpointNumber(CHECKPOINT);
    vm.expectRevert(abi.encodeWithSelector(Errors.OxidePortal__InvalidProofLengthForCheckpoint.selector, CHECKPOINT, 0));
    portal.recordFirstProver(CHECKPOINT, 0, PROVER);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__InvalidProofLengthForCheckpoint.selector, CHECKPOINT, CHECKPOINT + 1)
    );
    portal.recordFirstProver(CHECKPOINT, CHECKPOINT + 1, PROVER);
  }

  function testRecordRejectsProverThatDidNotSubmit() external {
    _wire();
    rollup.setHasSubmitted(EPOCH_NUMBER, PROOF_LENGTH, PROVER, false);
    rollup.setProvenCheckpointNumber(CHECKPOINT - 1);
    portal.prepareFirstProver(CHECKPOINT, PROVER);
    rollup.setProvenCheckpointNumber(CHECKPOINT);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__ProverDidNotSubmit.selector, PROVER, EPOCH_NUMBER, PROOF_LENGTH)
    );
    portal.recordFirstProver(CHECKPOINT, PROOF_LENGTH, PROVER);
  }

  function testRecordRejectsDuplicateAndEmitsEvent() external {
    _wire();
    rollup.setProvenCheckpointNumber(CHECKPOINT - 1);
    portal.prepareFirstProver(CHECKPOINT, PROVER);
    rollup.setProvenCheckpointNumber(CHECKPOINT);
    vm.expectEmit(address(portal));
    emit FirstProverRecorded(CHECKPOINT, PROVER);
    portal.recordFirstProver(CHECKPOINT, PROOF_LENGTH, PROVER);
    vm.expectRevert(abi.encodeWithSelector(Errors.OxidePortal__FirstProverAlreadyRecorded.selector, CHECKPOINT, PROVER));
    portal.recordFirstProver(CHECKPOINT, PROOF_LENGTH, PROVER);
  }
}
