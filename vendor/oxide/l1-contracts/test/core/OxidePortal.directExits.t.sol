// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

contract OxidePortalDirectExitsTest is OxidePortalBase {
  function test_GivenProcessorTip_WhenWithdrawIsCalled_ThenCallerReceivesTip()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-direct-withdraw-tip")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.processorTip = 1 ether;
    p.userPayloadHash = Hash.sha256ToField(abi.encode(p.recipient, p.processorTip));
    p.proverTip = 2 ether;
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _finalDigest(p));
    uint256 recipientBalanceBefore = underlying.balanceOf(p.recipient);
    address caller = address(0xBEEF);
    uint256 callerBalanceBefore = underlying.balanceOf(caller);

    _withdrawWithTipRecipient(p, path, sig, caller);

    assertEq(underlying.balanceOf(p.recipient), recipientBalanceBefore + p.amount - p.processorTip - p.proverTip);
    assertEq(underlying.balanceOf(caller), callerBalanceBefore + p.processorTip);
    assertEq(underlying.balanceOf(address(portal)), p.proverTip);
  }

  function test_GivenProcessorTip_WhenRefundFrozenNotesIsCalled_ThenCallerReceivesTip()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-direct-refund-tip")
    givenPortalIsFrozen
  {
    address caller = address(0xBEEF);
    WithdrawParams memory p = _defaultWithdrawParams();
    p.processorTip = 1 ether;
    p.tipRecipient = caller;
    _syncPayloadHash(p);
    bytes32[] memory nullifiers = new bytes32[](2);
    nullifiers[0] = bytes32(uint256(1));
    nullifiers[1] = bytes32(uint256(2));
    bytes memory proof = hex"c0ffee";
    frozenNotesRefundVerifier.setExpected(
      proof, _frozenNotesRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, nullifiers)
    );
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers));
    uint256 recipientBalanceBefore = underlying.balanceOf(p.recipient);
    uint256 callerBalanceBefore = underlying.balanceOf(caller);

    vm.prank(caller);
    _refundFrozenNotes(p, nullifiers, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), recipientBalanceBefore + p.amount - p.processorTip);
    assertEq(underlying.balanceOf(caller), callerBalanceBefore + p.processorTip);
    assertEq(underlying.balanceOf(address(portal)), 0);
  }
}
