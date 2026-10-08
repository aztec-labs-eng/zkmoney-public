// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AcrossBridgeEscrowFactory} from "@periphery/bridge_on_withdraw_feature/AcrossBridgeEscrowFactory.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {IAcrossSpokePool} from "@periphery/interfaces/IAcrossSpokePool.sol";

contract DeployAcrossBridgeOnWithdraw is Script {
  IERC20 internal constant DAI = IERC20(0x6B175474E89094C44Da98b954EedeAC495271d0F);
  address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
  address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
  ICurve3Pool internal constant THREE_POOL = ICurve3Pool(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7);
  IAcrossSpokePool internal constant SPOKE_POOL = IAcrossSpokePool(0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5);

  function run() external returns (AcrossBridgeEscrowFactory factory) {
    vm.startBroadcast();
    factory = new AcrossBridgeEscrowFactory(DAI, USDC, USDT, THREE_POOL, SPOKE_POOL);
    vm.stopBroadcast();

    console.log("AcrossBridgeEscrowFactory        ", address(factory));
    console.log("  AcrossBridgeEscrow implementation", factory.IMPLEMENTATION());
  }
}
