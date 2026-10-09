// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UniswapV2Library} from "@uniswap/universal-router/contracts/modules/uniswap/v2/UniswapV2Library.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {Errors} from "@periphery/Errors.sol";
import {SwapEscrow} from "@periphery/swap_on_withdraw_feature/SwapEscrow.sol";
import {SwapEscrowFactory} from "@periphery/swap_on_withdraw_feature/SwapEscrowFactory.sol";
import {NonPayableRecipient} from "@test/periphery/EscrowRecoveryTestBase.sol";
import {MockUniswapV2Pair} from "./MockUniswapV2Pair.sol";
import {SwapEscrowTestBase} from "./SwapEscrowTestBase.sol";

contract ReenteringRecipient {
  SwapEscrowFactory internal immutable FACTORY;
  SwapEscrow.Args internal $args;
  uint256 public reentries;

  constructor(SwapEscrowFactory _factory) {
    FACTORY = _factory;
  }

  function setArgs(SwapEscrow.Args calldata _args) external {
    $args = _args;
  }

  receive() external payable {
    reentries++;
    FACTORY.deployAndExecute($args);
  }
}

contract SwapEscrowTest is SwapEscrowTestBase {
  uint256 internal constant SWAPPED = AMOUNT - TIP;
  uint256 internal constant GAS_DAI = 20e18;
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
    assertEq(pair.callCount(), 0);
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
    SwapEscrow(payable(escrow))
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(dai), RECOVERY_NONCE, deadline);

    assertEq(dai.balanceOf(target), AMOUNT);
    assertEq(dai.balanceOf(escrow), 0);
    assertTrue(SwapEscrow(payable(escrow)).usedNonces(RECOVERY_NONCE));
  }

  function _deployedEscrowWithDai(uint256 _daiBalance) internal returns (address escrow) {
    escrow = factory.deploy(_args(0));
    if (_daiBalance > 0) {
      dai.mint(escrow, _daiBalance);
    }
  }

  function test_UnknownRouteReverts() external {
    SwapEscrow.Args memory args = _args(4);
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(SwapEscrow.SwapEscrow__UnknownRoute.selector, 4));
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

  function test_DaiForGasSwapsOnThePairAndPaysEthWithTheRoute() external {
    address escrow = _fundAndDeploy(_gasArgs(0, GAS_DAI), AMOUNT);

    assertEq(pair.callCount(), 1);
    assertEq(dai.balanceOf(address(pair)), PAIR_DAI_RESERVE + GAS_DAI);
    assertEq(alice.balance, _pairEthOut(GAS_DAI));
    assertEq(threePool.lastDx(), SWAPPED - GAS_DAI);
    assertEq(usdc.balanceOf(alice), ((SWAPPED - GAS_DAI) * USDC_RATE) / 1e18);
    assertEq(dai.balanceOf(relayer), TIP);
    _assertNothingSticks(escrow);
  }

  function test_DaiForGasOnTheEthRouteReverts() external {
    _assertExecuteRevertsAndKeepsFunds(
      _gasArgs(2, GAS_DAI), AMOUNT, abi.encodeWithSelector(SwapEscrow.SwapEscrow__DaiForGasOnEthRoute.selector)
    );
  }

  function test_DaiRoutePaysTheRestInDai() external {
    address escrow = _fundAndDeploy(_args(3), AMOUNT);

    assertEq(dai.balanceOf(alice), SWAPPED);
    assertEq(threePool.callCount(), 0);
    assertEq(router.callCount(), 0);
    assertEq(pair.callCount(), 0);
    assertEq(alice.balance, 0);
    assertEq(dai.balanceOf(relayer), TIP);
    _assertNothingSticks(escrow);
  }

  function test_DaiRouteWithDaiForGasPaysEthAndTheRestInDai() external {
    address escrow = _fundAndDeploy(_gasArgs(3, GAS_DAI), AMOUNT);

    assertEq(alice.balance, _pairEthOut(GAS_DAI));
    assertEq(dai.balanceOf(alice), SWAPPED - GAS_DAI);
    assertEq(dai.balanceOf(relayer), TIP);
    _assertNothingSticks(escrow);
  }

  function test_DaiForGasAtTheCapSwapsTheCap() external {
    uint256 cap = implementation.MAX_DAI_FOR_GAS();
    assertEq(cap, 50e18);

    address escrow = _fundAndDeploy(_gasArgs(3, cap), AMOUNT);

    assertEq(dai.balanceOf(address(pair)), PAIR_DAI_RESERVE + cap);
    assertEq(alice.balance, _pairEthOut(cap));
    assertEq(dai.balanceOf(alice), SWAPPED - cap);
    _assertNothingSticks(escrow);
  }

  function test_DaiForGasAboveTheCapReverts() external {
    uint256 daiForGas = implementation.MAX_DAI_FOR_GAS() + 1;

    _assertExecuteRevertsAndKeepsFunds(
      _gasArgs(3, daiForGas),
      AMOUNT,
      abi.encodeWithSelector(SwapEscrow.SwapEscrow__DaiForGasExceedsMax.selector, daiForGas)
    );
  }

  function test_DaiForGasEqualToTheBalanceAfterTipSkipsTheRoute() external {
    address escrow = _fundAndDeploy(_gasArgs(0, GAS_DAI), TIP + GAS_DAI);

    assertEq(alice.balance, _pairEthOut(GAS_DAI));
    assertEq(threePool.callCount(), 0);
    assertEq(usdc.balanceOf(alice), 0);
    assertEq(dai.balanceOf(relayer), TIP);
    _assertNothingSticks(escrow);
  }

  function test_DaiForGasAboveTheBalanceAfterTipReverts() external {
    _assertExecuteRevertsAndKeepsFunds(
      _gasArgs(0, GAS_DAI),
      TIP + GAS_DAI - 1,
      abi.encodeWithSelector(SwapEscrow.SwapEscrow__DaiForGasExceedsBalanceAfterTip.selector, GAS_DAI, GAS_DAI - 1)
    );
  }

  function test_DaiForGasThatPaysExactlyMinEthForGasSwaps() external {
    SwapEscrow.Args memory args = _gasArgs(3, GAS_DAI);
    args.minEthForGas = _pairEthOut(GAS_DAI);

    address escrow = _fundAndDeploy(args, AMOUNT);

    assertEq(alice.balance, _pairEthOut(GAS_DAI));
    assertEq(dai.balanceOf(alice), SWAPPED - GAS_DAI);
    _assertNothingSticks(escrow);
  }

  function test_DaiForGasThatPaysLessThanMinEthForGasReverts() external {
    SwapEscrow.Args memory args = _gasArgs(3, GAS_DAI);
    args.minEthForGas = _pairEthOut(GAS_DAI) + 1;

    _assertExecuteRevertsAndKeepsFunds(
      args,
      AMOUNT,
      abi.encodeWithSelector(
        SwapEscrow.SwapEscrow__EthForGasBelowMin.selector, _pairEthOut(GAS_DAI), _pairEthOut(GAS_DAI) + 1
      )
    );
  }

  function test_DustDaiForGasIsLeftToTheRoute() external {
    assertEq(_pairEthOut(1), 0);

    address escrow = _fundAndDeploy(_gasArgs(3, 1), AMOUNT);

    assertEq(pair.callCount(), 0);
    assertEq(alice.balance, 0);
    assertEq(dai.balanceOf(alice), SWAPPED);
    _assertNothingSticks(escrow);
  }

  function test_DaiForGasRevertsWhenThePairHasNoLiquidity() external {
    MockUniswapV2Pair emptyPair = new MockUniswapV2Pair(address(dai), weth);
    factory = _deployFactory(weth, emptyPair);

    _assertExecuteRevertsAndKeepsFunds(
      _gasArgs(3, GAS_DAI), AMOUNT, abi.encodeWithSelector(UniswapV2Library.InvalidReserves.selector)
    );
  }

  function test_DaiForGasWorksWhenWethIsToken0() external {
    address lowWeth = _deployWethAt(address(0x1000));
    assertLt(uint160(lowWeth), uint160(address(dai)));
    MockUniswapV2Pair lowPair = _deployFundedPair(lowWeth);
    factory = _deployFactory(lowWeth, lowPair);

    address escrow = _fundAndDeploy(_gasArgs(3, GAS_DAI), AMOUNT);

    assertEq(lowPair.token0(), lowWeth);
    assertEq(lowPair.callCount(), 1);
    assertEq(alice.balance, _pairEthOut(GAS_DAI));
    assertEq(dai.balanceOf(alice), SWAPPED - GAS_DAI);
    assertEq(IERC20(lowWeth).balanceOf(escrow), 0);
    _assertNothingSticks(escrow);
  }

  function test_DaiForGasToNonPayableRecipientReverts() external {
    SwapEscrow.Args memory args = _gasArgs(3, GAS_DAI);
    args.recipient = address(new NonPayableRecipient());
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(EscrowBase.EscrowBase__EthTransferFailed.selector);
    factory.deployAndExecute(args);

    assertEq(escrow.code.length, 0);
    assertEq(dai.balanceOf(escrow), AMOUNT);
  }

  function test_RecipientThatReentersOnEthCannotExecuteTwice() external {
    ReenteringRecipient reentrant = new ReenteringRecipient(factory);
    SwapEscrow.Args memory args = _gasArgs(3, GAS_DAI);
    args.recipient = address(reentrant);
    reentrant.setArgs(args);

    address escrow = _fundAndDeploy(args, AMOUNT);

    assertEq(reentrant.reentries(), 1);
    assertEq(pair.callCount(), 1);
    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(dai.balanceOf(address(reentrant)), SWAPPED - GAS_DAI);
    assertEq(address(reentrant).balance, _pairEthOut(GAS_DAI));
    _assertNothingSticks(escrow);
  }

  function test_EscrowAcceptsEthOnlyFromWeth() external {
    address payable escrow = payable(factory.deploy(_args(0)));

    (bool success, bytes memory reason) = escrow.call{value: 1 ether}("");

    assertFalse(success);
    assertEq(reason, abi.encodeWithSelector(SwapEscrow.SwapEscrow__EthNotFromWeth.selector));
    assertEq(escrow.balance, 0);
  }

  function _assertExecuteRevertsAndKeepsFunds(
    SwapEscrow.Args memory _escrowArgs,
    uint256 _funding,
    bytes memory _revertData
  ) internal {
    address escrow = factory.predictEscrowAddress(_escrowArgs);
    dai.mint(escrow, _funding);

    vm.prank(relayer);
    vm.expectRevert(_revertData);
    factory.deployAndExecute(_escrowArgs);

    assertEq(escrow.code.length, 0);
    assertEq(dai.balanceOf(escrow), _funding);
  }

  function _assertNothingSticks(address _escrow) internal view {
    assertEq(dai.balanceOf(_escrow), 0);
    assertEq(usdc.balanceOf(_escrow), 0);
    assertEq(usdt.balanceOf(_escrow), 0);
    assertEq(IERC20(weth).balanceOf(_escrow), 0);
    assertEq(_escrow.balance, 0);
  }
}
