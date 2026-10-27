// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {Caps} from "@core/Caps.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@core/lib/Errors.sol";

contract OxidePortalRefundUnprocessedDepositTest is OxidePortalBase {
  bytes32 internal constant DEFAULT_MESSAGE_HASH = bytes32(uint256(0xDEEDF0));
  uint256 internal constant DEFAULT_MESSAGE_LEAF_INDEX = 5000;
  bytes32 internal constant DEFAULT_SILOED_NULLIFIER = bytes32(uint256(0xBEEF01));

  modifier givenDepositIsRecorded(bytes32 _messageHash, uint256 _messageLeafIndex) {
    _recordDeposit(_messageHash, _messageLeafIndex);
    _;
  }

  function test_revertsWhenPortalIsNotFrozen() external {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = "";

    vm.expectRevert(Errors.OxidePortal__NotFrozen.selector);
    _refundUnprocessedDeposit(p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, proof, sig);
  }

  function test_revertsWhenGivenZeroNullifier() external givenPortalIsFrozen {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = "";

    vm.expectRevert(Errors.OxidePortal__ZeroRefundNullifier.selector);
    _refundUnprocessedDeposit(p, bytes32(0), DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, proof, sig);
  }

  function test_revertsOnDoubleSpend()
    external
    givenTeeIsRegistered("tee-unprocessed-replay")
    givenDepositIsRecorded(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX)
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";

    bytes32[] memory publicInputs = _unprocessedDepositRefundPublicInputs(
      p.executor,
      p.userPayloadHash,
      p.amount,
      DEFAULT_MESSAGE_HASH,
      DEFAULT_MESSAGE_LEAF_INDEX,
      DEFAULT_SILOED_NULLIFIER
    );
    unprocessedDepositRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount * 2);
    bytes memory sig = _signTee(
      teePk,
      _unprocessedDepositRefundFinalDigest(
        p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, DEFAULT_SILOED_NULLIFIER
      )
    );
    _refundUnprocessedDeposit(p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, proof, sig);

    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__RefundNullifierAlreadySpent.selector, DEFAULT_SILOED_NULLIFIER)
    );
    _refundUnprocessedDeposit(p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, proof, sig);
  }

  function test_revertsWhenAmountExceedsTxLimit()
    external
    givenTeeIsRegistered("tee-unprocessed-over-cap")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.amount = TX_AMOUNT_CAP + 1;
    bytes memory sig = _signTee(
      teePk,
      _unprocessedDepositRefundFinalDigest(
        p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, DEFAULT_SILOED_NULLIFIER
      )
    );

    vm.expectRevert(Errors.Caps__TxLimitSurpassed.selector);
    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, hex"c0ffee", sig
    );
  }

  function test_revertsOnDoubleSpendViaFrozenDepositsPath()
    external
    givenTeeIsRegistered("tee-unprocessed-cross-path-replay")
    givenDepositIsRecorded(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX)
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";

    underlying.mint(address(portal), p.amount);
    bytes32[] memory frozenDepositsPublicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositsRefundVerifier.setExpected(proof, frozenDepositsPublicInputs);
    bytes memory frozenDepositSig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));
    _refundFrozenDeposits(p, DEFAULT_SILOED_NULLIFIER, proof, frozenDepositSig);
    assertTrue(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));

    bytes memory sig = _signTee(
      teePk,
      _unprocessedDepositRefundFinalDigest(
        p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, DEFAULT_SILOED_NULLIFIER
      )
    );

    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__RefundNullifierAlreadySpent.selector, DEFAULT_SILOED_NULLIFIER)
    );
    _refundUnprocessedDeposit(p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, proof, sig);
  }

  function test_revertsOnSignatureFromUnregisteredTEE()
    external
    givenDepositIsRecorded(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX)
    givenPortalIsFrozen
  {
    (, uint256 unregisteredPk) = makeAddrAndKey("tee-unprocessed-unregistered");
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs = _unprocessedDepositRefundPublicInputs(
      p.executor,
      p.userPayloadHash,
      p.amount,
      DEFAULT_MESSAGE_HASH,
      DEFAULT_MESSAGE_LEAF_INDEX,
      DEFAULT_SILOED_NULLIFIER
    );
    unprocessedDepositRefundVerifier.setExpected(proof, publicInputs);
    bytes memory sig = _signTee(
      unregisteredPk,
      _unprocessedDepositRefundFinalDigest(
        p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, DEFAULT_SILOED_NULLIFIER
      )
    );

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundUnprocessedDeposit(p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, proof, sig);
  }

  function test_cannotReplayAuthSignatureFromFrozenDepositsPath()
    external
    givenTeeIsRegistered("tee-unprocessed-wrong-domain")
    givenDepositIsRecorded(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX)
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs = _unprocessedDepositRefundPublicInputs(
      p.executor,
      p.userPayloadHash,
      p.amount,
      DEFAULT_MESSAGE_HASH,
      DEFAULT_MESSAGE_LEAF_INDEX,
      DEFAULT_SILOED_NULLIFIER
    );
    unprocessedDepositRefundVerifier.setExpected(proof, publicInputs);

    bytes memory wrongDomainSig = _signTee(teePk, _frozenDepositsRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, proof, wrongDomainSig
    );
  }

  function test_refundUnprocessedDepositHappyPath()
    external
    givenTeeIsRegistered("tee-unprocessed")
    givenDepositIsRecorded(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX)
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";

    bytes32[] memory publicInputs = _unprocessedDepositRefundPublicInputs(
      p.executor,
      p.userPayloadHash,
      p.amount,
      DEFAULT_MESSAGE_HASH,
      DEFAULT_MESSAGE_LEAF_INDEX,
      DEFAULT_SILOED_NULLIFIER
    );
    assertEq(publicInputs.length, OxideConstants.UNPROCESSED_DEPOSIT_REFUND_PUBLIC_INPUT_COUNT);
    assertEq(publicInputs[0], bytes32(block.chainid));
    assertEq(publicInputs[1], bytes32(portal.ROLLUP_VERSION()));
    assertEq(publicInputs[2], bytes32(uint256(uint160(address(portal)))));
    assertEq(publicInputs[3], portal.$freezeArchive());
    assertEq(publicInputs[4], bytes32(p.amount));
    assertEq(publicInputs[5], bytes32(uint256(uint160(p.executor))));
    assertEq(publicInputs[6], p.userPayloadHash);
    assertEq(publicInputs[7], DEFAULT_MESSAGE_HASH);
    assertEq(publicInputs[8], bytes32(DEFAULT_MESSAGE_LEAF_INDEX));
    assertEq(publicInputs[9], DEFAULT_SILOED_NULLIFIER);
    unprocessedDepositRefundVerifier.setExpected(proof, publicInputs);

    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(
      teePk,
      _unprocessedDepositRefundFinalDigest(
        p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, DEFAULT_SILOED_NULLIFIER
      )
    );

    vm.expectEmit(true, true, true, true, address(portal));
    emit WithdrawalOrRefund(IExecutor.Flow.UnprocessedDepositRefund, DEFAULT_SILOED_NULLIFIER, p.executor, p.amount);

    _refundUnprocessedDeposit(p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));
    assertEq(portal.$depositMessageIndex(DEFAULT_MESSAGE_HASH), DEFAULT_MESSAGE_LEAF_INDEX + 1);
  }

  function test_GivenProcessorTip_WhenRefundUnprocessedDepositIsCalled_ThenCallerReceivesTip()
    external
    givenTeeIsRegistered("tee-unprocessed-tip")
    givenDepositIsRecorded(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX)
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.processorTip = 7;
    _syncPayloadHash(p);
    bytes memory proof = hex"c0ffee";
    bytes32[] memory publicInputs = _unprocessedDepositRefundPublicInputs(
      p.executor,
      p.userPayloadHash,
      p.amount,
      DEFAULT_MESSAGE_HASH,
      DEFAULT_MESSAGE_LEAF_INDEX,
      DEFAULT_SILOED_NULLIFIER
    );
    unprocessedDepositRefundVerifier.setExpected(proof, publicInputs);
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(
      teePk,
      _unprocessedDepositRefundFinalDigest(
        p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, DEFAULT_SILOED_NULLIFIER
      )
    );
    uint256 recipientBalanceBefore = underlying.balanceOf(p.recipient);
    uint256 tipRecipientBalanceBefore = underlying.balanceOf(p.tipRecipient);

    _refundUnprocessedDeposit(p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), recipientBalanceBefore + p.amount - p.processorTip);
    assertEq(underlying.balanceOf(p.tipRecipient), tipRecipientBalanceBefore + p.processorTip);
  }

  function test_revertsWhenDepositMessageIsUnknown()
    external
    givenTeeIsRegistered("tee-unprocessed-unknown-message")
    givenPortalIsFrozen
  {
    _expectUnknownDepositMessage(_defaultWithdrawParams(), DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX);
  }

  function test_revertsWhenUnrecordedMessageClaimsIndexZero()
    external
    givenTeeIsRegistered("tee-unprocessed-unknown-index-zero")
    givenPortalIsFrozen
  {
    _expectUnknownDepositMessage(_defaultWithdrawParams(), DEFAULT_MESSAGE_HASH, 0);
  }

  function test_revertsWhenMessageHashIsRecordedForAnotherDeposit()
    external
    givenTeeIsRegistered("tee-unprocessed-other-hash")
    givenDepositIsRecorded(bytes32(uint256(0xDEAD)), DEFAULT_MESSAGE_LEAF_INDEX)
    givenPortalIsFrozen
  {
    _expectUnknownDepositMessage(_defaultWithdrawParams(), DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX);
  }

  function test_revertsWhenMessageLeafIndexIsAboveTheRecord()
    external
    givenTeeIsRegistered("tee-unprocessed-index-above")
    givenDepositIsRecorded(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX)
    givenPortalIsFrozen
  {
    _expectUnknownDepositMessage(_defaultWithdrawParams(), DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX + 1);
  }

  function test_revertsWhenMessageLeafIndexIsBelowTheRecord()
    external
    givenTeeIsRegistered("tee-unprocessed-index-below")
    givenDepositIsRecorded(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX)
    givenPortalIsFrozen
  {
    _expectUnknownDepositMessage(_defaultWithdrawParams(), DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX - 1);
  }

  function test_refundsDepositRecordedAtIndexZero()
    external
    givenTeeIsRegistered("tee-unprocessed-index-zero")
    givenDepositIsRecorded(DEFAULT_MESSAGE_HASH, 0)
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    unprocessedDepositRefundVerifier.setExpected(
      proof,
      _unprocessedDepositRefundPublicInputs(
        p.executor, p.userPayloadHash, p.amount, DEFAULT_MESSAGE_HASH, 0, DEFAULT_SILOED_NULLIFIER
      )
    );
    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig =
      _signTee(teePk, _unprocessedDepositRefundFinalDigest(p, DEFAULT_MESSAGE_HASH, 0, DEFAULT_SILOED_NULLIFIER));

    _refundUnprocessedDeposit(p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, 0, proof, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));
  }

  function _expectUnknownDepositMessage(WithdrawParams memory p, bytes32 _messageHash, uint256 _messageLeafIndex)
    internal
  {
    bytes memory proof = hex"c0ffee";
    unprocessedDepositRefundVerifier.setExpected(
      proof,
      _unprocessedDepositRefundPublicInputs(
        p.executor, p.userPayloadHash, p.amount, _messageHash, _messageLeafIndex, DEFAULT_SILOED_NULLIFIER
      )
    );
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(
      teePk, _unprocessedDepositRefundFinalDigest(p, _messageHash, _messageLeafIndex, DEFAULT_SILOED_NULLIFIER)
    );

    vm.expectRevert(abi.encodeWithSelector(Errors.OxidePortal__UnknownDepositMessage.selector, _messageHash));
    _refundUnprocessedDeposit(p, DEFAULT_SILOED_NULLIFIER, _messageHash, _messageLeafIndex, proof, sig);
  }
}
