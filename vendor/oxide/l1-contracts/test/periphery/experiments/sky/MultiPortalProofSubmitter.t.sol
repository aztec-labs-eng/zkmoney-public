// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {MultiPortalProofSubmitter} from "@periphery/experiments/sky/MultiPortalProofSubmitter.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {SubmitEpochRootProofArgs, PublicInputArgs} from "@aztec/core/interfaces/IRollup.sol";
import {ProposedHeader} from "@aztec/core/libraries/rollup/ProposedHeaderLib.sol";
import {CommitteeAttestations} from "@aztec/core/libraries/rollup/AttestationLib.sol";
import {IHaveVersion, IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Errors as CoreErrors} from "@core/lib/Errors.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {MockRollup} from "@test/fixtures/MockRollup.sol";
import {MockSubmittingRollup} from "@test/periphery/FirstProverProofSubmitter.pin.t.sol";

contract RevertingPreparePortal {
  IRollup public immutable ROLLUP;

  uint256 public recordCalls;

  error PrepareFailed();

  constructor(IRollup _rollup) {
    ROLLUP = _rollup;
  }

  function prepareFirstProver(uint256, address) external pure {
    revert PrepareFailed();
  }

  function recordFirstProver(uint256, uint256, address) external {
    recordCalls++;
  }
}

contract RevertingRecordPortal {
  IRollup public immutable ROLLUP;

  uint256 public prepareCalls;

  error RecordFailed();

  constructor(IRollup _rollup) {
    ROLLUP = _rollup;
  }

  function prepareFirstProver(uint256, address) external {
    prepareCalls++;
  }

  function recordFirstProver(uint256, uint256, address) external pure {
    revert RecordFailed();
  }
}

contract MultiPortalProofSubmitterTest is OxidePortalBase {
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

  function _submitterFor(MockSubmittingRollup _proofRollup) internal returns (MultiPortalProofSubmitter) {
    return new MultiPortalProofSubmitter(IRollup(address(_proofRollup)), OWNER);
  }

  function testPinsRollupAndOwner() external {
    MultiPortalProofSubmitter submitter = new MultiPortalProofSubmitter(IRollup(address(rollup)), OWNER);
    assertEq(address(submitter.ROLLUP()), address(rollup));
    assertEq(submitter.owner(), OWNER);
    assertEq(submitter.portals().length, 0);
    assertEq(submitter.portalCount(), 0);
  }

  function testOwnerAddsAndRemovesPortals() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    OxidePortal portalA = _portalFor(proofRollup);
    OxidePortal portalB = _portalFor(proofRollup);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    submitter.addPortal(portalA);
    vm.prank(OWNER);
    submitter.addPortal(portalB);

    IOxidePortal[] memory registered = submitter.portals();
    assertEq(registered.length, 2);
    assertEq(address(registered[0]), address(portalA));
    assertEq(address(registered[1]), address(portalB));
    assertTrue(submitter.$isPortal(portalA));
    assertTrue(submitter.$isPortal(portalB));

    vm.prank(OWNER);
    submitter.removePortal(portalA);

    registered = submitter.portals();
    assertEq(registered.length, 1);
    assertEq(address(registered[0]), address(portalB));
    assertFalse(submitter.$isPortal(portalA));
    assertTrue(submitter.$isPortal(portalB));
  }

  function testNonOwnerCannotAddPortal() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    OxidePortal portalA = _portalFor(proofRollup);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(USER);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, USER));
    submitter.addPortal(portalA);
  }

  function testNonOwnerCannotRemovePortal() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    OxidePortal portalA = _portalFor(proofRollup);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    submitter.addPortal(portalA);

    vm.prank(USER);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, USER));
    submitter.removePortal(portalA);
  }

  function testRejectsPortalOnAnotherRollup() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    vm.expectRevert(
      abi.encodeWithSelector(
        MultiPortalProofSubmitter.MultiPortalProofSubmitter__PortalRollupMismatch.selector,
        address(portal),
        address(rollup)
      )
    );
    submitter.addPortal(portal);
  }

  function testRejectsPortalWithoutCode() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    vm.expectRevert(
      abi.encodeWithSelector(
        MultiPortalProofSubmitter.MultiPortalProofSubmitter__PortalWithoutCode.selector, address(0xDEAD)
      )
    );
    submitter.addPortal(IOxidePortal(address(0xDEAD)));
  }

  function testRejectsDuplicatePortal() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    OxidePortal portalA = _portalFor(proofRollup);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    submitter.addPortal(portalA);

    vm.prank(OWNER);
    vm.expectRevert(
      abi.encodeWithSelector(
        MultiPortalProofSubmitter.MultiPortalProofSubmitter__PortalAlreadyRegistered.selector, address(portalA)
      )
    );
    submitter.addPortal(portalA);
  }

  function testRejectsRemovalOfUnregisteredPortal() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    OxidePortal portalA = _portalFor(proofRollup);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    vm.expectRevert(
      abi.encodeWithSelector(
        MultiPortalProofSubmitter.MultiPortalProofSubmitter__PortalNotRegistered.selector, address(portalA)
      )
    );
    submitter.removePortal(portalA);
  }

  function testPartialProofCapturesFirstProverOnEveryPortal() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setAdvanceProvenTo(11);
    OxidePortal portalA = _portalFor(proofRollup);
    OxidePortal portalB = _portalFor(proofRollup);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    submitter.addPortal(portalA);
    vm.prank(OWNER);
    submitter.addPortal(portalB);

    submitter.submitEpochRootProof(_args());

    assertEq(portalA.$firstProver(11), PROVER);
    assertEq(portalB.$firstProver(11), PROVER);
    assertEq(proofRollup.getSubmitCount(), 1);
    assertEq(proofRollup.getLastStart(), 9);
    assertEq(proofRollup.getLastEnd(), 11);
    assertEq(proofRollup.getLastProver(), PROVER);
  }

  function testCompleteProofSkipsOnlyThePortalThatFailedPrepare() external {
    MockSubmittingRollup proofRollup = _buildRollup(4);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setAdvanceProvenTo(11);
    OxidePortal portalA = _portalFor(proofRollup);
    RevertingPreparePortal failing = new RevertingPreparePortal(IRollup(address(proofRollup)));
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    submitter.addPortal(IOxidePortal(address(failing)));
    vm.prank(OWNER);
    submitter.addPortal(portalA);

    vm.expectCall(address(failing), abi.encodeCall(RevertingPreparePortal.prepareFirstProver, (11, PROVER)));
    submitter.submitEpochRootProof(_args());

    assertEq(failing.recordCalls(), 0);
    assertEq(portalA.$firstProver(11), PROVER);
    assertEq(proofRollup.getSubmitCount(), 1);
  }

  function testPartialProofRevertsWhenOnePortalPrepareFails() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setAdvanceProvenTo(11);
    OxidePortal portalA = _portalFor(proofRollup);
    RevertingPreparePortal failing = new RevertingPreparePortal(IRollup(address(proofRollup)));
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    submitter.addPortal(portalA);
    vm.prank(OWNER);
    submitter.addPortal(IOxidePortal(address(failing)));

    vm.expectRevert(RevertingPreparePortal.PrepareFailed.selector);
    submitter.submitEpochRootProof(_args());
    assertEq(proofRollup.getSubmitCount(), 0);
  }

  function testEmptyPortalListStillSubmits() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setAdvanceProvenTo(11);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    submitter.submitEpochRootProof(_args());

    assertEq(proofRollup.getSubmitCount(), 1);
    assertEq(proofRollup.getLastEnd(), 11);
  }

  function testRemovedPortalNoLongerCaptures() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setAdvanceProvenTo(11);
    OxidePortal portalA = _portalFor(proofRollup);
    OxidePortal portalB = _portalFor(proofRollup);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    submitter.addPortal(portalA);
    vm.prank(OWNER);
    submitter.addPortal(portalB);
    vm.prank(OWNER);
    submitter.removePortal(portalA);

    submitter.submitEpochRootProof(_args());

    assertEq(portalA.$firstProver(11), address(0));
    assertEq(portalB.$firstProver(11), PROVER);
    assertEq(proofRollup.getSubmitCount(), 1);
  }

  function testRejectsMismatchedRollupOnMockRollup() external {
    MockRollup otherRollup = new MockRollup();
    MultiPortalProofSubmitter submitter = new MultiPortalProofSubmitter(IRollup(address(otherRollup)), OWNER);

    vm.prank(OWNER);
    vm.expectRevert(
      abi.encodeWithSelector(
        MultiPortalProofSubmitter.MultiPortalProofSubmitter__PortalRollupMismatch.selector,
        address(portal),
        address(rollup)
      )
    );
    submitter.addPortal(portal);
  }

  function test_GivenAPartialProof_WhenOnePortalRecordFails_ThenTheWholeSubmissionReverts() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setAdvanceProvenTo(11);
    OxidePortal portalA = _portalFor(proofRollup);
    RevertingRecordPortal failing = new RevertingRecordPortal(IRollup(address(proofRollup)));
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    submitter.addPortal(portalA);
    vm.prank(OWNER);
    submitter.addPortal(IOxidePortal(address(failing)));

    vm.expectRevert(RevertingRecordPortal.RecordFailed.selector);
    submitter.submitEpochRootProof(_args());

    assertEq(proofRollup.getSubmitCount(), 0, "the rollup submission is rolled back");
    assertEq(proofRollup.getProvenCheckpointNumber(), 10);
    assertEq(portalA.$firstProver(11), address(0), "the other portal captures nothing");
  }

  function test_GivenAFrontRunProof_WhenACompleteProofIsSubmittedThroughTheSubmitter_ThenItCapturesNothingAndDoesNotRevert()
    external
  {
    MockSubmittingRollup proofRollup = _buildRollup(4);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setAdvanceProvenTo(11);
    OxidePortal portalA = _portalFor(proofRollup);
    OxidePortal portalB = _portalFor(proofRollup);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    submitter.addPortal(portalA);
    vm.prank(OWNER);
    submitter.addPortal(portalB);

    proofRollup.submitEpochRootProof(_args());
    assertEq(proofRollup.getProvenCheckpointNumber(), 11, "the front-run proof lands first");

    submitter.submitEpochRootProof(_args());

    assertEq(proofRollup.getSubmitCount(), 2, "the submitter still forwards the proof to the rollup");
    assertEq(portalA.$firstProver(11), address(0), "no first prover is captured");
    assertEq(portalB.$firstProver(11), address(0), "no first prover is captured");
  }

  function test_GivenAFrontRunProof_WhenAPartialProofIsSubmittedThroughTheSubmitter_ThenItReverts() external {
    MockSubmittingRollup proofRollup = _buildRollup(3);
    proofRollup.setProvenCheckpointNumber(10);
    proofRollup.setAdvanceProvenTo(11);
    OxidePortal portalA = _portalFor(proofRollup);
    MultiPortalProofSubmitter submitter = _submitterFor(proofRollup);

    vm.prank(OWNER);
    submitter.addPortal(portalA);

    proofRollup.submitEpochRootProof(_args());

    vm.expectRevert(abi.encodeWithSelector(CoreErrors.OxidePortal__CheckpointAlreadyProven.selector, 11, 11));
    submitter.submitEpochRootProof(_args());

    assertEq(proofRollup.getSubmitCount(), 1);
    assertEq(portalA.$firstProver(11), address(0));
  }
}
