// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Errors} from "@periphery/Errors.sol";
import {MultiStepExecutor} from "@periphery/MultiStepExecutor.sol";
import {RecoveryAuthLib} from "@periphery/RecoveryAuthLib.sol";
import {MockCallTarget} from "@test/mocks/MockCallTarget.sol";
import {MultiStepExecutorTestBase} from "@test/periphery/MultiStepExecutorTestBase.sol";

contract MultiStepExecutorTest is MultiStepExecutorTestBase {
  uint256 internal constant PROVER_TIP = 100e18;
  uint256 internal constant FIXED = 100e18;

  address internal recoveryRecipient = makeAddr("recovery-recipient");
  uint256 internal deadline;

  function setUp() public override {
    super.setUp();
    deadline = block.timestamp + 1 days;
  }

  function test_PlainTransferPaysTheRestTheTipAndTheFee() external {
    _relay(_plainPayload(alice), AMOUNT);

    assertEq(dai.balanceOf(alice), NET);
    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(dai.balanceOf(feeBeneficiary), FEE);
    assertEq(dai.balanceOf(address(portal)), 0);
    _assertNothingSticks();
  }

  function test_AFixedTransferAndTheRemainderRecipientSplitTheRest() external {
    _relay(_transfersPayload(_transfers(FIXED, bob), alice), AMOUNT);

    assertEq(dai.balanceOf(bob), FIXED);
    assertEq(dai.balanceOf(alice), NET - FIXED);
    _assertNothingSticks();
  }

  function test_AZeroRecipientReverts() external {
    _assertRelayReverts(
      _transfersPayload(_noTransfers(), address(0)),
      AMOUNT,
      abi.encodeWithSelector(Errors.MultiStepExecutor__ZeroRemainderRecipient.selector)
    );
    _assertRelayReverts(
      _transfersPayload(_transfers(FIXED, address(0)), alice),
      AMOUNT,
      abi.encodeWithSelector(Errors.MultiStepExecutor__ZeroTransferRecipient.selector)
    );
  }

  function test_StepsRunInOrderAfterTheTransfers() external {
    MockCallTarget second = new MockCallTarget();

    _relay(
      _stepsPayload(
        _steps(_recordStep(callTarget, 1, dai), _recordStep(second, 2, dai), _recordStep(callTarget, 3, dai))
      ),
      AMOUNT
    );

    assertEq(callTarget.recordCount(), 2);
    assertEq(second.recordCount(), 1);
    MockCallTarget.Record memory first = callTarget.recordAt(0);
    assertEq(first.id, 1);
    assertEq(first.caller, address(executor));
    assertEq(first.balance, NET);
    assertEq(second.recordAt(0).id, 2);
    assertEq(second.recordAt(0).caller, address(executor));
    assertEq(callTarget.recordAt(1).id, 3);
    assertEq(callTarget.recordAt(1).balance, NET);
  }

  function test_AFailingStepBubblesItsExactRevertData() external {
    _assertRelayReverts(
      _stepsPayload(_steps(_recordStep(callTarget, 1, dai), _revertStep(_customRevert()))), AMOUNT, _customRevert()
    );
    assertEq(callTarget.recordCount(), 0);
    assertEq(dai.balanceOf(relayer), 0);
  }

  function test_SelfRelayWithoutATipPaysEverythingAfterTheFee() external {
    MultiStepExecutor.UserPayload memory userPayload = _plainPayload(alice);
    userPayload.relayerTip = 0;
    IOxidePortal.WithdrawArgs memory args =
      _withdrawArgs(AMOUNT, 0, abi.encode(userPayload), abi.encodePacked(address(0)));

    vm.prank(alice);
    portal.withdraw(args);

    assertEq(dai.balanceOf(alice), AMOUNT - FEE);
    _assertNothingSticks();
  }

  function test_RelayerPayloadWithWrongLengthReverts() external {
    bytes[3] memory relayerPayloads = [bytes(""), abi.encode(relayer), bytes.concat(abi.encodePacked(relayer), hex"00")];
    for (uint256 i = 0; i < relayerPayloads.length; i++) {
      _assertRelayReverts(
        _withdrawArgs(AMOUNT, 0, abi.encode(_plainPayload(alice)), relayerPayloads[i]),
        abi.encodeWithSelector(Errors.MultiStepExecutor__InvalidRelayerPayload.selector)
      );
    }
  }

  function test_ExecuteRunsTheRouteForEveryFlow() external {
    MultiStepExecutor.UserPayload memory userPayload =
      _payload(TIP, _commitment(), alice, _transfers(FIXED, bob), _steps(_recordStep(callTarget, 9, dai)));
    uint256 flowCount = uint256(type(IExecutor.Flow).max) + 1;
    for (uint256 flow = 0; flow < flowCount; flow++) {
      dai.mint(address(executor), AMOUNT);
      vm.prank(address(portal));
      executor.execute(IExecutor.Flow(flow), AMOUNT, abi.encode(userPayload), abi.encodePacked(relayer));
    }

    assertEq(dai.balanceOf(bob), flowCount * FIXED);
    assertEq(dai.balanceOf(alice), (NET - FIXED) + (flowCount - 1) * (AMOUNT - TIP - FIXED));
    assertEq(dai.balanceOf(relayer), flowCount * TIP);
    assertEq(callTarget.recordCount(), flowCount);
    _assertNothingSticks();
  }

  function test_AStepCallingThePortalWithdrawRevertsOnTheReentrancyGuard() external {
    IOxidePortal.WithdrawArgs memory inner = _relayArgs(_plainPayload(bob), AMOUNT);
    IOxidePortal.WithdrawArgs memory outer = _relayArgs(
      _stepsPayload(
        _steps(MultiStepExecutor.Step({target: address(portal), data: abi.encodeCall(IOxidePortal.withdraw, (inner))}))
      ),
      AMOUNT
    );

    _assertRelayReverts(outer, abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector));
    assertFalse(portal.$isWithdrawalSpent(inner.withdrawalId));
  }

  function test_AStepCallingRecoverRevertsOnTheReentrancyGuard() external {
    IOxidePortal.WithdrawArgs memory inner = _relayArgs(_plainPayload(bob), AMOUNT);
    bytes memory signature = _signWithPasskey(_recoveryDigest(inner.withdrawalId, recoveryRecipient, deadline));
    bytes memory recoverData = abi.encodeCall(
      MultiStepExecutor.recover,
      (inner, RECOVERY_SALT, address(recoveryAccount), signature, recoveryRecipient, deadline)
    );
    IOxidePortal.WithdrawArgs memory outer =
      _relayArgs(_stepsPayload(_steps(MultiStepExecutor.Step({target: address(executor), data: recoverData}))), AMOUNT);

    _assertRelayReverts(outer, abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector));
    assertFalse(portal.$isWithdrawalSpent(inner.withdrawalId));
    assertEq(dai.balanceOf(recoveryRecipient), 0);
  }

  function test_AStepCallingExecuteRevertsAsUnauthorized() external {
    bytes memory executeData = abi.encodeCall(
      IExecutor.execute, (IExecutor.Flow.Withdrawal, NET, abi.encode(_plainPayload(bob)), abi.encodePacked(relayer))
    );

    _assertRelayReverts(
      _stepsPayload(_steps(MultiStepExecutor.Step({target: address(executor), data: executeData}))),
      AMOUNT,
      abi.encodeWithSelector(Errors.FeeChargingExecutorBase__UnauthorizedCaller.selector)
    );
  }

  function test_RecoverPaysTheDaiAfterTheFeeToTheRecipientAndSkipsTheRoute() external {
    IOxidePortal.WithdrawArgs memory args = _relayArgs(
      _payload(
        TIP,
        _commitment(),
        alice,
        _transfers(FIXED, bob),
        _steps(_recordStep(callTarget, 1, dai), _revertStep(_customRevert()))
      ),
      AMOUNT
    );
    _assertRelayReverts(args, _customRevert());

    bytes memory signature = _signWithPasskey(_recoveryDigest(args.withdrawalId, recoveryRecipient, deadline));
    vm.expectEmit(true, true, true, true, address(executor));
    emit MultiStepExecutor.Recovered(args.withdrawalId, recoveryRecipient, AMOUNT - FEE);
    vm.prank(makeAddr("anyone"));
    executor.recover(args, RECOVERY_SALT, address(recoveryAccount), signature, recoveryRecipient, deadline);

    assertEq(dai.balanceOf(recoveryRecipient), AMOUNT - FEE);
    assertEq(dai.balanceOf(feeBeneficiary), FEE);
    assertEq(dai.balanceOf(relayer), 0);
    assertEq(dai.balanceOf(bob), 0);
    assertEq(dai.balanceOf(alice), 0);
    assertEq(callTarget.recordCount(), 0);
    assertTrue(portal.$isWithdrawalSpent(args.withdrawalId));
    _assertNothingSticks();
  }

  function test_RecoverPaysTheAmountLessTheProverTipAndTheFee() external {
    IOxidePortal.WithdrawArgs memory args =
      _withdrawArgs(AMOUNT, PROVER_TIP, abi.encode(_plainPayload(alice)), abi.encodePacked(relayer));
    bytes memory signature = _signWithPasskey(_recoveryDigest(args.withdrawalId, recoveryRecipient, deadline));

    vm.expectEmit(true, true, true, true, address(executor));
    emit MultiStepExecutor.Recovered(args.withdrawalId, recoveryRecipient, AMOUNT - PROVER_TIP - FEE);
    executor.recover(args, RECOVERY_SALT, address(recoveryAccount), signature, recoveryRecipient, deadline);

    assertEq(dai.balanceOf(recoveryRecipient), AMOUNT - PROVER_TIP - FEE);
    assertEq(dai.balanceOf(address(portal)), PROVER_TIP);
    _assertNothingSticks();
  }

  function test_RecoverRevertsForAZeroRecipient() external {
    IOxidePortal.WithdrawArgs memory args = _relayArgs(_plainPayload(alice), AMOUNT);
    bytes memory signature = _signWithPasskey(_recoveryDigest(args.withdrawalId, address(0), deadline));

    vm.expectRevert(Errors.MultiStepExecutor__ZeroRecoveryRecipient.selector);
    executor.recover(args, RECOVERY_SALT, address(recoveryAccount), signature, address(0), deadline);
  }

  function test_RecoverRevertsWhenTheSignatureIsForAnotherRecipientWithdrawalDeadlineOrChain() external {
    IOxidePortal.WithdrawArgs memory args = _relayArgs(_plainPayload(alice), AMOUNT);
    IOxidePortal.WithdrawArgs memory other = _relayArgs(_plainPayload(alice), AMOUNT);
    bytes memory signature = _signWithPasskey(_recoveryDigest(args.withdrawalId, recoveryRecipient, deadline));
    bytes4 invalid = RecoveryAuthLib.RecoveryAuthLib__InvalidSignature.selector;

    vm.expectRevert(invalid);
    executor.recover(args, RECOVERY_SALT, address(recoveryAccount), signature, makeAddr("thief"), deadline);
    vm.expectRevert(invalid);
    executor.recover(other, RECOVERY_SALT, address(recoveryAccount), signature, recoveryRecipient, deadline);
    vm.expectRevert(invalid);
    executor.recover(args, RECOVERY_SALT, address(recoveryAccount), signature, recoveryRecipient, deadline + 1);
    vm.chainId(block.chainid + 1);
    vm.expectRevert(invalid);
    executor.recover(args, RECOVERY_SALT, address(recoveryAccount), signature, recoveryRecipient, deadline);
  }

  function test_RecoverRevertsForAWithdrawalToAnotherExecutor() external {
    IOxidePortal.WithdrawArgs memory args = _withdrawArgsFor(
      portal, address(plainWithdrawalExecutor), AMOUNT, 0, abi.encode(_plainPayload(alice)), abi.encodePacked(relayer)
    );
    bytes memory signature = _signWithPasskey(_recoveryDigest(args.withdrawalId, recoveryRecipient, deadline));

    vm.expectRevert(Errors.MultiStepExecutor__NotThisExecutor.selector);
    executor.recover(args, RECOVERY_SALT, address(recoveryAccount), signature, recoveryRecipient, deadline);
  }

  function test_ARelayAfterARecoverInTheSameTransactionRunsTheRoute() external {
    MultiStepExecutor.UserPayload memory userPayload = _stepsPayload(_steps(_recordStep(callTarget, 1, dai)));
    _recover(_relayArgs(userPayload, AMOUNT), recoveryRecipient, deadline);

    _relay(userPayload, AMOUNT);

    assertEq(dai.balanceOf(recoveryRecipient), AMOUNT - FEE);
    assertEq(callTarget.recordCount(), 1);
    assertEq(callTarget.recordAt(0).id, 1);
    assertEq(callTarget.recordAt(0).balance, NET);
    assertEq(dai.balanceOf(relayer), TIP);
    _assertNothingSticks();
  }

  function _recordStep(MockCallTarget _callTarget, uint256 _id, IERC20 _token)
    internal
    pure
    returns (MultiStepExecutor.Step memory)
  {
    return MultiStepExecutor.Step({
      target: address(_callTarget), data: abi.encodeCall(MockCallTarget.record, (_id, _token))
    });
  }

  function _customRevert() internal pure returns (bytes memory) {
    return abi.encodeWithSignature("Boom(uint256,string)", 7, "adapter failed");
  }

  function _revertStep(bytes memory _revertData) internal view returns (MultiStepExecutor.Step memory) {
    return MultiStepExecutor.Step({
      target: address(callTarget), data: abi.encodeCall(MockCallTarget.revertWith, (_revertData))
    });
  }

  function _recover(IOxidePortal.WithdrawArgs memory _withdrawal, address _recipient, uint256 _deadline) internal {
    bytes memory signature = _signWithPasskey(_recoveryDigest(_withdrawal.withdrawalId, _recipient, _deadline));
    executor.recover(_withdrawal, RECOVERY_SALT, address(recoveryAccount), signature, _recipient, _deadline);
  }
}
