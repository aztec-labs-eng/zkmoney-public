// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CCTPBridgeEscrowFactory} from "@periphery/bridge_on_withdraw_feature/CCTPBridgeEscrowFactory.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {ITokenMessengerV2} from "@periphery/interfaces/ITokenMessengerV2.sol";

contract DeployCCTPBridgeOnWithdraw is Script {
  IERC20 internal constant DAI = IERC20(0x6B175474E89094C44Da98b954EedeAC495271d0F);
  address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
  ICurve3Pool internal constant THREE_POOL = ICurve3Pool(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7);
  ITokenMessengerV2 internal constant TOKEN_MESSENGER = ITokenMessengerV2(0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d);
  address internal constant HYPEREVM_CCTP_FORWARDER = 0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757;

  function run() external returns (CCTPBridgeEscrowFactory factory) {
    vm.startBroadcast();
    factory = new CCTPBridgeEscrowFactory(DAI, USDC, THREE_POOL, TOKEN_MESSENGER, HYPEREVM_CCTP_FORWARDER);
    vm.stopBroadcast();

    console.log("CCTPBridgeEscrowFactory        ", address(factory));
    console.log("  CCTPBridgeEscrow implementation", factory.IMPLEMENTATION());
  }
}
