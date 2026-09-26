// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors as CoreErrors} from "@core/lib/Errors.sol";

contract OxidePortalWithdrawFrozenTest is OxidePortalBase {
  function _freezeFreezeEpoch(uint256 _count) internal {
    _setCheckpoint(4);
    if (_count > 0) {
      outbox.setRoot(4, _count, bytes32(uint256(0xC0FFEE)));
    }
    _freezeAsOwner();
  }

  function test_GivenFreezeEpochWithdrawal_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-frozen")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 4;
    _freezeFreezeEpoch(2);

    bytes32[] memory path = new bytes32[](0);
    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    _withdrawFrozen(p, 2, 0, path, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isWithdrawalSpent(p.withdrawalId));

    assertEq(outbox.callCount(), 1);
    (,,,,, uint256 epoch, uint256 numCheckpointsInEpoch, uint256 calledLeafIndex, uint256 pathLength) = outbox.calls(0);
    assertEq(epoch, p.epochNumber);
    assertEq(numCheckpointsInEpoch, portal.$freezeCheckpointCount());
    assertEq(numCheckpointsInEpoch, 2);
    assertEq(calledLeafIndex, 0);
    assertEq(pathLength, 0);
  }

  function test_GivenConsumeDepthPastFreezeCount_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-frozen-deep")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 4;
    _freezeFreezeEpoch(2);

    bytes32[] memory path = new bytes32[](0);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(CoreErrors.OxidePortal__ProofDepthPastFreeze.selector);
    _withdrawFrozen(p, 3, 0, path, sig);
  }

  function test_GivenEpochAfterFreezeEpoch_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-frozen-epoch")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 5;
    _freezeFreezeEpoch(1);

    bytes32[] memory path = new bytes32[](0);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(CoreErrors.OxidePortal__EpochPastFreeze.selector);
    _withdrawFrozen(p, 1, 0, path, sig);
  }

  function test_GivenCheckpointAfterFreeze_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-frozen-checkpoint")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 3;
    p.checkpointNumber = DEFAULT_CHECKPOINT_NUMBER + 1;
    _freezeFreezeEpoch(1);

    bytes32[] memory path = new bytes32[](0);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(CoreErrors.OxidePortal__CheckpointPastFreeze.selector);
    _withdrawFrozen(p, 1, 0, path, sig);
  }

  function test_GivenEpochBeforeFreezeEpoch_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-frozen-previous-epoch")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 3;
    _freezeFreezeEpoch(1);

    bytes32[] memory path = new bytes32[](0);
    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    _withdrawFrozen(p, 7, p.leafIndex, path, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertEq(outbox.callCount(), 1);
    (,,,,, uint256 epoch, uint256 numCheckpointsInEpoch,,) = outbox.calls(0);
    assertEq(epoch, p.epochNumber);
    assertEq(numCheckpointsInEpoch, 7);
  }

  function test_GivenAmountExceedsTxLimit_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-frozen-over-cap")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 4;
    p.amount = OxideConstants.TX_AMOUNT_CAP + 1;
    _freezeFreezeEpoch(2);

    bytes32[] memory path = new bytes32[](0);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(CoreErrors.Caps__TxLimitSurpassed.selector);
    _withdrawFrozen(p, 2, 0, path, sig);
  }

  function test_GivenPortalWasFrozenAfterRollupReplacement_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-frozen-replaced-rollup")
    givenRollupIsNonCanonical
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 4;
    _setCheckpoint(4);
    outbox.setRoot(4, 1, bytes32(uint256(0xC0FFEE)));

    vm.prank(USER);
    portal.freeze();

    bytes32[] memory path = new bytes32[](0);
    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    _withdrawFrozen(p, 1, 0, path, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isWithdrawalSpent(p.withdrawalId));
    assertEq(outbox.callCount(), 1);
  }

  function test_GivenMessageOnlyUnderPostFreezeRoot_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-frozen-root")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 4;
    _freezeFreezeEpoch(1);

    bytes32[] memory path = new bytes32[](0);
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    bytes memory outboxErr = abi.encodeWithSignature("Outbox__NothingToConsumeAtEpoch(uint256)", p.epochNumber);
    outbox.primeRevert(outboxErr);

    vm.expectRevert(outboxErr);
    _withdrawFrozen(p, 1, 0, path, sig);
  }

  function test_GivenFreezeEpochWithdrawalAlreadyClaimed_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-frozen-replay")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 4;
    _freezeFreezeEpoch(2);

    bytes32[] memory path = new bytes32[](0);
    underlying.mint(address(portal), p.amount * 2);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    _withdrawFrozen(p, 2, 0, path, sig);

    vm.expectRevert(CoreErrors.OxidePortal__WithdrawalAlreadyClaimed.selector);
    _withdrawFrozen(p, 2, 0, path, sig);
  }
}
