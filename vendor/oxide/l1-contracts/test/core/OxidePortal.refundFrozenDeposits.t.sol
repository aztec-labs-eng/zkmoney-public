// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {Caps} from "@core/Caps.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@core/lib/Errors.sol";

contract OxidePortalRefundFrozenDepositsTest is OxidePortalBase {
  bytes32 internal constant DEFAULT_SILOED_NULLIFIER = bytes32(uint256(0xC1A1));

  function test_GivenPortalIsNotFrozen_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-not-frozen")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectRevert(Errors.OxidePortal__NotFrozen.selector);
    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }

  function test_GivenValidFrozenDepositWithdrawal_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    assertEq(publicInputs.length, OxideConstants.FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT);
    assertEq(publicInputs[0], bytes32(block.chainid));
    assertEq(publicInputs[1], bytes32(portal.ROLLUP_VERSION()));
    assertEq(publicInputs[2], bytes32(uint256(uint160(address(portal)))));
    assertEq(publicInputs[3], portal.$freezeArchive());
    assertEq(publicInputs[4], bytes32(p.amount));
    assertEq(publicInputs[5], bytes32(uint256(uint160(p.executor))));
    assertEq(publicInputs[6], p.userPayloadHash);
    assertEq(publicInputs[7], DEFAULT_SILOED_NULLIFIER);
    assertEq(publicInputs[8], bytes32(0));
    assertEq(publicInputs[OxideConstants.FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT - 1], bytes32(0));
    frozenDepositsRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectEmit(true, true, true, true, address(portal));
    emit WithdrawalOrRefund(IExecutor.Flow.FrozenDepositsRefund, DEFAULT_SILOED_NULLIFIER, p.executor, p.amount);

    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));
  }

  function _twoNullifiers() internal pure returns (bytes32[] memory nullifiers) {
    nullifiers = new bytes32[](2);
    nullifiers[0] = DEFAULT_SILOED_NULLIFIER;
    nullifiers[1] = bytes32(uint256(0xC1A2));
  }

  function test_GivenTwoDeposits_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-two")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _twoNullifiers();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, nullifiers);
    assertEq(publicInputs[7], nullifiers[0]);
    assertEq(publicInputs[8], nullifiers[1]);
    assertEq(publicInputs[9], bytes32(0));
    assertEq(publicInputs[OxideConstants.FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT - 1], bytes32(0));
    frozenDepositsRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, nullifiers));

    vm.expectEmit(true, true, true, true, address(portal));
    emit WithdrawalOrRefund(IExecutor.Flow.FrozenDepositsRefund, nullifiers[0], p.executor, p.amount);

    _refundFrozenDeposits(p, nullifiers, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isRefundNullifierSpent(nullifiers[0]));
    assertTrue(portal.$isRefundNullifierSpent(nullifiers[1]));
  }

  function test_GivenFullBatchOfDeposits_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-full")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = new bytes32[](OxideConstants.MAX_FROZEN_DEPOSITS_PER_REFUND);
    for (uint256 i = 0; i < nullifiers.length; i++) {
      nullifiers[i] = bytes32(uint256(0xC1B0 + i));
    }
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, nullifiers);
    assertEq(publicInputs.length, OxideConstants.FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT);
    for (uint256 i = 0; i < nullifiers.length; i++) {
      assertEq(publicInputs[i + 7], nullifiers[i]);
    }
    assertEq(
      publicInputs[OxideConstants.FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT - 1], nullifiers[nullifiers.length - 1]
    );
    frozenDepositsRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, nullifiers));

    vm.expectEmit(true, true, true, true, address(portal));
    emit WithdrawalOrRefund(IExecutor.Flow.FrozenDepositsRefund, nullifiers[0], p.executor, p.amount);

    _refundFrozenDeposits(p, nullifiers, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    for (uint256 i = 0; i < nullifiers.length; i++) {
      assertTrue(portal.$isRefundNullifierSpent(nullifiers[i]));
    }
  }

  function test_GivenNoNullifiers_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-empty")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = new bytes32[](0);
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, nullifiers));

    vm.expectRevert(Errors.OxidePortal__EmptyFrozenDepositsRefundNullifiers.selector);
    _refundFrozenDeposits(p, nullifiers, proof, sig);
  }

  function test_GivenTooManyNullifiers_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-too-many")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = new bytes32[](OxideConstants.MAX_FROZEN_DEPOSITS_PER_REFUND + 1);
    bytes memory proof = hex"c0ffee";
    bytes memory sig;

    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__TooManyFrozenDepositsRefundNullifiers.selector, nullifiers.length)
    );
    _refundFrozenDeposits(p, nullifiers, proof, sig);
  }

  function test_GivenZeroNullifierInBatch_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-zero-in-batch")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _twoNullifiers();
    nullifiers[1] = bytes32(0);
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, nullifiers));

    vm.expectRevert(Errors.OxidePortal__ZeroRefundNullifier.selector);
    _refundFrozenDeposits(p, nullifiers, proof, sig);
  }

  function test_GivenDuplicateNullifier_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-duplicate")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory nullifiers = _twoNullifiers();
    nullifiers[1] = nullifiers[0];
    bytes memory proof = hex"c0ffee";
    bytes memory sig;

    vm.expectRevert(abi.encodeWithSelector(Errors.OxidePortal__RefundNullifierAlreadySpent.selector, nullifiers[0]));
    _refundFrozenDeposits(p, nullifiers, proof, sig);

    assertFalse(portal.$isRefundNullifierSpent(nullifiers[0]));
  }

  function test_GivenProcessorTip_WhenRefundFrozenDepositsIsCalled_ThenCallerReceivesTip()
    external
    givenTeeIsRegistered("tee-unspent-tip")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.processorTip = 7;
    _syncPayloadHash(p);
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositsRefundVerifier.setExpected(proof, publicInputs);
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));
    uint256 recipientBalanceBefore = underlying.balanceOf(p.recipient);
    uint256 tipRecipientBalanceBefore = underlying.balanceOf(p.tipRecipient);

    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), recipientBalanceBefore + p.amount - p.processorTip);
    assertEq(underlying.balanceOf(p.tipRecipient), tipRecipientBalanceBefore + p.processorTip);
  }

  function test_GivenAmountExceedsTxLimit_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-over-cap")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.amount = TX_AMOUNT_CAP + 1;
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectRevert(Errors.Caps__TxLimitSurpassed.selector);
    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, hex"c0ffee", sig);
  }

  function test_GivenPortalWasFrozenAfterRollupReplacement_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-replaced-rollup")
    givenRollupIsNonCanonical
  {
    vm.prank(USER);
    portal.freeze();

    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositsRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));
  }

  function test_GivenZeroNullifier_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-zero")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, bytes32(0)));

    vm.expectRevert(Errors.OxidePortal__ZeroRefundNullifier.selector);
    _refundFrozenDeposits(p, bytes32(0), proof, sig);
  }

  function test_GivenNullifierIsAlreadySpent_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-replay")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositsRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount * 2);
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));
    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, sig);

    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__RefundNullifierAlreadySpent.selector, DEFAULT_SILOED_NULLIFIER)
    );
    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }

  function test_GivenVerifierRejectsProof_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-invalid-proof")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    frozenDepositsRefundVerifier.setShouldVerify(false);

    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectRevert(Errors.OxidePortal__InvalidFrozenDepositsRefundProof.selector);
    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, sig);

    assertFalse(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));
  }

  function test_GivenTeeSignerIsUnregistered_WhenRefundFrozenDepositsIsCalled() external givenPortalIsFrozen {
    (, uint256 unregisteredPk) = makeAddrAndKey("tee-unspent-unregistered");
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositsRefundVerifier.setExpected(proof, publicInputs);
    bytes memory sig = _signTee(unregisteredPk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }

  function test_GivenFrozenNotesRefundDigest_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-wrong-domain")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositsRefundVerifier.setExpected(proof, publicInputs);

    bytes32[] memory pretendNullifiers = new bytes32[](1);
    pretendNullifiers[0] = DEFAULT_SILOED_NULLIFIER;
    bytes memory wrongDomainSig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, pretendNullifiers));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, wrongDomainSig);
  }

  function test_GivenWithdrawalSignature_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-withdraw-domain")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositsRefundVerifier.setExpected(proof, publicInputs);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }

  function test_GivenAmountOrRecipientMutated_WhenRefundFrozenDepositsIsCalled()
    external
    givenTeeIsRegistered("tee-unspent-mutated-inputs")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    p.amount = p.amount + 1;
    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }
}
