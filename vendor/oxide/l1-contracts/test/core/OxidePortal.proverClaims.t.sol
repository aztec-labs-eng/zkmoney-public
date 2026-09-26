// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {ProverClaimLib} from "@core/lib/ProverClaimLib.sol";
import {Errors} from "@core/lib/Errors.sol";
import {ProverSubsidy} from "@periphery/ProverSubsidy.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";

contract OxidePortalProverClaimsTest is OxidePortalBase {
  address internal constant PROVER = address(0xBEEF);
  address internal constant OTHER_PROVER = address(0xC0DE);
  uint256 internal constant CLAIM_EPOCH = 9;
  uint256 internal constant PATH_LENGTH = 7;
  uint256 internal constant LEAF_INDEX = 10;
  uint256 internal constant CHECKPOINT = 11;
  uint256 internal constant PROOF_LENGTH = 3;
  bytes32 internal constant WITHDRAWAL_ID = bytes32(uint256(0xC1A1));

  function testEpochOutHashTreeHeightMatchesMaxCheckpointsPerEpoch() external pure {
    assertEq(1 << ProverClaimLib.EPOCH_OUT_HASH_TREE_HEIGHT, Constants.MAX_CHECKPOINTS_PER_EPOCH);
  }

  function _messageHash(IOxidePortal.WithdrawContent memory _content) internal view returns (bytes32) {
    bytes32 contentHash = Hash.sha256ToField(
      abi.encodeWithSignature(
        "withdraw(address,bytes32,uint256,uint256,uint256)",
        _content.executor,
        _content.userPayloadHash,
        _content.amount,
        _content.proverTip,
        _content.randomness
      )
    );
    return Hash.sha256ToField(
      DataStructures.L2ToL1Msg({
        sender: DataStructures.L2Actor({actor: L2_PORTAL, version: ROLLUP_VERSION}),
        recipient: DataStructures.L1Actor({actor: address(portal), chainId: block.chainid}),
        content: contentHash
      })
    );
  }

  function _path(bytes32 _leaf) internal pure returns (bytes32 root, bytes32[] memory path) {
    path = new bytes32[](PATH_LENGTH);
    bytes32 acc = _leaf;
    for (uint256 i = 0; i < PATH_LENGTH; i++) {
      path[i] = bytes32(uint256(0xA0) + i);
      acc = ((LEAF_INDEX >> i) & 1) == 1
        ? Hash.sha256ToField(bytes.concat(path[i], acc))
        : Hash.sha256ToField(bytes.concat(acc, path[i]));
    }
    root = acc;
  }

  function _claim(uint256 _tip)
    internal
    returns (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim)
  {
    _initialize();
    _registerSigner();
    rollup.setCheckpoint(CHECKPOINT - PROOF_LENGTH + 1, bytes32(0), CLAIM_EPOCH);
    rollup.setCheckpoint(CHECKPOINT - PROOF_LENGTH, bytes32(0), CLAIM_EPOCH - 1);
    rollup.setCheckpoint(CHECKPOINT, DEFAULT_ARCHIVE_ROOT, CLAIM_EPOCH);
    rollup.setHasSubmitted(CLAIM_EPOCH, PROOF_LENGTH, PROVER, true);
    rollup.setProvenCheckpointNumber(CHECKPOINT - 1);
    portal.prepareFirstProver(CHECKPOINT, PROVER);
    rollup.setProvenCheckpointNumber(CHECKPOINT);
    portal.recordFirstProver(CHECKPOINT, PROOF_LENGTH, PROVER);
    WithdrawParams memory p = _defaultWithdrawParams();
    p.proverTip = _tip;
    p.checkpointNumber = CHECKPOINT;
    p.epochNumber = CLAIM_EPOCH;
    p.leafIndex = LEAF_INDEX;
    p.withdrawalId = WITHDRAWAL_ID;
    bytes32 messageHash = _messageHash(p);
    (bytes32 root, bytes32[] memory path) = _path(messageHash);
    outbox.setRoot(CLAIM_EPOCH, PROOF_LENGTH, root);
    args = IOxidePortal.ProverClaimArgs({
      content: IOxidePortal.WithdrawContent({
        executor: p.executor,
        userPayloadHash: p.userPayloadHash,
        amount: p.amount,
        proverTip: p.proverTip,
        randomness: p.randomness
      }),
      checkpointNumber: CHECKPOINT,
      withdrawalId: WITHDRAWAL_ID,
      teeSignature: _signTee(TEST_TEE_PK, _teeWithdrawalFinalDigest(DEFAULT_ARCHIVE_ROOT, WITHDRAWAL_ID, messageHash))
    });
    claim = ProverClaimLib.ProverClaim({
      epochNumber: CLAIM_EPOCH,
      messageLeafIndex: LEAF_INDEX,
      path: path,
      proofLength: PROOF_LENGTH,
      checkpointNumber: CHECKPOINT
    });
  }

  function _lists(IOxidePortal.ProverClaimArgs memory _args, ProverClaimLib.ProverClaim memory _proverClaim)
    internal
    pure
    returns (IOxidePortal.ProverTipClaim[] memory claims)
  {
    claims = new IOxidePortal.ProverTipClaim[](1);
    claims[0] = IOxidePortal.ProverTipClaim({args: _args, proof: _proverClaim});
  }

  function _buildClaim(uint256 _tip, uint256 _proofLength)
    internal
    view
    returns (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim)
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.proverTip = _tip;
    p.checkpointNumber = CHECKPOINT;
    p.epochNumber = CLAIM_EPOCH;
    p.leafIndex = LEAF_INDEX;
    p.withdrawalId = WITHDRAWAL_ID;
    bytes32 messageHash = _messageHash(p);
    (, bytes32[] memory path) = _path(messageHash);
    args = IOxidePortal.ProverClaimArgs({
      content: IOxidePortal.WithdrawContent({
        executor: p.executor,
        userPayloadHash: p.userPayloadHash,
        amount: p.amount,
        proverTip: p.proverTip,
        randomness: p.randomness
      }),
      checkpointNumber: CHECKPOINT,
      withdrawalId: WITHDRAWAL_ID,
      teeSignature: _signTee(TEST_TEE_PK, _teeWithdrawalFinalDigest(DEFAULT_ARCHIVE_ROOT, WITHDRAWAL_ID, messageHash))
    });
    claim = ProverClaimLib.ProverClaim({
      epochNumber: CLAIM_EPOCH,
      messageLeafIndex: LEAF_INDEX,
      path: path,
      proofLength: _proofLength,
      checkpointNumber: CHECKPOINT
    });
  }

  function _captureProverBeyondMessageCheckpoint()
    internal
    returns (uint256 captureCheckpoint, uint256 capturedProofLength)
  {
    captureCheckpoint = CHECKPOINT + 2;
    capturedProofLength = PROOF_LENGTH + 2;

    rollup.setCheckpoint(CHECKPOINT - PROOF_LENGTH + 1, bytes32(0), CLAIM_EPOCH);
    rollup.setCheckpoint(CHECKPOINT - PROOF_LENGTH, bytes32(0), CLAIM_EPOCH - 1);
    rollup.setCheckpoint(CHECKPOINT, DEFAULT_ARCHIVE_ROOT, CLAIM_EPOCH);
    rollup.setCheckpoint(captureCheckpoint, bytes32(0), CLAIM_EPOCH);
    rollup.setHasSubmitted(CLAIM_EPOCH, capturedProofLength, PROVER, true);

    rollup.setProvenCheckpointNumber(captureCheckpoint - 1);
    portal.prepareFirstProver(captureCheckpoint, PROVER);
    rollup.setProvenCheckpointNumber(captureCheckpoint);
    portal.recordFirstProver(captureCheckpoint, capturedProofLength, PROVER);
  }

  function _captureOtherProverInNextEpoch() internal returns (uint256 nextEpochCheckpoint) {
    nextEpochCheckpoint = CHECKPOINT + 1;

    rollup.setCheckpoint(CHECKPOINT - PROOF_LENGTH + 1, bytes32(0), CLAIM_EPOCH);
    rollup.setCheckpoint(CHECKPOINT - PROOF_LENGTH, bytes32(0), CLAIM_EPOCH - 1);
    rollup.setCheckpoint(CHECKPOINT, DEFAULT_ARCHIVE_ROOT, CLAIM_EPOCH);
    rollup.setCheckpoint(nextEpochCheckpoint, bytes32(0), CLAIM_EPOCH + 1);
    rollup.setHasSubmitted(CLAIM_EPOCH + 1, 1, OTHER_PROVER, true);

    rollup.setProvenCheckpointNumber(nextEpochCheckpoint - 1);
    portal.prepareFirstProver(nextEpochCheckpoint, OTHER_PROVER);
    rollup.setProvenCheckpointNumber(nextEpochCheckpoint);
    portal.recordFirstProver(nextEpochCheckpoint, 1, OTHER_PROVER);
  }

  function testClaimPaysTipAndTracksLeaf() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(2 ether);
    underlying.mint(address(portal), 2 ether);
    IOxidePortal.ProverTipClaim[] memory claims = new IOxidePortal.ProverTipClaim[](1);
    claims[0] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);
    uint256 leafId = (1 << PATH_LENGTH) + LEAF_INDEX;
    assertEq(underlying.balanceOf(PROVER), 2 ether);
    assertTrue(portal.$claimed(CLAIM_EPOCH, leafId));
  }

  function testClaimRejectsProverTipAboveAmountBeforeClaimStateChanges() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    args.content.proverTip = args.content.amount + 1;
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);

    vm.expectRevert(Errors.OxidePortal__ProverTipExceedsAmount.selector);
    portal.claimProverTips(proverSubsidy, claims);

    assertFalse(portal.$isWithdrawalProverClaimSpent(WITHDRAWAL_ID));
  }

  function testClaimPaysTipAndSubsidy() external {
    uint256 proverTip = 2 ether;
    uint256 subsidy = 1 ether;
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(proverTip);
    vm.prank(OWNER);
    proverSubsidy.setSubsidy(subsidy);
    underlying.mint(address(portal), proverTip);
    underlying.mint(address(proverSubsidy), subsidy);
    IOxidePortal.ProverTipClaim[] memory claims = new IOxidePortal.ProverTipClaim[](1);
    claims[0] = IOxidePortal.ProverTipClaim({args: args, proof: claim});

    vm.prank(PROVER);
    uint256 claimedSubsidy = portal.claimProverTips(proverSubsidy, claims);

    assertEq(claimedSubsidy, subsidy);
    assertEq(underlying.balanceOf(PROVER), proverTip + subsidy);
  }

  function testClaimRejectsDuplicateWithdrawalId() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    underlying.mint(address(portal), 2 ether);
    IOxidePortal.ProverTipClaim[] memory claims = new IOxidePortal.ProverTipClaim[](1);
    claims[0] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);
    vm.prank(PROVER);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__WithdrawalProverClaimAlreadyMade.selector, WITHDRAWAL_ID)
    );
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsDuplicateLeaf() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    underlying.mint(address(portal), 2 ether);
    IOxidePortal.ProverTipClaim[] memory claims = new IOxidePortal.ProverTipClaim[](1);
    claims[0] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);

    bytes32 withdrawalId = bytes32(uint256(0xC1A2));
    bytes32 messageHash = _messageHash(args.content);
    args.withdrawalId = withdrawalId;
    args.teeSignature =
      _signTee(TEST_TEE_PK, _teeWithdrawalFinalDigest(DEFAULT_ARCHIVE_ROOT, withdrawalId, messageHash));
    claims[0] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    uint256 leafId = (1 << PATH_LENGTH) + LEAF_INDEX;
    vm.prank(PROVER);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.ProverClaim__ClaimAlreadyTracked.selector, address(portal), CLAIM_EPOCH, leafId)
    );
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimBatchRevertsAtomically() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    underlying.mint(address(portal), 2 ether);
    IOxidePortal.ProverTipClaim[] memory claims = new IOxidePortal.ProverTipClaim[](2);
    claims[0] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    claims[1] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    vm.prank(PROVER);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__WithdrawalProverClaimAlreadyMade.selector, WITHDRAWAL_ID)
    );
    portal.claimProverTips(proverSubsidy, claims);
    uint256 leafId = (1 << PATH_LENGTH) + LEAF_INDEX;
    assertFalse(portal.$claimed(CLAIM_EPOCH, leafId));
    assertFalse(portal.$isWithdrawalProverClaimSpent(WITHDRAWAL_ID));
    assertEq(underlying.balanceOf(PROVER), 0);
  }

  function testClaimRejectsWrongFirstProver() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    IOxidePortal.ProverTipClaim[] memory claims = new IOxidePortal.ProverTipClaim[](1);
    claims[0] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    vm.prank(address(0xCAFE));
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__NotFirstProver.selector, CHECKPOINT, PROVER));
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimAtFreezeBoundarySucceeds() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    underlying.mint(address(portal), 1 ether);
    IOxidePortal.ProverTipClaim[] memory claims = new IOxidePortal.ProverTipClaim[](1);
    claims[0] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    vm.prank(OWNER);
    portal.freeze();
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);
    assertEq(underlying.balanceOf(PROVER), 1 ether);
  }

  function testClaimRejectsShortPath() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.path = new bytes32[](4);
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__PathTooShort.selector, 4, 5));
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsLongPath() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.path = new bytes32[](256);
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__PathTooLong.selector, 256));
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsLeafIndexOutsidePath() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.messageLeafIndex = 1 << PATH_LENGTH;
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.ProverClaim__LeafIndexOutOfBounds.selector, 1 << PATH_LENGTH, PATH_LENGTH)
    );
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsMissingOutboxRoot() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    outbox.setRoot(CLAIM_EPOCH, PROOF_LENGTH, bytes32(0));
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__UnprovenEpoch.selector, CLAIM_EPOCH));
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsInvalidOutboxMembership() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.path[0] = bytes32(uint256(0xBAD));
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert();
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsCheckpointEpochMismatch() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.epochNumber = CLAIM_EPOCH + 1;
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.ProverClaim__CheckpointEpochMismatch.selector, CHECKPOINT, CLAIM_EPOCH + 1)
    );
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsProofBeforeMessageCheckpoint() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.messageLeafIndex = 2 << (PATH_LENGTH - 5);
    claim.proofLength = 1;
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__ProofLengthBelowMessageCheckpoint.selector, 1, 3));
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsMissingFirstProverInRange() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.epochNumber = CLAIM_EPOCH + 1;
    claim.checkpointNumber = CHECKPOINT + 1;
    claim.messageLeafIndex = 0;
    claim.proofLength = 1;
    args.checkpointNumber = CHECKPOINT + 1;
    args.teeSignature =
      _signTee(TEST_TEE_PK, _teeWithdrawalFinalDigest(DEFAULT_ARCHIVE_ROOT, WITHDRAWAL_ID, _messageHash(args.content)));
    rollup.setCheckpoint(CHECKPOINT + 1, DEFAULT_ARCHIVE_ROOT, CLAIM_EPOCH + 1);
    rollup.setProvenCheckpointNumber(CHECKPOINT + 1);
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.ProverClaim__NoFirstProverInRange.selector, CHECKPOINT + 1, CHECKPOINT + 1)
    );
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsUnknownArchiveAndRollsBack() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    rollup.setArchive(CHECKPOINT, bytes32(0));
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert(Errors.OxidePortal__UnknownCheckpoint.selector);
    portal.claimProverTips(proverSubsidy, claims);
    assertFalse(portal.$isWithdrawalProverClaimSpent(WITHDRAWAL_ID));
  }

  function testClaimRejectsUnregisteredTeeAndRollsBack() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    args.teeSignature =
      _signTee(0xBADA55, _teeWithdrawalFinalDigest(DEFAULT_ARCHIVE_ROOT, WITHDRAWAL_ID, _messageHash(args.content)));
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    portal.claimProverTips(proverSubsidy, claims);
    assertFalse(portal.$isWithdrawalProverClaimSpent(WITHDRAWAL_ID));
  }

  function testClaimRejectsFreezeDepth() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    outbox.setRoot(CLAIM_EPOCH, PROOF_LENGTH, bytes32(uint256(1)));
    vm.prank(OWNER);
    portal.freeze();
    claim.proofLength = PROOF_LENGTH + 1;
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    vm.expectRevert(Errors.OxidePortal__ProofDepthPastFreeze.selector);
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsCaptureBeyondClaimantProofLength() external {
    _initialize();
    _registerSigner();
    _captureProverBeyondMessageCheckpoint();

    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) =
      _buildClaim(4 ether, PROOF_LENGTH);
    underlying.mint(address(portal), 4 ether);
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);

    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__NoFirstProverInRange.selector, CHECKPOINT, CHECKPOINT));
    vm.prank(OTHER_PROVER);
    portal.claimProverTips(proverSubsidy, claims);
    assertEq(underlying.balanceOf(OTHER_PROVER), 0);
  }

  function testClaimRejectsCapturedProverClaimingWithShorterProofLength() external {
    _initialize();
    _registerSigner();
    _captureProverBeyondMessageCheckpoint();

    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) =
      _buildClaim(2 ether, PROOF_LENGTH);
    underlying.mint(address(portal), 2 ether);
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);

    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__NoFirstProverInRange.selector, CHECKPOINT, CHECKPOINT));
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);
    assertEq(underlying.balanceOf(PROVER), 0);
  }

  function testClaimRejectsFirstProverInNextEpoch() external {
    _initialize();
    _registerSigner();
    _captureOtherProverInNextEpoch();

    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) =
      _buildClaim(2 ether, PROOF_LENGTH);
    underlying.mint(address(portal), 2 ether);
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);

    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__NoFirstProverInRange.selector, CHECKPOINT, CHECKPOINT));
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);
    assertEq(underlying.balanceOf(PROVER), 0);
  }

  function testClaimRejectsProofLengthReachingNextEpochCapture() external {
    _initialize();
    _registerSigner();
    uint256 nextEpochCheckpoint = _captureOtherProverInNextEpoch();
    uint256 crossingProofLength = PROOF_LENGTH + 1;

    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) =
      _buildClaim(2 ether, crossingProofLength);
    underlying.mint(address(portal), 2 ether);
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);

    vm.expectRevert(
      abi.encodeWithSelector(Errors.ProverClaim__ProofCheckpointNotInEpoch.selector, nextEpochCheckpoint, CLAIM_EPOCH)
    );
    vm.prank(OTHER_PROVER);
    portal.claimProverTips(proverSubsidy, claims);
    assertEq(underlying.balanceOf(OTHER_PROVER), 0);
  }
}
