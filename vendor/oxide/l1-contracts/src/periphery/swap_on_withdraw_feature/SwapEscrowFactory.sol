// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {EscrowFactoryBase} from "@periphery/EscrowFactoryBase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {SwapEscrow} from "./SwapEscrow.sol";

contract SwapEscrowFactory is EscrowFactoryBase {
  constructor(
    IERC20 _dai,
    address _usdc,
    address _usdt,
    address _weth,
    IUniversalRouter _router,
    ICurve3Pool _threePool,
    AggregatorV3Interface _ethUsdFeed
  ) EscrowFactoryBase(_dai, address(new SwapEscrow(_dai, _usdc, _usdt, _weth, _router, _threePool, _ethUsdFeed))) {}

  function deployAndExecute(SwapEscrow.Args calldata _args) external returns (address escrow) {
    return _deployAndExecute(abi.encode(_args), _args.relayerTip);
  }

  function deploy(SwapEscrow.Args calldata _args) external returns (address escrow) {
    return _deploy(abi.encode(_args));
  }

  function predictEscrowAddress(SwapEscrow.Args calldata _args) external view returns (address) {
    return _predictEscrowAddress(abi.encode(_args));
  }
}
