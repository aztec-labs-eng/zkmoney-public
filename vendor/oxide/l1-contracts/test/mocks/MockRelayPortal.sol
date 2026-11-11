// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";

contract MockRelayPortal {
  IOxidePortal internal immutable TARGET;
  IOxidePortal.WithdrawArgs internal $relayed;

  constructor(IOxidePortal _target, IOxidePortal.WithdrawArgs memory _relayed) {
    TARGET = _target;
    $relayed = _relayed;
  }

  function withdraw(IOxidePortal.WithdrawArgs calldata) external {
    TARGET.withdraw($relayed);
  }

  function UNDERLYING() external view returns (IERC20) {
    return TARGET.UNDERLYING();
  }
}
