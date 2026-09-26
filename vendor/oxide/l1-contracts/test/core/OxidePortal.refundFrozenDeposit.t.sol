// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {Caps} from "@core/Caps.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@core/lib/Errors.sol";

contract OxidePortalRefundFrozenDepositTest is OxidePortalBase {
  bytes32 internal constant DEFAULT_SILOED_NULLIFIER = bytes32(uint256(0xC1A1));

  function test_GivenPortalIsUninitialized_WhenRefundFrozenDepositIsCalled() external {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig;

    vm.expectRevert(Errors.OxidePortal__Uninitialized.selector);
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }

  function test_GivenPortalIsNotFrozen_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent-not-frozen")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectRevert(Errors.OxidePortal__NotFrozen.selector);
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }

  function test_GivenValidFrozenDepositWithdrawal_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    assertEq(publicInputs.length, OxideConstants.FROZEN_DEPOSIT_REFUND_PUBLIC_INPUT_COUNT);
    assertEq(publicInputs[0], bytes32(block.chainid));
    assertEq(publicInputs[1], bytes32(portal.ROLLUP_VERSION()));
    assertEq(publicInputs[2], bytes32(uint256(uint160(address(portal)))));
    assertEq(publicInputs[3], portal.$freezeArchive());
    assertEq(publicInputs[4], bytes32(p.amount));
    assertEq(publicInputs[5], bytes32(uint256(uint160(p.executor))));
    assertEq(publicInputs[6], p.userPayloadHash);
    assertEq(publicInputs[7], DEFAULT_SILOED_NULLIFIER);
    frozenDepositRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectEmit(true, true, true, true, address(portal));
    emit WithdrawalOrRefund(IExecutor.Flow.FrozenDepositRefund, DEFAULT_SILOED_NULLIFIER, p.executor, p.amount);

    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));
  }

  function test_GivenProcessorTip_WhenRefundFrozenDepositIsCalled_ThenCallerReceivesTip()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent-tip")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.processorTip = 7;
    _syncPayloadHash(p);
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositRefundVerifier.setExpected(proof, publicInputs);
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));
    uint256 recipientBalanceBefore = underlying.balanceOf(p.recipient);
    uint256 tipRecipientBalanceBefore = underlying.balanceOf(p.tipRecipient);

    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), recipientBalanceBefore + p.amount - p.processorTip);
    assertEq(underlying.balanceOf(p.tipRecipient), tipRecipientBalanceBefore + p.processorTip);
  }

  function test_GivenAmountExceedsTxLimit_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent-over-cap")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.amount = OxideConstants.TX_AMOUNT_CAP + 1;
    bytes memory sig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectRevert(Errors.Caps__TxLimitSurpassed.selector);
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, hex"c0ffee", sig);
  }

  function test_GivenPortalWasFrozenAfterRollupReplacement_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent-replaced-rollup")
    givenRollupIsNonCanonical
  {
    vm.prank(USER);
    portal.freeze();

    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));
  }

  function test_GivenZeroNullifier_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent-zero")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, bytes32(0)));

    vm.expectRevert(Errors.OxidePortal__ZeroRefundNullifier.selector);
    _refundFrozenDeposit(p, bytes32(0), proof, sig);
  }

  function test_GivenNullifierIsAlreadySpent_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent-replay")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount * 2);
    bytes memory sig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);

    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__RefundNullifierAlreadySpent.selector, DEFAULT_SILOED_NULLIFIER)
    );
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }

  function test_GivenVerifierRejectsProof_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent-invalid-proof")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    frozenDepositRefundVerifier.setShouldVerify(false);

    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectRevert(Errors.OxidePortal__InvalidFrozenDepositRefundProof.selector);
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);

    assertFalse(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));
  }

  function test_GivenTeeSignerIsUnregistered_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenPortalIsFrozen
  {
    (, uint256 unregisteredPk) = makeAddrAndKey("tee-unspent-unregistered");
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositRefundVerifier.setExpected(proof, publicInputs);
    bytes memory sig = _signTee(unregisteredPk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }

  function test_GivenFrozenNotesRefundDigest_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent-wrong-domain")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositRefundVerifier.setExpected(proof, publicInputs);

    bytes32[] memory pretendNullifiers = new bytes32[](1);
    pretendNullifiers[0] = DEFAULT_SILOED_NULLIFIER;
    bytes memory wrongDomainSig = _signTee(teePk, _frozenNotesRefundFinalDigest(p, pretendNullifiers));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, wrongDomainSig);
  }

  function test_GivenWithdrawalSignature_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent-withdraw-domain")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs =
      _frozenDepositRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositRefundVerifier.setExpected(proof, publicInputs);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }

  function test_GivenAmountOrRecipientMutated_WhenRefundFrozenDepositIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unspent-mutated-inputs")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    p.amount = p.amount + 1;
    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, sig);
  }
}
