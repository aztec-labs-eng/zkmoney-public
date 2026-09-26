// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {FirstProverProofSubmitter} from "@periphery/FirstProverProofSubmitter.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {SubmitEpochRootProofArgs, PublicInputArgs} from "@aztec/core/interfaces/IRollup.sol";
import {ProposedHeader} from "@aztec/core/libraries/rollup/ProposedHeaderLib.sol";
import {CommitteeAttestations} from "@aztec/core/libraries/rollup/AttestationLib.sol";
import {ChainTips} from "@aztec/core/libraries/compressed-data/Tips.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {IHaveVersion, IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {MockRollup} from "@test/fixtures/MockRollup.sol";

contract MockSubmittingRollup is MockRollup {
  ChainTips internal tips;
  Epoch internal currentEpoch;
  uint256 internal advanceProvenTo;
  uint256 internal submitCount;
  uint256 internal lastStart;
  uint256 internal lastEnd;
  address internal lastProver;
  bool internal submitReverts;

  error SubmitFailed();

  function setTips(uint256 _pending, uint256 _proven) external {
    tips = ChainTips({pending: _pending, proven: _proven});
  }

  function setCurrentEpoch(uint256 _epoch) external {
    currentEpoch = Epoch.wrap(_epoch);
  }

  function setAdvanceProvenTo(uint256 _checkpointNumber) external {
    advanceProvenTo = _checkpointNumber;
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
    lastStart = _args.start;
    lastEnd = _args.end;
    lastProver = _args.args.proverId;
    if (advanceProvenTo != 0) provenCheckpointNumber = advanceProvenTo;
  }

  function getSubmitCount() external view returns (uint256) {
    return submitCount;
  }

  function getLastStart() external view returns (uint256) {
    return lastStart;
  }

  function getLastEnd() external view returns (uint256) {
    return lastEnd;
  }

  function getLastProver() external view returns (address) {
    return lastProver;
  }
}

contract FirstProverProofSubmitterPinTest is OxidePortalBase {
  address internal constant PROVER = address(0xBEEF);

  function _portalFor(MockSubmittingRollup _proofRollup) internal returns (OxidePortal) {
    registry.setRollup(ROLLUP_VERSION, IHaveVersion(address(_proofRollup)));
    return new OxidePortal(
      OWNER,
      OxidePortal.FpcFunding({funder: FPC_FUNDER, cut: 0}),
      certManager,
      nitroValidator,
      IERC20(address(underlying)),
      IRegistry(address(registry)),
      ROLLUP_VERSION,
      OxidePortal.RefundVerifiers({
        frozenNotes: IVerifier(address(frozenNotesRefundVerifier)),
        frozenDeposit: IVerifier(address(frozenDepositRefundVerifier)),
        unprocessedDeposit: IVerifier(address(unprocessedDepositRefundVerifier))
      }),
      RATE,
      GLOBAL_LIMIT
    );
  }

  function _args() internal pure returns (SubmitEpochRootProofArgs memory) {
    return SubmitEpochRootProofArgs({
      start: 9,
      end: 11,
      args: PublicInputArgs({
        previousArchive: bytes32(0), endArchive: bytes32(0), outHash: bytes32(0), proverId: PROVER
      }),
      headers: new ProposedHeader[](0),
      attestations: CommitteeAttestations({signatureIndices: new bytes(0), signaturesOrAddresses: new bytes(0)}),
      blobInputs: new bytes(0),
      proof: new bytes(0)
    });
  }

  function _buildRollup(uint256 _nextEpoch) internal returns (MockSubmittingRollup) {
    MockSubmittingRollup proofRollup = new MockSubmittingRollup();
    proofRollup.setCheckpoint(8, bytes32(0), 2);
    proofRollup.setCheckpoint(9, bytes32(0), 3);
    proofRollup.setCheckpoint(10, bytes32(0), 3);
    proofRollup.setCheckpoint(11, bytes32(0), 3);
    proofRollup.setCheckpoint(12, bytes32(0), _nextEpoch);
    proofRollup.setTips(12, 0);
    proofRollup.setCurrentEpoch(_nextEpoch);
    proofRollup.setHasSubmitted(3, 3, PROVER, true);
    return proofRollup;
  }

  function testPinsPortalRollup() external {
    FirstProverProofSubmitter submitter = new FirstProverProofSubmitter(IRollup(address(rollup)), portal);
    assertEq(address(submitter.ROLLUP()), address(rollup));
    assertEq(address(submitter.PORTAL()), address(portal));
  }

  function testRejectsMismatchedRollup() external {
    MockRollup otherRollup = new MockRollup();
    vm.expectRevert();
    new FirstProverProofSubmitter(IRollup(address(otherRollup)), portal);
  }

  function testPartialProofCapturesFirstProver() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setAdvanceProvenTo(11);
    OxidePortal capturePortal = _portalFor(proofRollup);
    FirstProverProofSubmitter submitter = new FirstProverProofSubmitter(IRollup(address(proofRollup)), capturePortal);
    submitter.submitEpochRootProof(_args());
    assertEq(capturePortal.$firstProver(11), PROVER);
    assertEq(proofRollup.getSubmitCount(), 1);
    assertEq(proofRollup.getLastStart(), 9);
    assertEq(proofRollup.getLastEnd(), 11);
    assertEq(proofRollup.getLastProver(), PROVER);
  }

  function testPendingEndPartialProofCapturesFirstProver() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setTips(11, 0);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setAdvanceProvenTo(11);
    OxidePortal capturePortal = _portalFor(proofRollup);
    FirstProverProofSubmitter submitter = new FirstProverProofSubmitter(IRollup(address(proofRollup)), capturePortal);
    submitter.submitEpochRootProof(_args());
    assertEq(capturePortal.$firstProver(11), PROVER);
    assertEq(proofRollup.getSubmitCount(), 1);
  }

  function testCompleteProofIgnoresCaptureFailure() external {
    MockSubmittingRollup proofRollup = _buildRollup(4);
    proofRollup.setProvenCheckpointNumber(11);
    OxidePortal capturePortal = _portalFor(proofRollup);
    FirstProverProofSubmitter submitter = new FirstProverProofSubmitter(IRollup(address(proofRollup)), capturePortal);
    submitter.submitEpochRootProof(_args());
    assertEq(capturePortal.$firstProver(11), address(0));
    assertEq(proofRollup.getSubmitCount(), 1);
  }

  function testPendingEndCompleteProofIgnoresCaptureFailure() external {
    MockSubmittingRollup proofRollup = _buildRollup(4);
    proofRollup.setTips(11, 0);
    proofRollup.setProvenCheckpointNumber(11);
    OxidePortal capturePortal = _portalFor(proofRollup);
    FirstProverProofSubmitter submitter = new FirstProverProofSubmitter(IRollup(address(proofRollup)), capturePortal);
    submitter.submitEpochRootProof(_args());
    assertEq(capturePortal.$firstProver(11), address(0));
    assertEq(proofRollup.getSubmitCount(), 1);
  }

  function testPartialProofRevertsWhenPrepareFails() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setProvenCheckpointNumber(11);
    OxidePortal capturePortal = _portalFor(proofRollup);
    FirstProverProofSubmitter submitter = new FirstProverProofSubmitter(IRollup(address(proofRollup)), capturePortal);
    vm.expectRevert();
    submitter.submitEpochRootProof(_args());
    assertEq(proofRollup.getSubmitCount(), 0);
  }

  function testPartialProofRevertsWhenRecordFails() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setProvenCheckpointNumber(10);
    OxidePortal capturePortal = _portalFor(proofRollup);
    FirstProverProofSubmitter submitter = new FirstProverProofSubmitter(IRollup(address(proofRollup)), capturePortal);
    vm.expectRevert();
    submitter.submitEpochRootProof(_args());
  }

  function testCompleteProofIgnoresRecordFailure() external {
    MockSubmittingRollup proofRollup = _buildRollup(4);
    proofRollup.setProvenCheckpointNumber(10);
    OxidePortal capturePortal = _portalFor(proofRollup);
    FirstProverProofSubmitter submitter = new FirstProverProofSubmitter(IRollup(address(proofRollup)), capturePortal);
    submitter.submitEpochRootProof(_args());
    assertEq(proofRollup.getSubmitCount(), 1);
    assertEq(capturePortal.$firstProver(11), address(0));
  }

  function testRollupRevertSkipsRecord() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setSubmitReverts(true);
    OxidePortal capturePortal = _portalFor(proofRollup);
    FirstProverProofSubmitter submitter = new FirstProverProofSubmitter(IRollup(address(proofRollup)), capturePortal);
    vm.expectRevert(MockSubmittingRollup.SubmitFailed.selector);
    submitter.submitEpochRootProof(_args());
    assertEq(capturePortal.$firstProver(11), address(0));
  }
}
