// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxidePortal} from "@core/OxidePortal.sol";
import {Caps} from "@core/Caps.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@core/lib/Errors.sol";

contract RevertingWithdrawalExecutor {
  function execute(uint256, bytes calldata, bytes calldata) external pure {
    revert("executor reverted");
  }
}

contract OxidePortalWithdrawTest is OxidePortalBase {
  function testPayloadHashVectors() external pure {
    assertEq(Hash.sha256ToField(hex"deadbeef"), 0x005f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa8139);
    bytes memory userPayload = abi.encode(address(0x11223344556677889900aABbCcdDEeFF00112233), 75_317_531);
    assertEq(
      userPayload,
      hex"00000000000000000000000011223344556677889900aabbccddeeff0011223300000000000000000000000000000000000000000000000000000000047d411b"
    );
    assertEq(Hash.sha256ToField(userPayload), 0x00ce6a41ff263e87fd9e2bb589e3708df5b40098af39741e2a6f92cedc4610b6);
    assertEq(
      Hash.sha256ToField(
        abi.encodeWithSignature(
          "withdraw(address,bytes32,uint256,uint256,uint256)",
          address(0x11223344556677889900aABbCcdDEeFF00112233),
          0x005f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa8139,
          1_234_567_890,
          75_317_531,
          0x2222333344445555666677778888999900001111aaaabbbbccccddddeeeeffff
        )
      ),
      0x0040e5e411ba5f4a9730607ebac66817a44df07a56cfc8df8a42d497e9bb5e9b
    );
  }

  function test_GivenPortalIsUninitialized_WhenWithdrawIsCalled() external {
    bytes32[] memory path = new bytes32[](0);

    vm.expectRevert(Errors.OxidePortal__Uninitialized.selector);
    portal.withdraw(
      IOxidePortal.WithdrawArgs({
        content: IOxidePortal.WithdrawContent({
          executor: address(plainWithdrawalExecutor),
          userPayloadHash: 0x00933e6c511ad85168d59c39a333286a8fec3f69d5448bb2ba1d3582c9e39f30,
          amount: 1 ether,
          proverTip: 0,
          randomness: 0
        }),
        userPayload: abi.encode(USER, 0),
        relayerPayload: abi.encode(address(0), address(0)),
        epochNumber: 0,
        numCheckpointsInEpoch: 1,
        leafIndex: 0,
        path: path,
        checkpointNumber: 0,
        withdrawalId: bytes32(0),
        teeSignature: ""
      })
    );
  }

  function test_GivenValidWithdrawal_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-happy")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectEmit(true, true, true, true, address(portal));
    emit WithdrawalOrRefund(IExecutor.Flow.Withdrawal, p.withdrawalId, p.executor, p.amount);

    _withdraw(p, path, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertEq(underlying.balanceOf(address(portal)), 0);
    assertTrue(portal.$isWithdrawalSpent(p.withdrawalId));

    assertEq(outbox.callCount(), 1);
    (
      bytes32 senderActor,
      uint256 senderVersion,
      address recipientActor,
      uint256 recipientChainId,
      bytes32 content,
      uint256 epoch,
      uint256 numCheckpointsInEpoch,
      uint256 calledLeafIndex,
      uint256 pathLength
    ) = outbox.calls(0);
    assertEq(senderActor, L2_PORTAL);
    assertEq(senderVersion, ROLLUP_VERSION);
    assertEq(recipientActor, address(portal));
    assertEq(recipientChainId, block.chainid);
    assertEq(content, _contentHash(p));
    assertEq(epoch, p.epochNumber);
    assertEq(numCheckpointsInEpoch, 1);
    assertEq(calledLeafIndex, p.leafIndex);
    assertEq(pathLength, path.length);
  }

  function test_GivenWithdrawalDigestIsAlreadySpent_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-replay")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount * 2);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    _withdraw(p, path, sig);

    vm.expectRevert(Errors.OxidePortal__WithdrawalAlreadyClaimed.selector);
    _withdraw(p, path, sig);
  }

  function test_GivenSignerIsUnregistered_WhenWithdrawIsCalled() external givenPortalIsInitialized {
    (, uint256 unregisteredPk) = makeAddrAndKey("tee-unreg");
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(unregisteredPk, _finalDigest(p));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _withdraw(p, path, sig);
  }

  function test_GivenZeroExecutor_WhenWithdrawIsCalled() external givenPortalIsInitialized {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.executor = address(0);

    vm.expectRevert(Errors.OxidePortal__InvalidWithdrawalExecutor.selector);
    _withdraw(p, _dummyPath(), "");
  }

  function test_GivenCodelessExecutor_WhenWithdrawIsCalled() external givenPortalIsInitialized {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.executor = USER;

    vm.expectRevert(Errors.OxidePortal__InvalidWithdrawalExecutor.selector);
    _withdraw(p, _dummyPath(), "");
  }

  function test_GivenPayloadHashDoesNotMatch_WhenWithdrawIsCalled() external givenPortalIsInitialized {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.userPayloadHash = bytes32(uint256(1));

    vm.expectRevert(Errors.OxidePortal__InvalidUserPayload.selector);
    _withdraw(p, _dummyPath(), "");
  }

  function test_GivenProverTipExceedsAmount_WhenWithdrawIsCalled() external givenPortalIsInitialized {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.proverTip = p.amount + 1;

    vm.expectRevert(Errors.OxidePortal__ProverTipExceedsAmount.selector);
    _withdraw(p, _dummyPath(), "");
  }

  function test_GivenExecutorReverts_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-executor-revert")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.executor = address(new RevertingWithdrawalExecutor());
    p.userPayloadHash = Hash.sha256ToField(_userPayload(p));
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert();
    _withdraw(p, _dummyPath(), sig);

    assertFalse(portal.$isWithdrawalSpent(p.withdrawalId));
    assertEq(outbox.callCount(), 0);
  }

  function test_GivenRecipientWasTampered_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-tamper-recipient")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _finalDigest(p));
    bytes32 userPayloadHash = Hash.sha256ToField(abi.encode(address(0xBEEF), p.processorTip));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    portal.withdraw(
      IOxidePortal.WithdrawArgs({
        content: IOxidePortal.WithdrawContent({
          executor: p.executor,
          userPayloadHash: userPayloadHash,
          amount: p.amount,
          proverTip: p.proverTip,
          randomness: p.randomness
        }),
        userPayload: abi.encode(address(0xBEEF), p.processorTip),
        relayerPayload: abi.encode(address(this), address(0)),
        epochNumber: p.epochNumber,
        numCheckpointsInEpoch: 1,
        leafIndex: p.leafIndex,
        path: path,
        checkpointNumber: p.checkpointNumber,
        withdrawalId: p.withdrawalId,
        teeSignature: sig
      })
    );
  }

  function test_GivenAmountWasTampered_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-tamper-amount")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    portal.withdraw(
      IOxidePortal.WithdrawArgs({
        content: IOxidePortal.WithdrawContent({
          executor: p.executor,
          userPayloadHash: p.userPayloadHash,
          amount: p.amount + 1,
          proverTip: p.proverTip,
          randomness: p.randomness
        }),
        userPayload: _userPayload(p),
        relayerPayload: _relayerPayload(address(this), address(0)),
        epochNumber: p.epochNumber,
        numCheckpointsInEpoch: 1,
        leafIndex: p.leafIndex,
        path: path,
        checkpointNumber: p.checkpointNumber,
        withdrawalId: p.withdrawalId,
        teeSignature: sig
      })
    );
  }

  function test_GivenAmountExceedsTxLimit_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-over-cap")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.amount = OxideConstants.TX_AMOUNT_CAP + 1;
    bytes32[] memory path = _dummyPath();
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(Errors.Caps__TxLimitSurpassed.selector);
    _withdraw(p, path, sig);
  }

  function test_GivenWithdrawalDigestWasTampered_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-tamper-digest")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    portal.withdraw(
      IOxidePortal.WithdrawArgs({
        content: IOxidePortal.WithdrawContent({
          executor: p.executor,
          userPayloadHash: p.userPayloadHash,
          amount: p.amount,
          proverTip: p.proverTip,
          randomness: p.randomness
        }),
        userPayload: _userPayload(p),
        relayerPayload: _relayerPayload(address(this), address(0)),
        epochNumber: p.epochNumber,
        numCheckpointsInEpoch: 1,
        leafIndex: p.leafIndex,
        path: path,
        checkpointNumber: p.checkpointNumber,
        withdrawalId: bytes32(uint256(0xFEEDFACE)),
        teeSignature: sig
      })
    );
  }

  function test_GivenCheckpointNumberWasTampered_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-tamper-anchor")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    uint256 tamperedCheckpointNumber = p.checkpointNumber + 1;
    rollup.setArchive(tamperedCheckpointNumber, bytes32(uint256(0xDECAFBAD)));
    rollup.setProvenCheckpointNumber(tamperedCheckpointNumber);

    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(Errors.OxidePortal__UnregisteredTEE.selector);
    _withdrawWithCheckpoint(p, path, tamperedCheckpointNumber, sig);
  }

  function test_GivenCheckpointIsUnknown_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unknown-checkpoint")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(Errors.OxidePortal__UnknownCheckpoint.selector);
    _withdrawWithCheckpoint(p, path, p.checkpointNumber + 100, sig);
  }

  function test_GivenCheckpointIsUnproven_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-unproven-checkpoint")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    uint256 unprovenCheckpointNumber = rollup.getProvenCheckpointNumber() + 1;
    rollup.setArchive(unprovenCheckpointNumber, p.archiveRoot);

    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectRevert(Errors.OxidePortal__UnprovenCheckpoint.selector);
    _withdrawWithCheckpoint(p, path, unprovenCheckpointNumber, sig);
  }

  function test_GivenOutboxReverts_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-outbox-revert")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    bytes memory sig = _signTee(teePk, _finalDigest(p));
    bytes memory customErr = abi.encodeWithSignature("OutboxReverted()");
    outbox.primeRevert(customErr);

    vm.expectRevert(customErr);
    _withdraw(p, path, sig);
  }

  function test_GivenPortalIsFrozenAndEpochAfterFreeze_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenPortalIsFrozen
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory path = _dummyPath();

    vm.expectRevert(Errors.OxidePortal__EpochPastFreeze.selector);
    _withdraw(p, path, "");
  }

  function test_GivenPortalIsFrozenAndEpochBeforeFreeze_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-frozen-earlier-epoch")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 1;
    _setCheckpoint(2);
    _freezeAsOwner();

    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    _withdraw(p, path, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertTrue(portal.$isWithdrawalSpent(p.withdrawalId));
    assertEq(outbox.callCount(), 1);
    (,,,,, uint256 epoch,,,) = outbox.calls(0);
    assertEq(epoch, p.epochNumber);
  }
}

contract OxidePortalWithdrawFpcCutTest is OxidePortalBase {
  uint256 internal constant CUT = 10e16;

  function setUp() public override {
    fpcFundingCut = CUT;
    super.setUp();
  }

  function test_GivenValidWithdrawal_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-cut-happy")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectEmit(true, true, true, true, address(portal));
    emit WithdrawalOrRefund(IExecutor.Flow.Withdrawal, p.withdrawalId, p.executor, p.amount - CUT);

    _withdraw(p, path, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount - CUT);
    assertEq(underlying.balanceOf(FPC_FUNDER), CUT);
    assertEq(underlying.balanceOf(address(portal)), 0);
  }

  function test_GivenProverTip_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-cut-tip")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.proverTip = 2 ether;
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    _withdraw(p, path, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount - p.proverTip - CUT);
    assertEq(underlying.balanceOf(FPC_FUNDER), CUT);
    assertEq(underlying.balanceOf(address(portal)), p.proverTip);
  }

  function test_GivenNetBelowCut_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-cut-dust")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.amount = CUT / 2;
    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    vm.expectEmit(true, true, true, true, address(portal));
    emit WithdrawalOrRefund(IExecutor.Flow.Withdrawal, p.withdrawalId, p.executor, 0);

    _withdraw(p, path, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore);
    assertEq(underlying.balanceOf(FPC_FUNDER), p.amount);
    assertTrue(portal.$isWithdrawalSpent(p.withdrawalId));
  }

  function test_GivenPortalIsFrozen_WhenWithdrawIsCalled()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("tee-cut-frozen")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    p.epochNumber = 1;
    _setCheckpoint(2);
    _freezeAsOwner();

    bytes32[] memory path = _dummyPath();
    underlying.mint(address(portal), p.amount);
    uint256 userBalanceBefore = underlying.balanceOf(p.recipient);
    bytes memory sig = _signTee(teePk, _finalDigest(p));

    _withdraw(p, path, sig);

    assertEq(underlying.balanceOf(p.recipient), userBalanceBefore + p.amount);
    assertEq(underlying.balanceOf(FPC_FUNDER), 0);
  }
}
