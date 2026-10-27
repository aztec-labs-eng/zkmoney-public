// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {Errors} from "@periphery/Errors.sol";

abstract contract FeeChargingExecutorBase is IExecutor {
  using SafeERC20 for IERC20;

  address public immutable PORTAL;
  IERC20 public immutable ASSET;
  // solhint-disable-next-line oxide/no-comments
  /**
   * @notice The protocol fee, in `ASSET`, that the executor takes from each withdrawal. It funds the protocol, for
   * example the FPC and the subsidies.
   */
  uint256 public immutable FEE;
  // solhint-disable-next-line oxide/no-comments
  /// @notice The contract that receives the fee, for example the FPC funder or a fee pool that splits it.
  address public immutable BENEFICIARY;

  constructor(address _portal, uint256 _fee, address _beneficiary) {
    require(_portal.code.length > 0, Errors.FeeChargingExecutorBase__InvalidPortal());
    require(_fee == 0 || _beneficiary != address(0), Errors.FeeChargingExecutorBase__ZeroBeneficiary());
    PORTAL = _portal;
    ASSET = IOxidePortal(_portal).UNDERLYING();
    FEE = _fee;
    BENEFICIARY = _beneficiary;
  }

  function execute(IExecutor.Flow _flow, uint256 _amount, bytes calldata _userPayload, bytes calldata _relayerPayload)
    external
  {
    require(msg.sender == PORTAL, Errors.FeeChargingExecutorBase__UnauthorizedCaller());
    if (_flow == IExecutor.Flow.Withdrawal) {
      require(_amount > FEE, Errors.FeeChargingExecutorBase__AmountNotAboveFee());
      if (FEE > 0) {
        ASSET.safeTransfer(BENEFICIARY, FEE);
      }
      _execute(_flow, _amount - FEE, _userPayload, _relayerPayload);
    } else {
      _execute(_flow, _amount, _userPayload, _relayerPayload);
    }
  }

  function _execute(IExecutor.Flow _flow, uint256 _amount, bytes calldata _userPayload, bytes calldata _relayerPayload)
    internal
    virtual;
}
