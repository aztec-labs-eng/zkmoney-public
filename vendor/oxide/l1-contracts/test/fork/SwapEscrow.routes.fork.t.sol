// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20 as OzIERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";

import {DAI, USDC, USDT} from "@periphery/ThreePoolLib.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {SwapEscrow} from "@periphery/swap_on_withdraw_feature/SwapEscrow.sol";
import {SwapEscrowFactory} from "@periphery/swap_on_withdraw_feature/SwapEscrowFactory.sol";

import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";

contract SwapEscrowRoutesForkTest is MainnetForkFixture {
  address internal constant UNIVERSAL_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
  address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  ICurve3Pool internal constant THREE_POOL = ICurve3Pool(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7);
  AggregatorV3Interface internal constant ETH_USD_FEED =
    AggregatorV3Interface(0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419);

  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 5e18;
  uint256 internal constant SWAPPED = AMOUNT - TIP;

  uint256 internal constant ETH_OUT_BAND_LOW = 1.308e18;
  uint256 internal constant ETH_OUT_BAND_HIGH = 1.348e18;

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
      ETH_USD_FEED
    );
  }

  function test_GivenUsdcRoute_WhenDeployed_ThenNearParityUsdcToRecipient() external {
    address escrow = _fundAndDeploy(0);

    uint256 usdcOut = USDC.balanceOf(recipient);
    assertGt(usdcOut, 2482e6);
    assertLt(usdcOut, 2508e6);
    assertGe(usdcOut, _stableMinOut());
    _assertTipPaidAndNothingSticks(escrow);
  }

  function test_GivenUsdtRoute_WhenDeployed_ThenNearParityUsdtToRecipient() external {
    address escrow = _fundAndDeploy(1);

    uint256 usdtOut = USDT.balanceOf(recipient);
    assertGt(usdtOut, 2470e6);
    assertLt(usdtOut, 2520e6);
    assertGe(usdtOut, _stableMinOut());
    _assertTipPaidAndNothingSticks(escrow);
  }

  function test_GivenEthRoute_WhenDeployed_ThenSpotConsistentEthToRecipient() external {
    address escrow = _fundAndDeploy(2);

    assertGt(recipient.balance, ETH_OUT_BAND_LOW);
    assertLt(recipient.balance, ETH_OUT_BAND_HIGH);
    assertGe(recipient.balance, _ethMinOut());
    _assertTipPaidAndNothingSticks(escrow);
  }

  function _fundAndDeploy(uint8 _route) internal returns (address escrow) {
    SwapEscrow.Args memory args = SwapEscrow.Args({
      route: _route,
      recipient: recipient,
      recoveryCommitment: keccak256("recovery"),
      relayerTip: TIP,
      nonce: keccak256("fork-nonce")
    });
    escrow = factory.predictEscrowAddress(args);
    deal(address(DAI), escrow, AMOUNT);

    vm.prank(relayer);
    factory.deployAndExecute(args);
  }

  function _stableMinOut() internal view returns (uint256) {
    SwapEscrow escrow = SwapEscrow(factory.IMPLEMENTATION());
    return (SWAPPED * (escrow.BPS_DENOMINATOR() - escrow.STABLE_MAX_SLIPPAGE_BPS())) / escrow.BPS_DENOMINATOR() / 1e12;
  }

  function _ethMinOut() internal view returns (uint256) {
    SwapEscrow escrow = SwapEscrow(factory.IMPLEMENTATION());
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
    assertEq(DAI.balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(OzIERC20(WETH).balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(UNIVERSAL_ROUTER.balance, 0);
  }
}
