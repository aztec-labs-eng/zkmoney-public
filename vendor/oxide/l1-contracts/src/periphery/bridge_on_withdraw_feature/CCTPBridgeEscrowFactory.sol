// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowFactoryBase} from "@periphery/EscrowFactoryBase.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {ITokenMessengerV2} from "@periphery/interfaces/ITokenMessengerV2.sol";
import {CCTPBridgeEscrow} from "./CCTPBridgeEscrow.sol";

contract CCTPBridgeEscrowFactory is EscrowFactoryBase {
  constructor(
    IERC20 _dai,
    address _usdc,
    ICurve3Pool _threePool,
    ITokenMessengerV2 _tokenMessenger,
    address _hyperEvmCctpForwarder
  )
    EscrowFactoryBase(
      _dai, address(new CCTPBridgeEscrow(_dai, _usdc, _threePool, _tokenMessenger, _hyperEvmCctpForwarder))
    )
  {}

  function deployAndExecute(CCTPBridgeEscrow.Args calldata _args) external returns (address escrow) {
    return _deployAndExecute(abi.encode(_args), _args.relayerTip);
  }

  function deploy(CCTPBridgeEscrow.Args calldata _args) external returns (address escrow) {
    return _deploy(abi.encode(_args));
  }

  function predictEscrowAddress(CCTPBridgeEscrow.Args calldata _args) external view returns (address) {
    return _predictEscrowAddress(abi.encode(_args));
  }
}
