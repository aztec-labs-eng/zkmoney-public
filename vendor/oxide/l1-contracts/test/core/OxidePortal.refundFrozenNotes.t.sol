// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {Caps} from "@core/Caps.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@core/lib/Errors.sol";

contract OxidePortalRefundFrozenNotesTest is OxidePortalBase {
  function test_GivenPortalIsNotFrozen_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced-not-frozen")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _defaultFrozenNotesRefundNullifiers();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers));

    vm.expectRevert(Errors.OxidePortal__NotFrozen.selector);
    _refundFrozenNotes(p, nullifiers, proof, sig);
  }

  function test_GivenValidFrozenNotesWithdrawal_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _defaultFrozenNotesRefundNullifiers();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs = _frozenNotesRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, nullifiers);
    assertEq(publicInputs.length, OxideConstants.FROZEN_NOTES_REFUND_PUBLIC_INPUT_COUNT);
    assertEq(publicInputs[0], bytes32(block.chainid));
    assertEq(publicInputs[1], bytes32(portal.ROLLUP_VERSION()));
    assertEq(publicInputs[2], bytes32(uint256(uint160(address(portal)))));
    assertEq(publicInputs[3], portal.$l2Portal());
    assertEq(publicInputs[4], portal.$freezeArchive());
    assertEq(publicInputs[5], bytes32(p.amount));
    assertEq(publicInputs[6], bytes32(uint256(uint160(p.executor))));
    assertEq(publicInputs[7], p.userPayloadHash);
    assertEq(publicInputs[8], nullifiers[0]);
    assertEq(publicInputs[9], nullifiers[1]);
    assertEq(publicInputs[10], bytes32(0));
    assertEq(publicInputs[OxideConstants.FROZEN_NOTES_REFUND_PUBLIC_INPUT_COUNT - 1], bytes32(0));
    frozenNotesRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers));

    vm.expectEmit(true, true, true, true, address(portal));
    emit WithdrawalOrRefund(IExecutor.Flow.FrozenNotesRefund, nullifiers[0], p.executor, p.amount);

    _refundFrozenNotes(p, nullifiers, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isRefundNullifierSpent(nullifiers[0]));
    assertTrue(portal.$isRefundNullifierSpent(nullifiers[1]));
    assertFalse(portal.$isRefundNullifierSpent(bytes32(0)));
  }

  function test_GivenAmountExceedsTxLimit_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced-over-cap")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.amount = OxideConstants.TX_AMOUNT_CAP + 1;
    bytes32[] memory nullifiers = _defaultFrozenNotesRefundNullifiers();
    bytes memory sig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers));

    vm.expectRevert(Errors.Caps__TxLimitSurpassed.selector);
    _refundFrozenNotes(p, nullifiers, hex"c0ffee", sig);
  }

  function test_GivenPortalWasFrozenAfterRollupReplacement_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced-replaced-rollup")
    givenRollupIsNonCanonical
  {
    vm.prank(USER);
    portal.freeze();

    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _defaultFrozenNotesRefundNullifiers();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs = _frozenNotesRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, nullifiers);
    frozenNotesRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers));

    _refundFrozenNotes(p, nullifiers, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isRefundNullifierSpent(nullifiers[0]));
    assertTrue(portal.$isRefundNullifierSpent(nullifiers[1]));
  }

  function test_GivenNoNullifiers_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced-empty")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = new bytes32[](0);
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers));

    vm.expectRevert(Errors.OxidePortal__EmptyFrozenNotesRefundNullifiers.selector);
    _refundFrozenNotes(p, nullifiers, proof, sig);
  }

  function test_GivenTooManyNullifiers_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced-too-many")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = new bytes32[](OxideConstants.MAX_FROZEN_NOTES_PER_REFUND + 1);
    bytes memory proof = hex"c0ffee";
    bytes memory sig;

    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__TooManyFrozenNotesRefundNullifiers.selector, nullifiers.length)
    );
    _refundFrozenNotes(p, nullifiers, proof, sig);
  }

  function test_GivenZeroNullifier_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced-zero")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _defaultFrozenNotesRefundNullifiers();
    nullifiers[1] = bytes32(0);
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers));

    vm.expectRevert(Errors.OxidePortal__ZeroRefundNullifier.selector);
    _refundFrozenNotes(p, nullifiers, proof, sig);
  }

  function test_GivenDuplicateNullifier_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced-duplicate")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _defaultFrozenNotesRefundNullifiers();
    nullifiers[1] = nullifiers[0];
    bytes memory proof = hex"c0ffee";
    bytes memory sig;

    vm.expectRevert(abi.encodeWithSelector(Errors.OxidePortal__RefundNullifierAlreadySpent.selector, nullifiers[0]));
    _refundFrozenNotes(p, nullifiers, proof, sig);

    assertFalse(portal.$isRefundNullifierSpent(nullifiers[0]));
  }

  function test_GivenVerifierRejectsProof_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced-invalid-proof")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _defaultFrozenNotesRefundNullifiers();
    bytes memory proof = hex"c0ffee";
    frozenNotesRefundVerifier.setShouldVerify(false);

    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers));

    vm.expectRevert(Errors.OxidePortal__InvalidFrozenNotesRefundProof.selector);
    _refundFrozenNotes(p, nullifiers, proof, sig);

    assertFalse(portal.$isRefundNullifierSpent(nullifiers[0]));
  }

  function test_GivenTeeSignatureIsInvalid_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenPortalIsFrozen
  {
    (, uint256 unregisteredPk) = makeAddrAndKey("tee-forced-unregistered");
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _defaultFrozenNotesRefundNullifiers();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs = _frozenNotesRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, nullifiers);
    frozenNotesRefundVerifier.setExpected(proof, publicInputs);
    bytes memory sig = _signTee(unregisteredPk, _frozenNotesRefundFinalDigest(p, nullifiers));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundFrozenNotes(p, nullifiers, proof, sig);
  }

  function test_GivenWithdrawalSignature_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced-wrong-domain")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _defaultFrozenNotesRefundNullifiers();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs = _frozenNotesRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, nullifiers);
    frozenNotesRefundVerifier.setExpected(proof, publicInputs);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundFrozenNotes(p, nullifiers, proof, sig);
  }

  function test_GivenNullifierIsAlreadySpent_WhenRefundFrozenNotesIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-forced-replay")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _defaultFrozenNotesRefundNullifiers();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs = _frozenNotesRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, nullifiers);
    frozenNotesRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount * 2);
    bytes memory sig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers));
    _refundFrozenNotes(p, nullifiers, proof, sig);

    vm.expectRevert(abi.encodeWithSelector(Errors.OxidePortal__RefundNullifierAlreadySpent.selector, nullifiers[0]));
    _refundFrozenNotes(p, nullifiers, proof, sig);
  }

  function _defaultFrozenNotesRefundNullifiers() internal pure returns (bytes32[] memory nullifiers) {
    nullifiers = new bytes32[](2);
    nullifiers[0] = bytes32(uint256(0xA));
    nullifiers[1] = bytes32(uint256(0xB));
  }
}
