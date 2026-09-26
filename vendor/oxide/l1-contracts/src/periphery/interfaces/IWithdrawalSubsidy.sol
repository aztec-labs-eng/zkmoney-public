// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IExecutor} from "@core/interfaces/IExecutor.sol";

interface IWithdrawalSubsidy {
  function paySubsidy(IExecutor.Flow _flow, address _tipRecipient) external returns (uint256 subsidy);
}
