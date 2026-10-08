// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {Caps} from "@core/Caps.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@core/lib/Errors.sol";
import {Errors as AztecErrors} from "@aztec/core/libraries/Errors.sol";

contract OxidePortalRefundUnprocessedDepositTest is OxidePortalBase {
  bytes32 internal constant DEFAULT_MESSAGE_HASH = bytes32(uint256(0xDEEDF0));
  uint256 internal constant DEFAULT_MESSAGE_LEAF_INDEX = 5000;
  bytes32 internal constant DEFAULT_SILOED_NULLIFIER = bytes32(uint256(0xBEEF01));

  uint256 internal constant SUBTREE_SIZE = 1 << Constants.L1_TO_L2_MSG_SUBTREE_HEIGHT;

  function _inboxSubtreeRootFromPath(bytes32 leaf, uint256 leafIndexInSubtree, bytes32[] memory path)
    internal
    pure
    returns (bytes32 root)
  {
    root = leaf;
    for (uint256 i = 0; i < path.length; i++) {
      bool isRight = ((leafIndexInSubtree >> i) & 1) == 1;
      root = isRight ? Hash.sha256ToField(bytes.concat(path[i], root)) : Hash.sha256ToField(bytes.concat(root, path[i]));
    }
  }

  function _defaultInboxSiblingPath() internal pure returns (bytes32[] memory path) {
    path = new bytes32[](10);
  }

  function _primeInbox(bytes32 messageHash, uint256 messageLeafIndex)
    internal
    returns (uint256 checkpointNumber, bytes32[] memory inboxSiblingPath)
  {
    checkpointNumber = (messageLeafIndex / SUBTREE_SIZE) + Constants.INITIAL_CHECKPOINT_NUMBER;
    uint256 subtreeIndex = messageLeafIndex % SUBTREE_SIZE;
    inboxSiblingPath = _defaultInboxSiblingPath();
    bytes32 subtreeRoot = _inboxSubtreeRootFromPath(messageHash, subtreeIndex, inboxSiblingPath);
    inbox.setRoot(checkpointNumber, subtreeRoot);
    inbox.setInProgress(uint64(checkpointNumber + 1));
  }

  function test_revertsWhenPortalIsNotInitialized() external {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig;
    bytes32[] memory path = _defaultInboxSiblingPath();

    vm.expectRevert(Errors.OxidePortal__Uninitialized.selector);
    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, path, proof, sig
    );
  }

  function test_revertsWhenPortalIsNotFrozen() external givenPortalIsInitialized {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = "";
    bytes32[] memory path = _defaultInboxSiblingPath();

    vm.expectRevert(Errors.OxidePortal__NotFrozen.selector);
    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, path, proof, sig
    );
  }

  function test_revertsWhenGivenZeroNullifier() external givenPortalIsInitialized givenPortalIsFrozen {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    bytes memory sig = "";
    bytes32[] memory path = _defaultInboxSiblingPath();

    vm.expectRevert(Errors.OxidePortal__ZeroRefundNullifier.selector);
    _refundUnprocessedDeposit(p, bytes32(0), DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, path, proof, sig);
  }

  function test_revertsOnDoubleSpend()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unprocessed-replay")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";

    (, bytes32[] memory inboxSiblingPath) = _primeInbox(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX);
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
    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, inboxSiblingPath, proof, sig
    );

    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__RefundNullifierAlreadySpent.selector, DEFAULT_SILOED_NULLIFIER)
    );
    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, inboxSiblingPath, proof, sig
    );
  }

  function test_revertsWhenAmountExceedsTxLimit()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unprocessed-over-cap")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.amount = OxideConstants.TX_AMOUNT_CAP + 1;
    bytes32[] memory path = _defaultInboxSiblingPath();
    bytes memory sig = _signTee(
      teePk,
      _unprocessedDepositRefundFinalDigest(
        p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, DEFAULT_SILOED_NULLIFIER
      )
    );

    vm.expectRevert(Errors.Caps__TxLimitSurpassed.selector);
    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, path, hex"c0ffee", sig
    );
  }

  function test_revertsOnDoubleSpendViaFrozenDepositPath()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unprocessed-cross-path-replay")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";

    underlying.mint(address(portal), p.amount);
    bytes32[] memory frozenDepositPublicInputs =
      _frozenDepositRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, DEFAULT_SILOED_NULLIFIER);
    frozenDepositRefundVerifier.setExpected(proof, frozenDepositPublicInputs);
    bytes memory frozenDepositSig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));
    _refundFrozenDeposit(p, DEFAULT_SILOED_NULLIFIER, proof, frozenDepositSig);
    assertTrue(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));

    (, bytes32[] memory inboxSiblingPath) = _primeInbox(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX);
    bytes memory sig = _signTee(
      teePk,
      _unprocessedDepositRefundFinalDigest(
        p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, DEFAULT_SILOED_NULLIFIER
      )
    );

    vm.expectRevert(
      abi.encodeWithSelector(Errors.OxidePortal__RefundNullifierAlreadySpent.selector, DEFAULT_SILOED_NULLIFIER)
    );
    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, inboxSiblingPath, proof, sig
    );
  }

  function test_revertsOnSignatureFromUnregisteredTEE() external givenPortalIsInitialized givenPortalIsFrozen {
    (, uint256 unregisteredPk) = makeAddrAndKey("tee-unprocessed-unregistered");
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    (, bytes32[] memory inboxSiblingPath) = _primeInbox(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX);
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
    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, inboxSiblingPath, proof, sig
    );
  }

  function test_cannotReplayAuthSignatureFromFrozenDepositPath()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unprocessed-wrong-domain")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";
    (, bytes32[] memory inboxSiblingPath) = _primeInbox(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX);
    bytes32[] memory publicInputs = _unprocessedDepositRefundPublicInputs(
      p.executor,
      p.userPayloadHash,
      p.amount,
      DEFAULT_MESSAGE_HASH,
      DEFAULT_MESSAGE_LEAF_INDEX,
      DEFAULT_SILOED_NULLIFIER
    );
    unprocessedDepositRefundVerifier.setExpected(proof, publicInputs);

    bytes memory wrongDomainSig = _signTee(teePk, _frozenDepositRefundFinalDigest(p, DEFAULT_SILOED_NULLIFIER));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _refundUnprocessedDeposit(
      p,
      DEFAULT_SILOED_NULLIFIER,
      DEFAULT_MESSAGE_HASH,
      DEFAULT_MESSAGE_LEAF_INDEX,
      inboxSiblingPath,
      proof,
      wrongDomainSig
    );
  }

  function test_revertsWhenInboxSiblingPathIsWrong()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unprocessed-bad-path")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    (, bytes32[] memory inboxSiblingPath) = _primeInbox(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX);
    inboxSiblingPath[0] = bytes32(uint256(1));

    _expectInboxRejects(p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, inboxSiblingPath);
  }

  function test_revertsWhenMessageIsNotInInbox()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unprocessed-no-message")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    (, bytes32[] memory inboxSiblingPath) = _primeInbox(bytes32(uint256(0xDEAD)), DEFAULT_MESSAGE_LEAF_INDEX);

    _expectInboxRejects(p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, inboxSiblingPath);
  }

  function test_revertsWhenLeafIndexPointsAtAnotherCheckpoint()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unprocessed-other-checkpoint")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    (, bytes32[] memory inboxSiblingPath) = _primeInbox(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX);
    _primeInbox(bytes32(uint256(0xDEAD)), DEFAULT_MESSAGE_LEAF_INDEX + SUBTREE_SIZE);

    _expectInboxRejects(p, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX + SUBTREE_SIZE, inboxSiblingPath);
  }

  function test_refundUnprocessedDepositHappyPath()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unprocessed")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes memory proof = hex"c0ffee";

    (, bytes32[] memory inboxSiblingPath) = _primeInbox(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX);

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

    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, inboxSiblingPath, proof, sig
    );

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isRefundNullifierSpent(DEFAULT_SILOED_NULLIFIER));
  }

  function test_GivenProcessorTip_WhenRefundUnprocessedDepositIsCalled_ThenCallerReceivesTip()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unprocessed-tip")
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.processorTip = 7;
    _syncPayloadHash(p);
    bytes memory proof = hex"c0ffee";
    (, bytes32[] memory inboxSiblingPath) = _primeInbox(DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX);
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

    _refundUnprocessedDeposit(
      p, DEFAULT_SILOED_NULLIFIER, DEFAULT_MESSAGE_HASH, DEFAULT_MESSAGE_LEAF_INDEX, inboxSiblingPath, proof, sig
    );

    assertEq(underlying.balanceOf(p.recipient), recipientBalanceBefore + p.amount - p.processorTip);
    assertEq(underlying.balanceOf(p.tipRecipient), tipRecipientBalanceBefore + p.processorTip);
  }

  function _expectInboxRejects(
    WithdrawParams memory p,
    bytes32 messageHash,
    uint256 messageLeafIndex,
    bytes32[] memory inboxSiblingPath
  ) internal {
    bytes memory proof = hex"c0ffee";
    unprocessedDepositRefundVerifier.setExpected(
      proof,
      _unprocessedDepositRefundPublicInputs(
        p.executor, p.userPayloadHash, p.amount, messageHash, messageLeafIndex, DEFAULT_SILOED_NULLIFIER
      )
    );
    underlying.mint(address(portal), p.amount);
    bytes memory sig =
      _signTee(teePk, _unprocessedDepositRefundFinalDigest(p, messageHash, messageLeafIndex, DEFAULT_SILOED_NULLIFIER));

    vm.expectPartialRevert(AztecErrors.MerkleLib__InvalidRoot.selector);
    _refundUnprocessedDeposit(p, DEFAULT_SILOED_NULLIFIER, messageHash, messageLeafIndex, inboxSiblingPath, proof, sig);
  }
}
