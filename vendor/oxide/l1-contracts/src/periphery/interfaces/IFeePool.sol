// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFeePool {
  struct SpenderConfig {
    address spender;
    uint64 idleTimeout;
    uint192 reserve;
    uint64 activeUntil;
    uint192 amountPerPeriod;
    uint64 period;
  }

  struct Spender {
    SpenderConfig config;
    uint192 rateCapLeft;
    uint64 lastPulledAt;
    uint256 protectedReserves;
  }

  event Appended(address indexed spender, SpenderConfig config, uint64 idleFrom);

  event Pulled(address indexed spender, uint256 amount);

  event Renounced(address indexed spender);

  event Released(address indexed spender);

  function TOKEN() external view returns (IERC20);

  function append(SpenderConfig calldata _config, uint64 _idleDelay) external;

  function pull(uint256 _amount) external returns (uint256 amount);

  function renounce() external;

  function release(address _spender) external;

  function available(address _spender) external view returns (uint256);

  function spenders() external view returns (Spender[] memory);

  function balance() external view returns (uint256);
}
