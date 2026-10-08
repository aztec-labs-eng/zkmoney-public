// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {Errors} from "@periphery/Errors.sol";
import {SwapEscrow} from "@periphery/swap_on_withdraw_feature/SwapEscrow.sol";
import {NonPayableRecipient} from "@test/periphery/EscrowRecoveryTestBase.sol";
import {SwapEscrowTestBase} from "./SwapEscrowTestBase.sol";

contract SwapEscrowTest is SwapEscrowTestBase {
  uint256 internal constant SWAPPED = AMOUNT - TIP;
  uint256 internal constant STABLE_MIN_OUT = 2_450_250_000;
  uint256 internal constant ETH_MIN_OUT = 970_200_000_000_000_000;
  uint256 internal constant STABLE_MIN_OUT_RATE = 99e4;

  bytes32 internal constant RECOVERY_NONCE = keccak256("recovery-nonce");
  address internal target = makeAddr("recovery-target");
  uint256 internal deadline;

  function setUp() public override {
    super.setUp();
    deadline = block.timestamp + 1 days;
  }

  function test_UsdcRouteIsOneThreePoolHopPaidToRecipient() external {
    address escrow = _fundAndDeploy(_args(0), AMOUNT);

    assertEq(router.callCount(), 0);
    assertEq(threePool.callCount(), 1);
    assertEq(threePool.lastI(), 0);
    assertEq(threePool.lastJ(), 1);
    assertEq(threePool.lastDx(), SWAPPED);
    assertEq(threePool.lastMinDy(), STABLE_MIN_OUT);
    assertEq(dai.balanceOf(address(threePool)), SWAPPED);
    assertEq(usdc.balanceOf(alice), (SWAPPED * USDC_RATE) / 1e18);
    assertEq(usdc.balanceOf(escrow), 0);
  }

  function test_UsdtRouteIsOneThreePoolHopPaidToRecipient() external {
    address escrow = _fundAndDeploy(_args(1), AMOUNT);

    assertEq(router.callCount(), 0);
    assertEq(threePool.callCount(), 1);
    assertEq(threePool.lastI(), 0);
    assertEq(threePool.lastJ(), 2);
    assertEq(threePool.lastDx(), SWAPPED);
    assertEq(threePool.lastMinDy(), STABLE_MIN_OUT);
    assertEq(usdt.balanceOf(alice), (SWAPPED * USDT_RATE) / 1e18);
    assertEq(usdt.balanceOf(escrow), 0);
  }

  function test_EthRouteSwapsThreePoolUsdcOnV3AndUnwrapsToRecipient() external {
    _fundAndDeploy(_args(2), AMOUNT);
    uint256 usdcAmount = (SWAPPED * USDC_RATE) / 1e18;

    assertEq(threePool.lastJ(), 1);
    assertEq(threePool.lastDx(), SWAPPED);
    assertEq(threePool.lastMinDy(), STABLE_MIN_OUT);
    assertEq(router.lastCommands(), abi.encodePacked(uint8(0x00), uint8(0x0c)));
    assertEq(router.inputCount(), 2);
    (address v3Recipient, uint256 amountIn, uint256 minOut, bytes memory path, bool payerIsUser) =
      abi.decode(router.inputAt(0), (address, uint256, uint256, bytes, bool));
    assertEq(v3Recipient, address(2));
    assertEq(amountIn, usdcAmount);
    assertEq(minOut, ETH_MIN_OUT);
    assertEq(path, abi.encodePacked(address(usdc), uint24(500), weth));
    assertFalse(payerIsUser);
    assertEq(usdc.balanceOf(address(router)), usdcAmount);

    (address unwrapRecipient, uint256 unwrapMin) = abi.decode(router.inputAt(1), (address, uint256));
    assertEq(unwrapRecipient, alice);
    assertEq(unwrapMin, ETH_MIN_OUT);
    assertEq(alice.balance, (usdcAmount * WETH_RATE) / 1e18);
    assertEq(alice.balance, _ethOut(SWAPPED));
  }

  function test_OutputTokenAlreadyAtEscrowGoesToRecipient() external {
    SwapEscrow.Args memory args = _args(0);
    address escrow = factory.predictEscrowAddress(args);
    usdc.mint(escrow, 7e18);

    _fundAndDeploy(args, AMOUNT);

    assertEq(usdc.balanceOf(alice), (SWAPPED * USDC_RATE) / 1e18 + 7e18);
    assertEq(usdc.balanceOf(escrow), 0);
  }

  function test_StableOutputExactlyAtMinOutSwaps() external {
    threePool.setRate(address(usdc), STABLE_MIN_OUT_RATE);
    _fundAndDeploy(_args(0), AMOUNT);

    assertEq(usdc.balanceOf(alice), STABLE_MIN_OUT);
    assertEq(dai.balanceOf(relayer), TIP);
  }

  function test_StableOutputOneUnitBelowMinOutReverts() external {
    threePool.setRate(address(usdc), STABLE_MIN_OUT_RATE - 1);
    SwapEscrow.Args memory args = _args(0);
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);

    vm.prank(relayer);
    vm.expectRevert("Exchange resulted in fewer coins than expected");
    factory.deployAndExecute(args);
  }

  function test_StableMinOutMissRevertsAndLeavesFundsInPlace() external {
    threePool.setRate(address(usdc), 5e5);
    SwapEscrow.Args memory args = _args(0);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert("Exchange resulted in fewer coins than expected");
    factory.deployAndExecute(args);

    assertEq(escrow.code.length, 0);
    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(dai.balanceOf(relayer), 0);
    assertEq(usdc.balanceOf(alice), 0);
  }

  function test_UsdtMinOutMissReverts() external {
    threePool.setRate(address(usdt), 5e5);
    SwapEscrow.Args memory args = _args(1);
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);

    vm.prank(relayer);
    vm.expectRevert("Exchange resulted in fewer coins than expected");
    factory.deployAndExecute(args);
  }

  function test_EthMinOutMissRevertsAndLeavesFundsInPlace() external {
    router.setRate(weth, 3e14);
    SwapEscrow.Args memory args = _args(2);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert("MockUniversalRouter: too little received");
    factory.deployAndExecute(args);

    assertEq(escrow.code.length, 0);
    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(alice.balance, 0);
  }

  function test_EthMinOutTracksFeedAnswer() external {
    ethUsdFeed.setAnswer(5000e8);
    _fundAndDeploy(_args(2), AMOUNT);

    (,, uint256 minOut,,) = abi.decode(router.inputAt(0), (address, uint256, uint256, bytes, bool));
    assertEq(minOut, ETH_MIN_OUT / 2);
  }

  function test_EthRouteAcceptsAnswerExactlyAtMaxAge() external {
    vm.warp(10 days);
    ethUsdFeed.setUpdatedAt(block.timestamp - implementation.MAX_PRICE_AGE());
    _fundAndDeploy(_args(2), AMOUNT);

    assertEq(alice.balance, _ethOut(SWAPPED));
  }

  function test_EthRouteRevertsOnStaleFeed() external {
    vm.warp(10 days);
    uint256 updatedAt = block.timestamp - implementation.MAX_PRICE_AGE() - 1;
    ethUsdFeed.setUpdatedAt(updatedAt);
    SwapEscrow.Args memory args = _args(2);
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(abi.encodeWithSelector(Errors.EthUsdMinOut__StalePrice.selector, updatedAt));
    factory.deployAndExecute(args);
  }

  function test_EthRouteRevertsOnZeroAnswer() external {
    ethUsdFeed.setAnswer(0);
    SwapEscrow.Args memory args = _args(2);
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(abi.encodeWithSelector(Errors.EthUsdMinOut__InvalidPrice.selector, int256(0)));
    factory.deployAndExecute(args);
  }

  function test_EthRouteRevertsOnNegativeAnswer() external {
    ethUsdFeed.setAnswer(-1);
    SwapEscrow.Args memory args = _args(2);
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(abi.encodeWithSelector(Errors.EthUsdMinOut__InvalidPrice.selector, int256(-1)));
    factory.deployAndExecute(args);
  }

  function test_StableRoutesIgnoreTheFeed() external {
    ethUsdFeed.setAnswer(0);
    vm.warp(10 days);
    ethUsdFeed.setUpdatedAt(1);

    _fundAndDeploy(_args(0), AMOUNT);
    assertEq(usdc.balanceOf(alice), (SWAPPED * USDC_RATE) / 1e18);

    SwapEscrow.Args memory usdtArgs = _args(1);
    usdtArgs.nonce = keccak256("usdt-nonce");
    _fundAndDeploy(usdtArgs, AMOUNT);
    assertEq(usdt.balanceOf(alice), (SWAPPED * USDT_RATE) / 1e18);
  }

  function test_MinOutMissThenSignedRecoveryMovesFullBalance() external {
    threePool.setRate(address(usdc), 5e5);
    SwapEscrow.Args memory args = _args(0);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert("Exchange resulted in fewer coins than expected");
    factory.deployAndExecute(args);
    assertEq(escrow.code.length, 0);

    vm.prank(makeAddr("anyone"));
    assertEq(factory.deploy(args), escrow);
    assertGt(escrow.code.length, 0);

    bytes memory signature = _signRecoverERC20(escrow, target, address(dai), RECOVERY_NONCE, deadline);
    vm.expectEmit(true, true, true, true, escrow);
    emit EscrowBase.EscrowRecovered(address(dai), target, AMOUNT);
    vm.prank(makeAddr("anyone"));
    SwapEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(dai), RECOVERY_NONCE, deadline);

    assertEq(dai.balanceOf(target), AMOUNT);
    assertEq(dai.balanceOf(escrow), 0);
    assertTrue(SwapEscrow(escrow).usedNonces(RECOVERY_NONCE));
  }

  function _deployedEscrowWithDai(uint256 _daiBalance) internal returns (address escrow) {
    escrow = factory.deploy(_args(0));
    if (_daiBalance > 0) {
      dai.mint(escrow, _daiBalance);
    }
  }

  function test_UnknownRouteReverts() external {
    SwapEscrow.Args memory args = _args(3);
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(SwapEscrow.SwapEscrow__UnknownRoute.selector, 3));
    factory.deployAndExecute(args);
  }

  function test_BalanceExactlyTipDeployIsNoOp() external {
    SwapEscrow.Args memory args = _args(0);
    address escrow = _fundAndDeploy(args, TIP);

    assertEq(escrow, factory.predictEscrowAddress(args));
    assertEq(escrow.code.length, 0);
    assertEq(threePool.callCount(), 0);
    assertEq(router.callCount(), 0);
    assertEq(dai.balanceOf(relayer), 0);
    assertEq(dai.balanceOf(escrow), TIP);
    assertEq(usdc.balanceOf(alice), 0);
  }

  function test_BalanceOneWeiAboveTipSwapsAndPaysTip() external {
    address escrow = _fundAndDeploy(_args(0), TIP + 1);

    assertGt(escrow.code.length, 0);
    assertEq(threePool.callCount(), 1);
    assertEq(threePool.lastDx(), 1);
    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(dai.balanceOf(escrow), 0);
    assertEq(usdc.balanceOf(alice), 0);
  }

  function test_EthRouteToNonPayableRecipientReverts() external {
    SwapEscrow.Args memory args = _args(2);
    args.recipient = address(new NonPayableRecipient());
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);

    vm.expectRevert("MockUniversalRouter: ETH send failed");
    factory.deployAndExecute(args);
  }
}
