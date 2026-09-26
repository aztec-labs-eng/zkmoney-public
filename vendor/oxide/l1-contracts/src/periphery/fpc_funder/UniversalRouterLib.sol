// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Aztec Labs.
pragma solidity >=0.8.27;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

library UniversalRouterLib {
  function v3SwapExactInInput(address _recipient, uint256 _amountIn, uint256 _amountOutMinimum, bytes memory _path)
    internal
    pure
    returns (bytes memory)
  {
    return abi.encode(_recipient, _amountIn, _amountOutMinimum, _path, false);
  }

  function unwrapWethInput(address _recipient, uint256 _amountMinimum) internal pure returns (bytes memory) {
    return abi.encode(_recipient, _amountMinimum);
  }

  function v4SwapAllInput(
    address _currencyIn,
    address _currencyOut,
    uint128 _amountOutMinimum,
    uint24 _fee,
    int24 _tickSpacing,
    address _hooks
  ) internal pure returns (bytes memory) {
    bool zeroForOne = _currencyIn < _currencyOut;
    PoolKey memory poolKey = PoolKey({
      currency0: Currency.wrap(zeroForOne ? _currencyIn : _currencyOut),
      currency1: Currency.wrap(zeroForOne ? _currencyOut : _currencyIn),
      fee: _fee,
      tickSpacing: _tickSpacing,
      hooks: IHooks(_hooks)
    });

    bytes memory actions =
      abi.encodePacked(uint8(Actions.SETTLE), uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.TAKE_ALL));
    bytes[] memory params = new bytes[](3);
    params[0] = abi.encode(Currency.wrap(_currencyIn), ActionConstants.CONTRACT_BALANCE, false);
    params[1] = abi.encode(
      IV4Router.ExactInputSingleParams({
        poolKey: poolKey,
        zeroForOne: zeroForOne,
        amountIn: ActionConstants.OPEN_DELTA,
        amountOutMinimum: _amountOutMinimum,
        hookData: ""
      })
    );
    params[2] = abi.encode(Currency.wrap(_currencyOut), uint256(_amountOutMinimum));
    return abi.encode(actions, params);
  }
}
