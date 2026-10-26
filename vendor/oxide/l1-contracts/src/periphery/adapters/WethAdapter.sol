// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";

contract WethAdapter is CoreAdapter {
  IWETH9 public immutable WETH;

  constructor(IWETH9 _weth) {
    WETH = _weth;
  }

  function wrapEth(uint256 _amount, address _recipient) external {
    uint256 amount = _resolveEthAmount(_amount);
    WETH.deposit{value: amount}();
    _transferERC20(IERC20(address(WETH)), amount, _recipient);
  }

  function unwrapWeth(uint256 _amount, address _recipient) external {
    uint256 amount = _resolveERC20Amount(IERC20(address(WETH)), _amount);
    WETH.withdraw(amount);
    _transferEth(amount, _recipient);
  }
}
