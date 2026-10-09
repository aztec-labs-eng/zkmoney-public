// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20 as OzIERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";

import {DAI, USDC, USDT} from "@periphery/ThreePoolLib.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {IUniswapV2Pair} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import {SwapEscrow} from "@periphery/swap_on_withdraw_feature/SwapEscrow.sol";
import {SwapEscrowFactory} from "@periphery/swap_on_withdraw_feature/SwapEscrowFactory.sol";

import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";

contract SwapEscrowRoutesForkTest is MainnetForkFixture {
  address internal constant UNIVERSAL_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
  address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  ICurve3Pool internal constant THREE_POOL = ICurve3Pool(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7);
  AggregatorV3Interface internal constant ETH_USD_FEED =
    AggregatorV3Interface(0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419);
  IUniswapV2Pair internal constant DAI_WETH_PAIR = IUniswapV2Pair(0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11);

  uint8 internal constant ROUTE_USDC = 0;
  uint8 internal constant ROUTE_USDT = 1;
  uint8 internal constant ROUTE_ETH = 2;
  uint8 internal constant ROUTE_DAI = 3;

  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 5e18;
  uint256 internal constant SWAPPED = AMOUNT - TIP;
  uint256 internal constant DAI_FOR_GAS = 50e18;

  uint256 internal constant ETH_OUT_BAND_LOW = 1.308e18;
  uint256 internal constant ETH_OUT_BAND_HIGH = 1.348e18;

  uint256 internal constant GAS_LEG_GAS_CEILING = 110_000;

  SwapEscrowFactory internal factory;
  address internal relayer = makeAddr("relayer");
  address internal recipient = makeAddr("recipient");

  function setUp() public override {
    _selectMainnetFork();
    factory = new SwapEscrowFactory(
      OzIERC20(address(DAI)),
      address(USDC),
      address(USDT),
      WETH,
      IUniversalRouter(UNIVERSAL_ROUTER),
      THREE_POOL,
      ETH_USD_FEED,
      DAI_WETH_PAIR
    );
  }

  function test_GivenThePinnedPair_ThenItIsTheDaiWethPairWithDaiAsToken0() external view {
    assertEq(DAI_WETH_PAIR.token0(), address(DAI));
    assertEq(DAI_WETH_PAIR.token1(), WETH);
  }

  function test_GivenUsdcRoute_WhenDeployed_ThenNearParityUsdcToRecipient() external {
    address escrow = _fundAndDeploy(ROUTE_USDC, 0);

    uint256 usdcOut = USDC.balanceOf(recipient);
    assertGt(usdcOut, 2482e6);
    assertLt(usdcOut, 2508e6);
    assertGe(usdcOut, _stableMinOut(SWAPPED));
    _assertTipPaidAndNothingSticks(escrow);
  }

  function test_GivenUsdtRoute_WhenDeployed_ThenNearParityUsdtToRecipient() external {
    address escrow = _fundAndDeploy(ROUTE_USDT, 0);

    uint256 usdtOut = USDT.balanceOf(recipient);
    assertGt(usdtOut, 2470e6);
    assertLt(usdtOut, 2520e6);
    assertGe(usdtOut, _stableMinOut(SWAPPED));
    _assertTipPaidAndNothingSticks(escrow);
  }

  function test_GivenEthRoute_WhenDeployed_ThenSpotConsistentEthToRecipient() external {
    address escrow = _fundAndDeploy(ROUTE_ETH, 0);

    assertGt(recipient.balance, ETH_OUT_BAND_LOW);
    assertLt(recipient.balance, ETH_OUT_BAND_HIGH);
    assertGe(recipient.balance, _ethMinOut());
    _assertTipPaidAndNothingSticks(escrow);
  }

  function test_GivenUsdcRouteAndDaiForGas_WhenDeployed_ThenUsdcAndPairPricedEthToRecipient() external {
    uint256 expectedEthOut = _pairEthOut(DAI_FOR_GAS);

    address escrow = _fundAndDeploy(ROUTE_USDC, DAI_FOR_GAS);

    assertEq(recipient.balance, expectedEthOut);
    assertApproxEqRel(recipient.balance, _feedEthValue(DAI_FOR_GAS), 0.01e18);
    uint256 usdcOut = USDC.balanceOf(recipient);
    assertGt(usdcOut, 2432e6);
    assertLt(usdcOut, 2458e6);
    assertGe(usdcOut, _stableMinOut(SWAPPED - DAI_FOR_GAS));
    _assertTipPaidAndNothingSticks(escrow);
  }

  function test_GivenDaiRouteAndDaiForGas_WhenDeployed_ThenDaiAndPairPricedEthToRecipient() external {
    uint256 expectedEthOut = _pairEthOut(DAI_FOR_GAS);

    address escrow = _fundAndDeploy(ROUTE_DAI, DAI_FOR_GAS);

    assertEq(recipient.balance, expectedEthOut);
    assertApproxEqRel(recipient.balance, _feedEthValue(DAI_FOR_GAS), 0.01e18);
    assertEq(DAI.balanceOf(recipient), SWAPPED - DAI_FOR_GAS);
    _assertTipPaidAndNothingSticks(escrow);
  }

  function test_GivenUsdcRoute_WhenDaiForGasIsAdded_ThenTheGasLegStaysUnderItsCeiling() external {
    uint256 snapshot = vm.snapshotState();
    uint256 withoutGasLeg = _deployAndExecuteCost(ROUTE_USDC, 0);
    vm.revertToState(snapshot);
    uint256 withGasLeg = _deployAndExecuteCost(ROUTE_USDC, DAI_FOR_GAS);

    console2.log("deployAndExecute gas: usdc route", withoutGasLeg, "gas leg", withGasLeg - withoutGasLeg);
    assertLe(withGasLeg - withoutGasLeg, GAS_LEG_GAS_CEILING, "the gas leg costs more than its ceiling");
  }

  function _escrowArgs(uint8 _route, uint256 _daiForGas) internal view returns (SwapEscrow.Args memory) {
    return SwapEscrow.Args({
      route: _route,
      recipient: recipient,
      daiForGas: _daiForGas,
      minEthForGas: 0,
      recoveryCommitment: keccak256("recovery"),
      relayerTip: TIP,
      nonce: keccak256("fork-nonce")
    });
  }

  function _fundAndDeploy(uint8 _route, uint256 _daiForGas) internal returns (address escrow) {
    SwapEscrow.Args memory args = _escrowArgs(_route, _daiForGas);
    escrow = factory.predictEscrowAddress(args);
    deal(address(DAI), escrow, AMOUNT);

    vm.prank(relayer);
    factory.deployAndExecute(args);
  }

  function _deployAndExecuteCost(uint8 _route, uint256 _daiForGas) internal returns (uint256) {
    _fundAndDeploy(_route, _daiForGas);
    Vm.Gas memory g = vm.lastCallGas();
    uint256 burnt = uint256(g.gasTotalUsed);
    uint256 refund = uint256(int256(g.gasRefunded));
    return burnt - (refund < burnt / 5 ? refund : burnt / 5);
  }

  function _pairEthOut(uint256 _daiIn) internal view returns (uint256) {
    (uint256 daiReserve, uint256 wethReserve,) = DAI_WETH_PAIR.getReserves();
    uint256 amountInAfterFee = _daiIn * 997;
    return (amountInAfterFee * wethReserve) / (daiReserve * 1000 + amountInAfterFee);
  }

  function _feedEthValue(uint256 _daiIn) internal view returns (uint256) {
    (, int256 answer,,,) = ETH_USD_FEED.latestRoundData();
    return (_daiIn * 10 ** ETH_USD_FEED.decimals()) / uint256(answer);
  }

  function _stableMinOut(uint256 _daiIn) internal view returns (uint256) {
    SwapEscrow escrow = SwapEscrow(payable(factory.IMPLEMENTATION()));
    return (_daiIn * (escrow.BPS_DENOMINATOR() - escrow.STABLE_MAX_SLIPPAGE_BPS())) / escrow.BPS_DENOMINATOR() / 1e12;
  }

  function _ethMinOut() internal view returns (uint256) {
    SwapEscrow escrow = SwapEscrow(payable(factory.IMPLEMENTATION()));
    (, int256 answer,, uint256 updatedAt,) = ETH_USD_FEED.latestRoundData();
    assertGt(answer, 0);
    assertLe(block.timestamp - updatedAt, escrow.MAX_PRICE_AGE());
    return (SWAPPED * 10 ** ETH_USD_FEED.decimals() * (escrow.BPS_DENOMINATOR() - escrow.ETH_MAX_SLIPPAGE_BPS()))
      / (uint256(answer) * escrow.BPS_DENOMINATOR());
  }

  function _assertTipPaidAndNothingSticks(address _escrow) internal view {
    assertEq(DAI.balanceOf(relayer), TIP);
    assertEq(DAI.balanceOf(_escrow), 0);
    assertEq(USDC.balanceOf(_escrow), 0);
    assertEq(USDT.balanceOf(_escrow), 0);
    assertEq(OzIERC20(WETH).balanceOf(_escrow), 0);
    assertEq(_escrow.balance, 0);
    assertEq(DAI.balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(OzIERC20(WETH).balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(UNIVERSAL_ROUTER.balance, 0);
  }
}
