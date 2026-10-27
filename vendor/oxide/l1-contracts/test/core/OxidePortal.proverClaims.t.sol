// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {ProverClaimLib} from "@core/lib/ProverClaimLib.sol";
import {Errors} from "@core/lib/Errors.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";

contract OxidePortalProverClaimsTest is OxidePortalBase {
  address internal constant PROVER = address(0xBEEF);
  address internal constant OTHER_PROVER = address(0xC0DE);
  address internal constant STRANGER = address(0x5757);
  uint256 internal constant CLAIM_EPOCH = 9;
  uint256 internal constant EPOCH_START = 9;
  uint256 internal constant EPOCH_END = 13;
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
        sender: DataStructures.L2Actor({actor: L2_TOKEN, version: ROLLUP_VERSION}),
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

  function _setupEpoch() internal {
    _registerSigner();
    rollup.setCheckpoint(EPOCH_START - 1, bytes32(0), CLAIM_EPOCH - 1);
    for (uint256 c = EPOCH_START; c <= EPOCH_END; c++) {
      rollup.setCheckpoint(c, c == CHECKPOINT ? DEFAULT_ARCHIVE_ROOT : bytes32(0), CLAIM_EPOCH);
    }
    rollup.setProvenCheckpointNumber(EPOCH_START - 1);
  }

  function _buildClaim(uint256 _tip, uint256 _proofLength)
    internal
    returns (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim)
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.proverTip = _tip;
    p.checkpointNumber = CHECKPOINT;
    p.epochNumber = CLAIM_EPOCH;
    p.leafIndex = LEAF_INDEX;
    p.withdrawalId = WITHDRAWAL_ID;
    bytes32 messageHash = _messageHash(p);
    (bytes32 root, bytes32[] memory path) = _path(messageHash);
    outbox.setRoot(CLAIM_EPOCH, _proofLength, root);
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

  function _claim(uint256 _tip)
    internal
    returns (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim)
  {
    _setupEpoch();
    rollup.proveRange(EPOCH_START, CHECKPOINT, PROVER);
    (args, claim) = _buildClaim(_tip, PROOF_LENGTH);
  }

  function _lists(IOxidePortal.ProverClaimArgs memory _args, ProverClaimLib.ProverClaim memory _proverClaim)
    internal
    pure
    returns (IOxidePortal.ProverTipClaim[] memory claims)
  {
    claims = new IOxidePortal.ProverTipClaim[](1);
    claims[0] = IOxidePortal.ProverTipClaim({args: _args, proof: _proverClaim});
  }

  function testClaimPaysTipAndTracksLeaf() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(2 ether);
    underlying.mint(address(portal), 2 ether);
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
    uint256 leafId = (1 << PATH_LENGTH) + LEAF_INDEX;
    assertEq(underlying.balanceOf(PROVER), 2 ether);
    assertTrue(portal.$claimed(CLAIM_EPOCH, leafId));
  }

  function testOnlyTheRecordedProverCanClaim() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(2 ether);
    underlying.mint(address(portal), 2 ether);
    vm.prank(STRANGER);
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__NotFirstProver.selector, CHECKPOINT, PROVER));
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
    assertFalse(portal.$isWithdrawalProverClaimSpent(WITHDRAWAL_ID));

    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
    assertEq(underlying.balanceOf(PROVER), 2 ether);
  }

  function testClaimPaysTipAndSubsidyToProver() external {
    uint256 proverTip = 2 ether;
    uint256 subsidy = 1 ether;
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(proverTip);
    vm.prank(OWNER);
    proverSubsidy.setSubsidy(subsidy);
    underlying.mint(address(portal), proverTip);
    underlying.mint(address(proverSubsidy), subsidy);

    vm.prank(PROVER);
    uint256 claimedSubsidy = portal.claimProverTips(proverSubsidy, _lists(args, claim));

    assertEq(claimedSubsidy, subsidy);
    assertEq(underlying.balanceOf(PROVER), proverTip + subsidy);
  }

  function testClaimRejectsProverThatWasNotFirst() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    underlying.mint(address(portal), 1 ether);
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__NotFirstProver.selector, CHECKPOINT, PROVER));
    vm.prank(OTHER_PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
  }

  function testClaimPaysProverWhoseProofEndsPastTheMessage() external {
    _setupEpoch();
    rollup.proveRange(EPOCH_START, CHECKPOINT + 1, PROVER);
    rollup.proveRange(EPOCH_START, EPOCH_END, OTHER_PROVER);
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) =
      _buildClaim(2 ether, PROOF_LENGTH + 1);
    underlying.mint(address(portal), 2 ether);

    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__NotFirstProver.selector, CHECKPOINT, PROVER));
    vm.prank(OTHER_PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));

    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
    assertEq(underlying.balanceOf(PROVER), 2 ether);
  }

  function testClaimPaysProverWhoMovedTheTipPastTheMessage() external {
    _setupEpoch();
    rollup.proveRange(EPOCH_START, CHECKPOINT - 1, OTHER_PROVER);
    rollup.proveRange(EPOCH_START, CHECKPOINT, PROVER);
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) =
      _buildClaim(2 ether, PROOF_LENGTH);
    underlying.mint(address(portal), 2 ether);

    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__NotFirstProver.selector, CHECKPOINT, PROVER));
    vm.prank(OTHER_PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));

    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
    assertEq(underlying.balanceOf(PROVER), 2 ether);
  }

  function testClaimAcceptsLongerProofRootForTheFirstProver() external {
    _setupEpoch();
    rollup.proveRange(EPOCH_START, CHECKPOINT, PROVER);
    rollup.proveRange(EPOCH_START, EPOCH_END, OTHER_PROVER);
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) =
      _buildClaim(2 ether, EPOCH_END - EPOCH_START + 1);
    underlying.mint(address(portal), 2 ether);

    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));

    assertEq(underlying.balanceOf(PROVER), 2 ether);
    assertEq(underlying.balanceOf(OTHER_PROVER), 0);
  }

  function testClaimRejectsUnprovenMessageCheckpoint() external {
    _setupEpoch();
    rollup.proveRange(EPOCH_START, CHECKPOINT - 1, PROVER);
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) =
      _buildClaim(1 ether, PROOF_LENGTH);
    underlying.mint(address(portal), 1 ether);

    vm.expectRevert(Errors.OxidePortal__UnprovenCheckpoint.selector);
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
  }

  function testClaimRejectsProverTipAboveAmountBeforeClaimStateChanges() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    args.content.proverTip = args.content.amount + 1;

    vm.expectRevert(Errors.OxidePortal__ProverTipExceedsAmount.selector);
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));

    assertFalse(portal.$isWithdrawalProverClaimSpent(WITHDRAWAL_ID));
  }

  function testClaimRejectsDuplicateWithdrawalId() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    underlying.mint(address(portal), 2 ether);
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__WithdrawalProverClaimAlreadyMade.selector, WITHDRAWAL_ID)
    );
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimRejectsDuplicateLeaf() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    underlying.mint(address(portal), 2 ether);
    IOxidePortal.ProverTipClaim[] memory claims = _lists(args, claim);
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);

    bytes32 withdrawalId = bytes32(uint256(0xC1A2));
    bytes32 messageHash = _messageHash(args.content);
    args.withdrawalId = withdrawalId;
    args.teeSignature =
      _signTee(TEST_TEE_PK, _teeWithdrawalFinalDigest(DEFAULT_ARCHIVE_ROOT, withdrawalId, messageHash));
    claims[0] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    uint256 leafId = (1 << PATH_LENGTH) + LEAF_INDEX;
    vm.expectRevert(
      abi.encodeWithSelector(Errors.ProverClaim__ClaimAlreadyTracked.selector, address(portal), CLAIM_EPOCH, leafId)
    );
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);
  }

  function testClaimBatchRevertsAtomically() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    underlying.mint(address(portal), 2 ether);
    IOxidePortal.ProverTipClaim[] memory claims = new IOxidePortal.ProverTipClaim[](2);
    claims[0] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    claims[1] = IOxidePortal.ProverTipClaim({args: args, proof: claim});
    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__WithdrawalProverClaimAlreadyMade.selector, WITHDRAWAL_ID)
    );
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, claims);
    uint256 leafId = (1 << PATH_LENGTH) + LEAF_INDEX;
    assertFalse(portal.$claimed(CLAIM_EPOCH, leafId));
    assertFalse(portal.$isWithdrawalProverClaimSpent(WITHDRAWAL_ID));
    assertEq(underlying.balanceOf(PROVER), 0);
  }

  function testClaimAtFreezeBoundarySucceeds() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    underlying.mint(address(portal), 1 ether);
    _freeze();
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
    assertEq(underlying.balanceOf(PROVER), 1 ether);
  }

  function testClaimRejectsShortPath() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.path = new bytes32[](4);
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__PathTooShort.selector, 4, 5));
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
  }

  function testClaimRejectsLongPath() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.path = new bytes32[](256);
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__PathTooLong.selector, 256));
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
  }

  function testClaimRejectsLeafIndexOutsidePath() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.messageLeafIndex = 1 << PATH_LENGTH;
    vm.expectRevert(
      abi.encodeWithSelector(Errors.ProverClaim__LeafIndexOutOfBounds.selector, 1 << PATH_LENGTH, PATH_LENGTH)
    );
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
  }

  function testClaimRejectsMissingOutboxRoot() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    outbox.setRoot(CLAIM_EPOCH, PROOF_LENGTH, bytes32(0));
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__UnprovenEpoch.selector, CLAIM_EPOCH));
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
  }

  function testClaimRejectsInvalidOutboxMembership() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.path[0] = bytes32(uint256(0xBAD));
    vm.expectRevert();
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
  }

  function testClaimRejectsCheckpointEpochMismatch() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.epochNumber = CLAIM_EPOCH + 1;
    vm.expectRevert(
      abi.encodeWithSelector(Errors.ProverClaim__CheckpointEpochMismatch.selector, CHECKPOINT, CLAIM_EPOCH + 1)
    );
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
  }

  function testClaimRejectsProofBeforeMessageCheckpoint() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    claim.messageLeafIndex = 2 << (PATH_LENGTH - 5);
    claim.proofLength = 1;
    vm.expectRevert(abi.encodeWithSelector(Errors.ProverClaim__ProofLengthBelowMessageCheckpoint.selector, 1, 3));
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
  }

  function testClaimRejectsUnknownArchiveAndRollsBack() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    rollup.setArchive(CHECKPOINT, bytes32(0));
    vm.expectRevert(Errors.OxidePortal__UnknownCheckpoint.selector);
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
    assertFalse(portal.$isWithdrawalProverClaimSpent(WITHDRAWAL_ID));
  }

  function testClaimRejectsUnregisteredTeeAndRollsBack() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    args.teeSignature =
      _signTee(0xBADA55, _teeWithdrawalFinalDigest(DEFAULT_ARCHIVE_ROOT, WITHDRAWAL_ID, _messageHash(args.content)));
    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
    assertFalse(portal.$isWithdrawalProverClaimSpent(WITHDRAWAL_ID));
  }

  function testClaimRejectsFreezeDepth() external {
    (IOxidePortal.ProverClaimArgs memory args, ProverClaimLib.ProverClaim memory claim) = _claim(1 ether);
    _freeze();
    claim.proofLength = PROOF_LENGTH + 1;
    vm.expectRevert(Errors.OxidePortal__ProofDepthPastFreeze.selector);
    vm.prank(PROVER);
    portal.claimProverTips(proverSubsidy, _lists(args, claim));
  }
}
