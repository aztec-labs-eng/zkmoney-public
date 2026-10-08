// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {AcrossBridgeEscrow} from "@periphery/bridge_on_withdraw_feature/AcrossBridgeEscrow.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {IAcrossSpokePool} from "@periphery/interfaces/IAcrossSpokePool.sol";
import {MockAcrossSpokePool} from "./MockAcrossSpokePool.sol";
import {AcrossBridgeEscrowTestBase} from "./AcrossBridgeEscrowTestBase.sol";

contract AcrossBridgeEscrowTest is AcrossBridgeEscrowTestBase {
  uint256 internal constant USDT_MIN_OUT = 2_450_250_000;
  uint256 internal constant USDT_MIN_OUT_RATE = 99e4;
  uint8 internal constant BNB_USDT_DECIMALS = 18;
  uint256 internal constant REFUND = 1000e6;

  bytes32 internal constant RECOVERY_NONCE = keccak256("recovery-nonce");
  address internal target = makeAddr("recovery-target");
  address internal arbitrumUsdc = makeAddr("arbitrum-usdc");
  uint256 internal deadline;

  function setUp() public override {
    super.setUp();
    deadline = block.timestamp + 1 days;
  }

  function test_DepositsSwappedUsdtToRecipientAfterAcrossFee() external {
    address escrow = _fundAndDeploy(_args(), AMOUNT);

    MockAcrossSpokePool.Deposit memory deposit = spokePool.lastDeposit();
    assertEq(deposit.sender, escrow);
    assertEq(deposit.depositor, escrow);
    assertEq(deposit.recipient, alice);
    assertEq(deposit.inputToken, address(usdt));
    assertEq(deposit.outputToken, arbitrumUsdt);
    assertEq(deposit.inputAmount, SWAPPED_AMOUNT);
    assertEq(deposit.outputAmount, SWAPPED_AMOUNT - ACROSS_FEE);
    assertEq(deposit.destinationChainId, ARBITRUM_CHAIN_ID);
    assertEq(deposit.exclusiveRelayer, address(0));
    assertEq(deposit.fillDeadlineOffset, implementation.FILL_DEADLINE_OFFSET());
    assertEq(deposit.exclusivityParameter, 0);
    assertEq(deposit.message, "");
    assertEq(usdt.balanceOf(address(spokePool)), SWAPPED_AMOUNT);
    assertEq(usdt.balanceOf(escrow), 0);
    assertEq(dai.balanceOf(escrow), 0);
    assertEq(dai.balanceOf(relayer), TIP);
  }

  function test_UsdcAcrossInputSwapsDaiToUsdcAndDepositsIt() external {
    AcrossBridgeEscrow.Args memory args = _args();
    args.acrossInputToken = address(usdc);
    args.acrossOutputToken = arbitrumUsdc;
    address escrow = _fundAndDeploy(args, AMOUNT);

    MockAcrossSpokePool.Deposit memory deposit = spokePool.lastDeposit();
    assertEq(deposit.inputToken, address(usdc));
    assertEq(deposit.outputToken, arbitrumUsdc);
    assertEq(deposit.inputAmount, SWAPPED_AMOUNT);
    assertEq(deposit.outputAmount, SWAPPED_AMOUNT - ACROSS_FEE);
    assertEq(usdc.balanceOf(address(spokePool)), SWAPPED_AMOUNT);
    assertEq(usdc.balanceOf(escrow), 0);
  }

  function test_UnsupportedAcrossInputTokenRevertsAndLeavesFundsInPlace() external {
    AcrossBridgeEscrow.Args memory args = _args();
    args.acrossInputToken = address(dai);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(
      abi.encodeWithSelector(AcrossBridgeEscrow.AcrossBridgeEscrow__UnsupportedAcrossInputToken.selector, address(dai))
    );
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(spokePool.depositCount(), 0);
  }

  function test_OutputAmountScalesToDestinationTokenDecimals() external {
    AcrossBridgeEscrow.Args memory args = _args();
    args.acrossOutputTokenDecimals = BNB_USDT_DECIMALS;
    _fundAndDeploy(args, AMOUNT);

    MockAcrossSpokePool.Deposit memory deposit = spokePool.lastDeposit();
    assertEq(deposit.inputAmount, SWAPPED_AMOUNT);
    assertEq(
      deposit.outputAmount,
      (SWAPPED_AMOUNT - ACROSS_FEE) * 10 ** (BNB_USDT_DECIMALS - implementation.ACROSS_INPUT_TOKEN_DECIMALS())
    );
  }

  function test_AcrossOutputDecimalsBelowInputRevertsAndLeavesFundsInPlace() external {
    uint8 belowInputDecimals = implementation.ACROSS_INPUT_TOKEN_DECIMALS() - 1;
    AcrossBridgeEscrow.Args memory args = _args();
    args.acrossOutputTokenDecimals = belowInputDecimals;
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(
      abi.encodeWithSelector(
        AcrossBridgeEscrow.AcrossBridgeEscrow__AcrossOutputDecimalsBelowInput.selector, belowInputDecimals
      )
    );
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(spokePool.depositCount(), 0);
  }

  function test_ZeroRecipientRevertsAndLeavesFundsInPlace() external {
    AcrossBridgeEscrow.Args memory args = _args();
    args.recipient = address(0);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(AcrossBridgeEscrow.AcrossBridgeEscrow__ZeroRecipient.selector);
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(spokePool.depositCount(), 0);
  }

  function test_UsdtOutputExactlyAtMinOutDeposits() external {
    threePool.setRate(address(usdt), USDT_MIN_OUT_RATE);
    _fundAndDeploy(_args(), AMOUNT);

    assertEq(spokePool.lastDeposit().inputAmount, USDT_MIN_OUT);
    assertEq(dai.balanceOf(relayer), TIP);
  }

  function test_UsdtOutputOneUnitBelowMinOutRevertsAndLeavesFundsInPlace() external {
    threePool.setRate(address(usdt), USDT_MIN_OUT_RATE - 1);
    AcrossBridgeEscrow.Args memory args = _args();
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert("Exchange resulted in fewer coins than expected");
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(spokePool.depositCount(), 0);
  }

  function test_UsdtOneUnitAboveAcrossFeeDepositsOneUnit() external {
    AcrossBridgeEscrow.Args memory args = _args();
    args.acrossFee = SWAPPED_AMOUNT - 1;
    _fundAndDeploy(args, AMOUNT);

    assertEq(spokePool.lastDeposit().inputAmount, SWAPPED_AMOUNT);
    assertEq(spokePool.lastDeposit().outputAmount, 1);
    assertEq(dai.balanceOf(relayer), TIP);
  }

  function test_UsdtExactlyAtAcrossFeeRevertsAndLeavesFundsInPlace() external {
    AcrossBridgeEscrow.Args memory args = _args();
    args.acrossFee = SWAPPED_AMOUNT;
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(
      abi.encodeWithSelector(
        AcrossBridgeEscrow.AcrossBridgeEscrow__AmountNotAboveAcrossFee.selector, SWAPPED_AMOUNT, SWAPPED_AMOUNT
      )
    );
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(spokePool.depositCount(), 0);
  }

  function test_BalanceExactlyTipDeployIsNoOp() external {
    AcrossBridgeEscrow.Args memory args = _args();
    address escrow = _fundAndDeploy(args, TIP);

    assertEq(escrow, factory.predictEscrowAddress(args));
    assertEq(escrow.code.length, 0);
    assertEq(threePool.callCount(), 0);
    assertEq(spokePool.depositCount(), 0);
    assertEq(dai.balanceOf(relayer), 0);
    assertEq(dai.balanceOf(escrow), TIP);
  }

  function test_BalanceOneWeiAboveTipSwapsAndRevertsBelowAcrossFee() external {
    AcrossBridgeEscrow.Args memory args = _args();
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, TIP + 1);

    vm.prank(relayer);
    vm.expectRevert(
      abi.encodeWithSelector(AcrossBridgeEscrow.AcrossBridgeEscrow__AmountNotAboveAcrossFee.selector, 0, ACROSS_FEE)
    );
    factory.deployAndExecute(args);

    assertEq(escrow.code.length, 0);
    assertEq(dai.balanceOf(escrow), TIP + 1);
    assertEq(spokePool.depositCount(), 0);
  }

  function test_ReexecuteDoesNotDepositARefundLeftAtTheEscrow() external {
    AcrossBridgeEscrow.Args memory args = _args();
    address escrow = _fundAndDeploy(args, AMOUNT);
    usdt.mint(escrow, REFUND);
    dai.mint(escrow, TIP + 1);

    vm.prank(relayer);
    vm.expectRevert(
      abi.encodeWithSelector(AcrossBridgeEscrow.AcrossBridgeEscrow__AmountNotAboveAcrossFee.selector, 0, ACROSS_FEE)
    );
    factory.deployAndExecute(args);

    assertEq(usdt.balanceOf(escrow), REFUND);
    assertEq(spokePool.depositCount(), 1);
  }

  function test_DepositFailureThenSignedRecoveryMovesFullBalance() external {
    vm.mockCallRevert(
      address(spokePool), abi.encodeWithSelector(IAcrossSpokePool.depositV3Now.selector), "deposit failed"
    );
    AcrossBridgeEscrow.Args memory args = _args();
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(bytes("deposit failed"));
    factory.deployAndExecute(args);
    assertEq(escrow.code.length, 0);

    vm.prank(makeAddr("anyone"));
    assertEq(factory.deploy(args), escrow);

    bytes memory signature = _signRecoverERC20(escrow, target, address(dai), RECOVERY_NONCE, deadline);
    vm.expectEmit(true, true, true, true, escrow);
    emit EscrowBase.EscrowRecovered(address(dai), target, AMOUNT);
    vm.prank(makeAddr("anyone"));
    AcrossBridgeEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(dai), RECOVERY_NONCE, deadline);

    assertEq(dai.balanceOf(target), AMOUNT);
    assertEq(dai.balanceOf(escrow), 0);
  }
}
