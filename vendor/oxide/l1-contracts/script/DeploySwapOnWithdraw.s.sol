// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {SwapEscrowFactory} from "@periphery/swap_on_withdraw_feature/SwapEscrowFactory.sol";

contract DeploySwapOnWithdraw is Script {
  IERC20 internal constant DAI = IERC20(0x6B175474E89094C44Da98b954EedeAC495271d0F);
  address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
  address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
  address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  IUniversalRouter internal constant UNISWAP_UNIVERSAL_ROUTER =
    IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
  ICurve3Pool internal constant THREE_POOL = ICurve3Pool(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7);
  AggregatorV3Interface internal constant ETH_USD_FEED =
    AggregatorV3Interface(0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419);

  function run() external returns (SwapEscrowFactory factory) {
    vm.startBroadcast();
    factory = new SwapEscrowFactory(DAI, USDC, USDT, WETH, UNISWAP_UNIVERSAL_ROUTER, THREE_POOL, ETH_USD_FEED);
    vm.stopBroadcast();

    console.log("SwapEscrowFactory        ", address(factory));
    console.log("  SwapEscrow implementation", factory.IMPLEMENTATION());
  }
}
