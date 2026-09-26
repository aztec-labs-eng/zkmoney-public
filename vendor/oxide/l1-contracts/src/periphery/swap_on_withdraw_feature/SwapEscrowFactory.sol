// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {SwapEscrow} from "./SwapEscrow.sol";

contract SwapEscrowFactory {
  IERC20 public immutable DAI;
  address public immutable IMPLEMENTATION;

  event SwapEscrowExecuted(address indexed escrow, address tipRecipient);

  constructor(
    IERC20 _dai,
    address _usdc,
    address _usdt,
    address _weth,
    IUniversalRouter _router,
    ICurve3Pool _threePool,
    AggregatorV3Interface _ethUsdFeed
  ) {
    DAI = _dai;
    IMPLEMENTATION = address(new SwapEscrow(_dai, _usdc, _usdt, _weth, _router, _threePool, _ethUsdFeed));
  }

  function deployAndExecute(SwapEscrow.Args calldata _args) external returns (address escrow) {
    escrow = predictEscrowAddress(_args);

    uint256 balance = DAI.balanceOf(escrow);
    if (balance <= _args.relayerTip) {
      return escrow;
    }

    deploy(_args);
    SwapEscrow(escrow).execute(msg.sender);
    emit SwapEscrowExecuted(escrow, msg.sender);
  }

  function deploy(SwapEscrow.Args calldata _args) public returns (address escrow) {
    escrow = predictEscrowAddress(_args);
    if (escrow.code.length == 0) {
      Clones.cloneDeterministicWithImmutableArgs(IMPLEMENTATION, abi.encode(_args), bytes32(0));
    }
  }

  function predictEscrowAddress(SwapEscrow.Args calldata _args) public view returns (address) {
    return Clones.predictDeterministicAddressWithImmutableArgs(IMPLEMENTATION, abi.encode(_args), bytes32(0));
  }
}
