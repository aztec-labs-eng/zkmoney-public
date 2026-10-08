// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IERC20 as EscrowToken} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowFactoryBase} from "@periphery/EscrowFactoryBase.sol";
import {SkyRoute, SKY_ROUTE_UNSTAKE} from "@periphery/experiments/sky/SkyTypes.sol";
import {SkyEscrow} from "@periphery/experiments/sky/SkyEscrow.sol";
import {SkyWithdrawalExecutor} from "@periphery/experiments/sky/SkyWithdrawalExecutor.sol";

contract SkyEscrowFactory is EscrowFactoryBase {
  IERC20 public immutable SUSDS;
  IOxidePortal public immutable DAI_PORTAL;
  IOxidePortal public immutable SUSDS_PORTAL;
  SkyWithdrawalExecutor public immutable SKY_EXECUTOR;

  constructor(
    SkyRoute memory _route,
    IOxidePortal _daiPortal,
    IOxidePortal _sUsdsPortal,
    SkyWithdrawalExecutor _skyExecutor
  )
    EscrowFactoryBase(
      EscrowToken(address(_route.dai)), address(new SkyEscrow(_route, _daiPortal, _sUsdsPortal, _skyExecutor))
    )
  {
    SUSDS = IERC20(address(_route.sUsds));
    DAI_PORTAL = _daiPortal;
    SUSDS_PORTAL = _sUsdsPortal;
    SKY_EXECUTOR = _skyExecutor;
  }

  function deployAndExecute(SkyEscrow.Args calldata _args) external returns (address escrow) {
    bytes memory encodedArgs = abi.encode(_args);
    escrow = _predictEscrowAddress(encodedArgs);
    if (!_holdsSomethingToMove(_args, escrow)) {
      return escrow;
    }

    _deploy(encodedArgs);
    SkyEscrow(escrow).execute(msg.sender);
    emit EscrowExecuted(escrow, msg.sender);
  }

  function deploy(SkyEscrow.Args calldata _args) external returns (address escrow) {
    return _deploy(abi.encode(_args));
  }

  function predictEscrowAddress(SkyEscrow.Args calldata _args) external view returns (address) {
    return _predictEscrowAddress(abi.encode(_args));
  }

  function _holdsSomethingToMove(SkyEscrow.Args calldata _args, address _escrow) private view returns (bool) {
    if (DAI.balanceOf(_escrow) > _args.relayerTip) {
      return true;
    }
    // solhint-disable oxide/no-comments
    // An unstake escrow may hold sUSDS and no DAI, when its user settled the withdrawal in shares.
    // `SkyEscrow.execute` converts that sUSDS to DAI first, so the escrow must still be executed.
    // solhint-enable oxide/no-comments
    return _args.route == SKY_ROUTE_UNSTAKE && SUSDS.balanceOf(_escrow) > 0;
  }
}
