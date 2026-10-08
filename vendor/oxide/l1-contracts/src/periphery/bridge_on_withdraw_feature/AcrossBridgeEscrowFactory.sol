// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowFactoryBase} from "@periphery/EscrowFactoryBase.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {IAcrossSpokePool} from "@periphery/interfaces/IAcrossSpokePool.sol";
import {AcrossBridgeEscrow} from "./AcrossBridgeEscrow.sol";

contract AcrossBridgeEscrowFactory is EscrowFactoryBase {
  constructor(IERC20 _dai, address _usdc, address _usdt, ICurve3Pool _threePool, IAcrossSpokePool _spokePool)
    EscrowFactoryBase(_dai, address(new AcrossBridgeEscrow(_dai, _usdc, _usdt, _threePool, _spokePool)))
  {}

  function deployAndExecute(AcrossBridgeEscrow.Args calldata _args) external returns (address escrow) {
    return _deployAndExecute(abi.encode(_args), _args.relayerTip);
  }

  function deploy(AcrossBridgeEscrow.Args calldata _args) external returns (address escrow) {
    return _deploy(abi.encode(_args));
  }

  function predictEscrowAddress(AcrossBridgeEscrow.Args calldata _args) external view returns (address) {
    return _predictEscrowAddress(abi.encode(_args));
  }
}
